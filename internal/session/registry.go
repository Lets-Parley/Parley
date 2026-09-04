// Package session owns the wire envelope and the kind registry — the single
// place a session kind (poker, standup, or a future extension) plugs into the
// core. A new kind describes itself with a Kind struct, gets registered into
// the server's Registry at wiring time, and touches nothing else.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// StateFunc builds the kind-specific payload for the wire envelope. It must
// only ever return client-safe (redacted) data.
type StateFunc func(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error)

// Kind is everything the core needs to know about a session kind: how to
// build its state payload, what its config document looks like, and how to
// export it. One struct rather than one map per capability — two maps keyed by
// the same string is a desync waiting to happen.
type Kind struct {
	Name string
	// State builds the kind's client-safe payload. Optional only in tests.
	State StateFunc
	// NewConfig returns a pointer to the kind's config struct, decoded with
	// DisallowUnknownFields.
	NewConfig func() any
	// CSV renders the export rows. A kind without one has no export.
	CSV CSVFunc
	// Actions is the kind's dispatch table, keyed by the {action} segment of
	// POST /sessions/{id}/actions/{action}.
	Actions map[string]Action
	// OrgID scopes the kind to one org. Empty means instance-wide, which is
	// what a core kind is; a kind a plugin provides carries the org of the
	// install that provides it, because an install belongs to one org and a
	// kind that outran its install's ownership would let one org's plugin
	// offer rooms to every other org on the instance.
	OrgID string
	// RosterChanged runs inside the transaction that changed who the session
	// is waiting on — today, a spectator toggle, which is a core route because
	// the flag is a property of a member rather than of a kind. Sharing that
	// transaction is the point: a kind that reacted afterwards would read a
	// roster somebody else could already have changed again.
	//
	// connected is the presence set, read before the transaction opened.
	// A kind with nothing to do on a roster change leaves this nil.
	RosterChanged func(ctx context.Context, tx pgx.Tx, sess store.Session, connected []string) error
	// Plugin is the install that provides this ceremony, as the room iframe
	// needs it. Core kinds leave it nil.
	Plugin *PluginUI
	// LivePlugin, when set, is read on every envelope so a grant change takes
	// effect without waiting for the kind to be re-offered. OfferKinds still
	// rebuilds Plugin so the registered snapshot matches what is in force.
	LivePlugin func(ctx context.Context) (*PluginUI, error)
}

// PluginUI is the install behind a plugin-provided kind: what to frame, and
// the grants the browser redacts against. The host still re-checks every
// grant at the effect.
type PluginUI struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Grants  []string `json:"grants"`
}

// Registry holds the session kinds a server knows about. The core kinds are
// registered at wiring time; a kind a plugin provides is registered when its
// install is enabled and unregistered when it is disabled or uninstalled, so
// the map is written to while rooms are dispatching against it.
//
// The synchronisation is copy-on-write behind an atomic pointer rather than a
// mutex on the read path. Registration is rare — an operator enabling an
// install — and reads happen on every dispatch, every session create and every
// envelope build, so the shape that costs a reader nothing but an atomic load
// is the right one. Writers serialise on mu and publish a whole new map; a
// reader either sees the map before the write or the map after it, never a map
// mid-update.
type Registry struct {
	mu    sync.Mutex
	kinds atomic.Pointer[map[string]Kind]
}

func NewRegistry() *Registry {
	r := &Registry{}
	m := map[string]Kind{}
	r.kinds.Store(&m)
	return r
}

// read is the whole read path: one atomic load. The map it returns is never
// written to again, so a caller may range over it while a writer publishes a
// replacement.
func (r *Registry) read() map[string]Kind { return *r.kinds.Load() }

// visible reports whether a kind is offered to an org. A kind with no OrgID is
// instance-wide — that is what the core kinds are — and a kind a plugin
// provides belongs to the org whose install provides it.
func visible(k Kind, orgID string) bool { return k.OrgID == "" || k.OrgID == orgID }

// Register wires a session kind into the dispatcher. A duplicate name is a
// wiring mistake and returns an error rather than overwriting the first
// registration.
func (r *Registry) Register(k Kind) error {
	if k.Name == "" {
		return fmt.Errorf("registering a session kind: name is empty")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.read()[k.Name]; ok {
		return fmt.Errorf("registering session kind %q: already registered", k.Name)
	}
	// The cross-site guard exempts GET, on the assumption that a GET changes
	// nothing. Every action is a write, so an action answering GET would be a
	// write with no CSRF protection at all. Refuse it at wiring time — a
	// third-party kind is registered the same way and gets the same refusal.
	for name, a := range k.Actions {
		if a.Verb == http.MethodGet || a.Verb == http.MethodHead {
			return fmt.Errorf("registering session kind %q: action %q answers %s, but actions are writes and the cross-site guard exempts %s", k.Name, name, a.Verb, a.Verb)
		}
	}
	next := r.clone()
	next[k.Name] = k
	r.kinds.Store(&next)
	return nil
}

// clone copies the live map for a writer. The caller holds mu.
func (r *Registry) clone() map[string]Kind {
	cur := r.read()
	next := make(map[string]Kind, len(cur)+1)
	for name, k := range cur {
		next[name] = k
	}
	return next
}

// Unregister removes a kind, erroring if it was never registered.
func (r *Registry) Unregister(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.read()[name]; !ok {
		return fmt.Errorf("unregistering session kind %q: not registered", name)
	}
	next := r.clone()
	delete(next, name)
	r.kinds.Store(&next)
	return nil
}

// Names returns the registered kind names, sorted. Callers use it to build
// messages that stay true whatever set of kinds is registered.
func (r *Registry) Names() []string { return r.names(func(Kind) bool { return true }) }

// NamesInOrg is Names narrowed to what one org may create: the instance-wide
// kinds plus the ones this org's own installs provide.
func (r *Registry) NamesInOrg(orgID string) []string {
	return r.names(func(k Kind) bool { return visible(k, orgID) })
}

func (r *Registry) names(keep func(Kind) bool) []string {
	kinds := r.read()
	names := make([]string, 0, len(kinds))
	for name, k := range kinds {
		if keep(k) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// Known reports whether a kind is registered at all, whichever org provides
// it. It is the lookup for a session that already exists — a room outlives the
// install that offered its kind, so loading one must not depend on the org
// scope that decides whether a *new* one may be created.
func (r *Registry) Known(kind string) bool {
	_, ok := r.read()[kind]
	return ok
}

// KindPlugin is the install a plugin-provided kind currently names on the
// wire. Core kinds and unknown names return nil. The returned value is a copy
// so a caller cannot mutate the live registry.
func (r *Registry) KindPlugin(kind string) *PluginUI {
	k, ok := r.read()[kind]
	if !ok || k.Plugin == nil {
		return nil
	}
	out := *k.Plugin
	out.Grants = append([]string(nil), k.Plugin.Grants...)
	return &out
}

// KnownInOrg is the create-time lookup: whether this org may make a session of
// this kind.
func (r *Registry) KnownInOrg(orgID, kind string) bool {
	k, ok := r.read()[kind]
	return ok && visible(k, orgID)
}

// ParseConfig validates a raw config document against the kind's struct.
func (r *Registry) ParseConfig(kind string, raw []byte) ([]byte, error) {
	k, ok := r.read()[kind]
	if !ok {
		return nil, fmt.Errorf("unknown session kind %q", kind)
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	cfg := k.NewConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(cfg); err != nil {
		return nil, err
	}
	// The decoder stops after one value. Refuse anything following it rather
	// than silently dropping it: a caller outside the API handler has no outer
	// decode to reject the trailing half for them.
	if dec.More() {
		return nil, fmt.Errorf("trailing data after the %s config document", kind)
	}
	// A structural decode says the document is the right shape, not that its
	// values are allowed. A kind that cares validates itself here — the only
	// gate between a space member and a stored config.
	if v, ok := cfg.(interface{ Validate() error }); ok {
		if err := v.Validate(); err != nil {
			return nil, fmt.Errorf("validating the %s config document: %w", kind, err)
		}
	}
	return json.Marshal(cfg)
}

// Envelope is the wire state shared by every kind. State carries the
// kind-specific payload.
type Envelope struct {
	ID                   string     `json:"id"`
	Kind                 string     `json:"kind"`
	Title                string     `json:"title"`
	Phase                string     `json:"phase"`
	Revealed             bool       `json:"revealed"`
	Version              int64      `json:"version"`
	FacilitatorID        string     `json:"facilitatorId"`
	FacilitatorConnected bool       `json:"facilitatorConnected"`
	FacilitatorOffline   *time.Time `json:"facilitatorOfflineSince,omitempty"`
	EndedAt              *time.Time `json:"endedAt"`
	Presence             []string   `json:"presence"`
	SpaceSlug            string     `json:"spaceSlug"`
	// OrgSlug is the org segment of the space's URL. The session page builds
	// a space API URL out of both halves, so a missing one breaks its lookup
	// rather than merely a label.
	OrgSlug      string    `json:"orgSlug"`
	Participants []Person  `json:"participants"`
	ServerTime   time.Time `json:"serverTime"`
	State        any       `json:"state"`
	// KindUnavailable says the room's ceremony is not currently registered —
	// its plugin is disabled, or the process has not offered it yet. State is
	// then null, because the only code that can build it is not running.
	//
	// The room still loads. A session outlives the install that offered its
	// kind by design (sessions.kind is a foreign key to a row that is retired
	// rather than deleted), so "the plugin is off" has to be a state the room
	// renders and not a 500: an operator switching a plugin off mid-meeting
	// would otherwise break every room of that kind, including the history of
	// rooms that have already ended, and switching it back on has to put them
	// straight back.
	KindUnavailable bool `json:"kindUnavailable,omitempty"`
	// Plugin names the install that provides this ceremony so the client can
	// frame it. Absent for core kinds and for a room whose kind is unregistered.
	Plugin *PluginUI `json:"plugin,omitempty"`
}

// Person is a roster entry carried in the envelope so clients can render
// names and avatars without a second fetch.
type Person struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
	Spectator bool   `json:"spectator"`
	// Guest marks a seat held by a signed link rather than by membership of
	// the space. Nothing stops a guest choosing a member's display name, so
	// the roster has to say which seat is which — server-side, because a
	// client cannot tell the two apart from a name alone.
	Guest bool `json:"guest"`
	// The chosen avatar. Empty ids mean the client renders the hue alone.
	AvatarIcon string `json:"avatarIcon"`
}

// roster names everybody the room can render: the space's members, plus the
// guests who joined this one session by signed link. A guest has no members
// row and so no spectator flag — it votes like anybody else in the room, the
// same reading maybeAutoReveal takes of the denominator — so it is seated as a
// participant, never a spectator.
//
// pastGuests widens the guest half from the live links to every link the room
// ever carried. The wire roster wants the live ones: a revoked or expired link
// is a seat nobody can occupy any more. An export wants all of them, because
// a name in a finished meeting's CSV must not depend on whether the link that
// let its owner in is still good.
func roster(ctx context.Context, pool *pgxpool.Pool, spaceID, sessionID string, pastGuests bool) (string, string, []Person, error) {
	var slug, orgSlug string
	if err := pool.QueryRow(ctx,
		"select sp.slug, o.slug from spaces sp join orgs o on o.id = sp.org_id where sp.id = $1", spaceID,
	).Scan(&slug, &orgSlug); err != nil {
		return "", "", nil, err
	}
	rows, err := pool.Query(ctx, `
		select m.user_id::text, u.name, m.spectator, false, u.avatar_icon
		from members m join users u on u.id = m.user_id
		where m.space_id = $1
		union
		select u.id::text, u.name, false, true, u.avatar_icon
		from users u join session_links l on l.id = u.link_id
		where l.session_id = $2
		  and ($3 or (l.revoked_at is null and l.expires_at > now()))
		order by 2`, spaceID, sessionID, pastGuests)
	if err != nil {
		return "", "", nil, err
	}
	defer rows.Close()
	people := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.UserID, &p.Name, &p.Spectator, &p.Guest, &p.AvatarIcon); err != nil {
			return "", "", nil, err
		}
		p.AvatarHue = store.AvatarHue(p.UserID)
		people = append(people, p)
	}
	return slug, orgSlug, people, rows.Err()
}

// RedactForGuest strips space-level data from an envelope bound for a link
// guest. A signed link is a capability for one room, never membership of the
// space that holds it, so the guest is shown neither the space's join slug nor
// a member who is not taking part in this session — otherwise one meeting link
// enumerates the whole space's roster from the one room it is entitled to.
//
// "Taking part" is presence plus the facilitator, both of which the envelope
// already names, so the roster discloses nothing the guest cannot see anyway.
//
// selfID is the guest the envelope is bound for, and is always kept: presence
// is registered when a socket connects, so a guest reading the room before its
// socket settles would otherwise be told it is not in the room it is in. Pass
// "" where the envelope is not bound to one guest — the broadcast path, which
// builds a single redacted copy for every guest on the socket, and so has a
// presence row for each of them already.
func (e Envelope) RedactForGuest(selfID string) Envelope {
	e.SpaceSlug = ""
	e.OrgSlug = ""
	here := make(map[string]struct{}, len(e.Presence)+2)
	for _, id := range e.Presence {
		here[id] = struct{}{}
	}
	here[e.FacilitatorID] = struct{}{}
	if selfID != "" {
		here[selfID] = struct{}{}
	}
	people := []Person{}
	for _, p := range e.Participants {
		if _, ok := here[p.UserID]; ok {
			people = append(people, p)
		}
	}
	e.Participants = people
	return e
}

// BuildEnvelope assembles the wire state for a session.
//
// Presence comes from the database, not from a hub. That is the whole point:
// any replica must be able to answer "who is in this room" with the same list,
// including people whose sockets are held by a different pod. There is
// deliberately no in-process fallback — a second path here is a path that tests
// exercise and production does not.
func (r *Registry) BuildEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string) (Envelope, error) {
	return r.buildEnvelope(ctx, pool, presence, sessions, id, false)
}

// BuildExportEnvelope is BuildEnvelope with the roster widened to every guest
// the room ever admitted. It is for the CSV path only: revoking or expiring a
// link takes away a seat, never a name already written into the record.
func (r *Registry) BuildExportEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string) (Envelope, error) {
	return r.buildEnvelope(ctx, pool, presence, sessions, id, true)
}

func (r *Registry) buildEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string, pastGuests bool) (Envelope, error) {
	sess, err := sessions.ByID(ctx, id)
	if err != nil {
		return Envelope{}, err
	}
	// A kind that is not registered is a degraded room rather than an error.
	// See Envelope.KindUnavailable: nothing here is destructive, the session
	// row is untouched, and re-registering the kind restores the room exactly
	// as it was.
	k, known := r.read()[sess.Kind]
	var state any
	if known {
		state, err = k.State(ctx, pool, sess)
		if err != nil {
			return Envelope{}, err
		}
	}
	slug, orgSlug, people, err := roster(ctx, pool, sess.SpaceID, sess.ID, pastGuests)
	if err != nil {
		return Envelope{}, err
	}

	connected, err := presence.InSession(ctx, id)
	if err != nil {
		return Envelope{}, err
	}
	facConnected := false
	for _, uid := range connected {
		if uid == sess.FacilitatorID {
			facConnected = true
			break
		}
	}
	env := Envelope{
		ID:                   sess.ID,
		Kind:                 sess.Kind,
		Title:                sess.Title,
		Phase:                sess.Phase,
		Revealed:             sess.Revealed,
		Version:              sess.Version,
		FacilitatorID:        sess.FacilitatorID,
		FacilitatorConnected: facConnected,
		EndedAt:              sess.EndedAt,
		Presence:             connected,
		SpaceSlug:            slug,
		OrgSlug:              orgSlug,
		Participants:         people,
		ServerTime:           time.Now().UTC(),
		State:                state,
		KindUnavailable:      !known,
	}
	if known {
		env.Plugin = k.Plugin
		if k.LivePlugin != nil {
			if p, err := k.LivePlugin(ctx); err == nil {
				env.Plugin = p
			}
		}
	}
	if !facConnected {
		t := sess.FacilitatorSeenAt.UTC()
		env.FacilitatorOffline = &t
	}
	return env, nil
}

// RosterChanged returns the kind's roster hook, if it has one.
func (r *Registry) RosterChanged(kind string) (func(ctx context.Context, tx pgx.Tx, sess store.Session, connected []string) error, bool) {
	k, ok := r.read()[kind]
	if !ok || k.RosterChanged == nil {
		return nil, false
	}
	return k.RosterChanged, true
}
