package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// A plugin that owns a whole ceremony provides a session kind.
//
// The durable half is a session_kinds row: the foreign key sessions.kind points
// at it, so a room outlives the install that offered its kind and history stays
// resolvable. The row carries the org of the install that wrote it, so one
// org's ceremony is not on offer to every org on the instance.
//
// The live half is a session.Kind registered into the router's registry while
// the install is enabled, and unregistered when it is disabled or uninstalled.
// The kind's behaviour is entirely the plugin's: its state payload and each of
// its actions is a call into the guest, contained by every guard the host
// already applies to a call.

// Guest exports a ceremony plugin answers. They follow on_event and on_job:
// the host calls, the guest answers, and nothing about the call is trusted.
const (
	// ExportSessionState builds the kind's client-safe state payload.
	ExportSessionState = "on_session_state"
	// ExportSessionAction handles one action of the kind.
	ExportSessionAction = "on_session_action"
)

// ActionDef is one entry in a plugin kind's dispatch table, as the manifest
// declares it. It is untrusted: the verb is screened by session.Registry,
// which refuses a GET or HEAD action because the cross-site guard exempts
// those verbs and an action is always a write.
type ActionDef struct {
	Name            string `json:"name"`
	Verb            string `json:"verb"`
	FacilitatorOnly bool   `json:"facilitatorOnly"`
}

// KindDef is one session kind a plugin provides.
type KindDef struct {
	Kind    string      `json:"kind"`
	Display string      `json:"display"`
	Actions []ActionDef `json:"actions"`
}

// ErrBadKindDef is a manifest declaring a ceremony the host will not accept.
// It is a refusal at install, which is the point: a name or a verb that only
// fails later shows up as a ceremony that installs, enables, and then cannot
// be used, which reads as a Parley bug rather than as a bad manifest.
var ErrBadKindDef = fmt.Errorf("that session kind declaration is not valid")

// kindNamePattern is what a kind or action name may be. It is the same shape a
// URL segment and a database key both want, and it is deliberately narrower
// than anything downstream needs: session_kinds.kind is a parameterised value
// and an action name is a map key, so this is not a defence against injection
// but against a manifest naming a ceremony nobody can type or read.
var kindNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`)

// actionVerbs is the closed set an action may answer. GET and HEAD are absent
// because the cross-site guard exempts them and every action is a write —
// session.Registry refuses those two as well, and this refuses everything else
// at the same time. The check is on the canonical upper-case form: a manifest
// writing "get" used to slip past a comparison against http.MethodGet and then
// never match the dispatcher's exact comparison either, leaving a dead action
// rather than an exposed one.
var actionVerbs = map[string]bool{
	http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true,
}

// canonicalKinds screens and normalises what a manifest declares, returning a
// copy. The install path calls it before the transaction opens, so a refused
// manifest writes nothing at all.
func canonicalKinds(defs []KindDef) ([]KindDef, error) {
	out := make([]KindDef, 0, len(defs))
	seen := map[string]bool{}
	for _, def := range defs {
		if !kindNamePattern.MatchString(def.Kind) {
			return nil, fmt.Errorf("%w: the kind name %q must be 1-64 characters of a-z, 0-9 and dashes", ErrBadKindDef, def.Kind)
		}
		if seen[def.Kind] {
			return nil, fmt.Errorf("%w: the kind %q is declared twice", ErrBadKindDef, def.Kind)
		}
		seen[def.Kind] = true
		if n := len(def.Display); n == 0 || n > 64 {
			return nil, fmt.Errorf("%w: the display name of %q must be 1-64 characters", ErrBadKindDef, def.Kind)
		}
		actions := make([]ActionDef, 0, len(def.Actions))
		names := map[string]bool{}
		for _, a := range def.Actions {
			if !kindNamePattern.MatchString(a.Name) {
				return nil, fmt.Errorf("%w: the action name %q of %q must be 1-64 characters of a-z, 0-9 and dashes", ErrBadKindDef, a.Name, def.Kind)
			}
			if names[a.Name] {
				return nil, fmt.Errorf("%w: %q declares the action %q twice", ErrBadKindDef, def.Kind, a.Name)
			}
			names[a.Name] = true
			a.Verb = strings.ToUpper(a.Verb)
			if !actionVerbs[a.Verb] {
				return nil, fmt.Errorf("%w: the action %q of %q answers %q, and an action may only answer POST, PUT, PATCH or DELETE", ErrBadKindDef, a.Name, def.Kind, a.Verb)
			}
			actions = append(actions, a)
		}
		def.Actions = actions
		out = append(out, def)
	}
	return out, nil
}

// KindRegistry is the router's session-kind registry, as the host uses it. It
// is an interface so this package does not need the router, and so a test can
// watch what was registered without one.
type KindRegistry interface {
	Register(k session.Kind) error
	Unregister(name string) error
}

// seedKinds writes the session_kinds rows for an install, inside the install's
// own transaction: a plugin is never recorded as installed without the kinds it
// said it provides.
//
// A kind name is the primary key and so is instance-wide, because sessions.kind
// references it. A conflicting row is therefore either this org reinstalling a
// plugin it uninstalled — the row survives a retirement, and reinstalling
// un-retires it — or another org's kind of the same name, which is refused. An
// install cannot take over a kind it does not own.
func seedKinds(ctx context.Context, tx pgx.Tx, orgID, provider string, kinds []KindDef) error {
	for _, k := range kinds {
		actions, err := json.Marshal(k.Actions)
		if err != nil {
			return fmt.Errorf("recording the actions of %q: %w", k.Kind, err)
		}
		tag, err := tx.Exec(ctx, `
			insert into session_kinds (kind, provider, display, org_id, actions)
			values ($1, $2, $3, $4, $5)
			on conflict (kind) do update
			set display = excluded.display, actions = excluded.actions, retired_at = null
			where session_kinds.provider = excluded.provider
			  and session_kinds.org_id is not distinct from excluded.org_id`,
			k.Kind, provider, k.Display, orgID, actions)
		if err != nil {
			return fmt.Errorf("recording the session kind %q: %w", k.Kind, err)
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: %s", ErrKindTaken, k.Kind)
		}
	}
	return nil
}

// syncKinds writes the kinds this version provides and retires any this
// provider previously offered that the new package no longer declares. It
// belongs in the same transaction as the version bump: an upgrade that
// records a new version without the new kinds is a silent drop.
func syncKinds(ctx context.Context, tx pgx.Tx, orgID, provider string, kinds []KindDef) error {
	if err := seedKinds(ctx, tx, orgID, provider, kinds); err != nil {
		return err
	}
	names := make([]string, len(kinds))
	for i, k := range kinds {
		names[i] = k.Kind
	}
	if _, err := tx.Exec(ctx, `
		update session_kinds set retired_at = now()
		where retired_at is null
		  and provider = $1
		  and org_id is not distinct from $2
		  and not (kind = any($3::text[]))`,
		provider, orgID, names); err != nil {
		return fmt.Errorf("retiring kinds %s no longer provides: %w", provider, err)
	}
	return nil
}

// ErrKindTaken is returned when a plugin declares a session kind whose name
// already belongs to somebody else — another org's install, or the core.
var ErrKindTaken = fmt.Errorf("that session kind name is already taken on this instance")

// ProvidedKinds reads the kinds one install provides. Provision is the
// provider column, matched with the org so that two orgs running plugins of
// the same name provide their own kinds and not each other's.
func (s *Store) ProvidedKinds(ctx context.Context, installID string) ([]KindDef, error) {
	rows, err := s.Pool.Query(ctx, `
		select k.kind, k.display, k.actions
		from plugin_installs p
		join session_kinds k on k.provider = p.name and k.org_id = p.org_id
		where p.id = $1 and k.retired_at is null
		order by k.kind`, installID)
	if err != nil {
		return nil, fmt.Errorf("reading the kinds %s provides: %w", installID, err)
	}
	defer rows.Close()
	out := []KindDef{}
	for rows.Next() {
		var def KindDef
		var actions []byte
		if err := rows.Scan(&def.Kind, &def.Display, &actions); err != nil {
			return nil, fmt.Errorf("reading a kind %s provides: %w", installID, err)
		}
		if err := json.Unmarshal(actions, &def.Actions); err != nil {
			return nil, fmt.Errorf("reading the actions of %q: %w", def.Kind, err)
		}
		out = append(out, def)
	}
	return out, rows.Err()
}

// ProvidesKind reports whether this install is the one that provides a kind.
// It is the ownership half of the session surface's boundary: the org check
// says the room is in the install's org, and this says the room is running the
// install's own ceremony. A core kind is provider 'core' with a NULL org and so
// matches no install at all, which is the answer that matters — a plugin must
// never be able to reach into a poker room.
//
// The retirement and the enabled flag are part of the answer, exactly as they
// are in ProvidedKinds above and in Sessions.OfferableKinds. A switched-off
// install provides nothing and a retired kind is nobody's ceremony any more.
// Saying otherwise here would leave the ownership boundary leaning on a guard
// that lives two layers up in hostfn.go instead of on the one sentence this
// function exists to answer.
func (s *Store) ProvidesKind(ctx context.Context, installID, kind string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, `
		select exists (
			select 1 from plugin_installs p
			join session_kinds k on k.provider = p.name and k.org_id = p.org_id
			where p.id = $1 and k.kind = $2 and k.retired_at is null and p.enabled)`, installID, kind).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("checking whether %s provides the kind %q: %w", installID, kind, err)
	}
	return ok, nil
}

// OfferKinds registers everything an install provides, so that enabling a
// plugin is what puts its ceremony on offer. It is idempotent: enabling an
// already-enabled install re-registers the same kinds rather than failing on
// the registry's duplicate check.
func (h *Host) OfferKinds(ctx context.Context, installID string) error {
	if h.Kinds == nil {
		return nil
	}
	state, err := h.Store.State(ctx, installID)
	if err != nil {
		return err
	}
	defs, err := h.Store.ProvidedKinds(ctx, installID)
	if err != nil {
		return err
	}
	for _, def := range defs {
		_ = h.Kinds.Unregister(def.Kind)
		if err := h.Kinds.Register(h.PluginKind(state, def)); err != nil {
			return fmt.Errorf("offering the session kind %q: %w", def.Kind, err)
		}
	}
	return nil
}

// OfferEnabledKinds registers the kinds of every install that is switched on,
// across every org. It runs once at wiring time: the registry lives in the
// process and an enabled install has to survive a restart with its ceremony
// still on offer.
func (h *Host) OfferEnabledKinds(ctx context.Context) error {
	if h.Kinds == nil {
		return nil
	}
	rows, err := h.Store.Pool.Query(ctx, `select id from plugin_installs where enabled`)
	if err != nil {
		return fmt.Errorf("listing the enabled installs: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("reading an enabled install id: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if err := h.OfferKinds(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// RetireKinds unregisters everything an install provides. A disabled plugin's
// ceremony stops being offered at once, without waiting for a restart.
//
// The rows stay: retiring in the database is the uninstall's job, and a
// disable is reversible.
func (h *Host) RetireKinds(defs []KindDef) {
	if h.Kinds == nil {
		return
	}
	for _, def := range defs {
		_ = h.Kinds.Unregister(def.Kind)
	}
}

// PluginKind builds the live kind for one declared ceremony. Every part of it
// is a contained call into the guest.
func (h *Host) PluginKind(st State, def KindDef) session.Kind {
	in := st.Install
	installID := in.ID
	k := session.Kind{
		Name:   def.Kind,
		OrgID:  in.OrgID,
		Plugin: pluginUI(st),
		LivePlugin: func(ctx context.Context) (*session.PluginUI, error) {
			live, err := h.Store.State(ctx, installID)
			if err != nil {
				return nil, err
			}
			return pluginUI(live), nil
		},
		// A plugin's config document is whatever the plugin makes of it. The
		// core has no struct to decode it into and inventing one would only
		// describe the plugins that exist today, so it is kept as JSON and
		// passed through — the size cap on the request body is what bounds it.
		NewConfig: func() any { return new(json.RawMessage) },
		State: func(ctx context.Context, _ *pgxpool.Pool, sess store.Session) (any, error) {
			return h.kindState(ctx, in.ID, def.Kind, sess)
		},
		Actions: map[string]session.Action{},
	}
	for _, a := range def.Actions {
		action := a
		k.Actions[action.Name] = session.Action{
			Verb:            action.Verb,
			FacilitatorOnly: action.FacilitatorOnly,
			Do: func(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
				h.runAction(w, r, in.ID, def.Kind, action.Name, ac)
			},
		}
	}
	return k
}

// kindState asks the guest for the room's state payload.
//
// Whatever comes back is the plugin's own document and is treated as data: it
// is checked for being JSON at all and is otherwise passed through to the
// envelope, exactly as a core kind's StateFunc payload is. A plugin sees only
// what the host functions let it see, so this cannot carry data the plugin
// could not already read.
func (h *Host) kindState(ctx context.Context, installID, kind string, sess store.Session) (any, error) {
	in, err := json.Marshal(map[string]any{
		"session": sess.ID,
		"kind":    kind,
		"phase":   sess.Phase,
		"config":  json.RawMessage(sess.Config),
	})
	if err != nil {
		return nil, err
	}
	// ModeSync: this is on the path a room's broadcast waits on, so the fetch
	// ban applies however the plugin has been granted.
	out, err := h.Call(ctx, installID, ExportSessionState, in, ModeSync)
	if err != nil {
		return nil, fmt.Errorf("building the state of session %s: %w", sess.ID, err)
	}
	if len(out) == 0 {
		return map[string]any{}, nil
	}
	if !json.Valid(out) {
		return nil, fmt.Errorf("the plugin's state for session %s is not JSON", sess.ID)
	}
	return json.RawMessage(out), nil
}

// runAction hands one action to the guest. The dispatcher has already run the
// whole authorisation ladder — unknown name, wrong verb, facilitator-only,
// ended session — so by the time this runs, the caller is allowed to be here.
func (h *Host) runAction(w http.ResponseWriter, r *http.Request, installID, kind, action string, ac session.ActionCtx) {
	body, err := readActionBody(r)
	if err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	in, err := json.Marshal(map[string]any{
		"session": ac.Session.ID,
		"kind":    kind,
		"action":  action,
		"user":    ac.UserID,
		"body":    body,
	})
	if err != nil {
		http.Error(w, `{"error":"could not run that action"}`, http.StatusInternalServerError)
		return
	}
	if _, err := h.Call(r.Context(), installID, ExportSessionAction, in, ModeSync); err != nil {
		if h.Log != nil {
			h.Log.Warn("a plugin action failed", "install_id", installID, "kind", kind, "action", action, "error", err)
		}
		http.Error(w, `{"error":"the plugin could not run that action"}`, http.StatusBadGateway)
		return
	}
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

// readActionBody reads the request body a plugin action was called with. An
// empty body is an empty document rather than an error: an action that takes
// no arguments is a POST with nothing in it.
func readActionBody(r *http.Request) (json.RawMessage, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxActionBody))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return json.RawMessage("{}"), nil
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("the action body is not JSON")
	}
	return json.RawMessage(raw), nil
}

// pluginUI is the install projection the room iframe redacts against.
func pluginUI(st State) *session.PluginUI {
	return &session.PluginUI{
		Name:    st.Install.Name,
		Version: st.Install.Version,
		Grants:  grantCapabilities(st.Grants),
	}
}

// grantCapabilities is the grant list the room iframe redacts against: each
// capability once, sorted, scopes dropped. The host still re-checks on every
// call; this is only so the browser can redact *more*.
func grantCapabilities(grants []Grant) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, g := range grants {
		if seen[g.Capability] {
			continue
		}
		seen[g.Capability] = true
		out = append(out, g.Capability)
	}
	sort.Strings(out)
	return out
}

// maxActionBody bounds what a room can hand a plugin in one action. It matches
// the core's own JSON body cap: a plugin is not a reason to raise it.
const maxActionBody = 1 << 20
