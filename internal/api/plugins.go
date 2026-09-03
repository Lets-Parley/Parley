package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
)

// The operator's plugin administration surface.
//
// Everything here is mounted behind RequireUser + requireOrgMember +
// requireOrgAdmin, the same three-deep gate org custody uses, so an ordinary
// member reaching any of these routes gets 403 from the middleware and never
// reaches a handler. Hiding the nav link is a courtesy; this is the control,
// and TestPluginAdminIsRefusedToAnOrdinaryMember is what says so.
//
// The consent copy a screen renders is not written here either: it comes from
// internal/plugin.Describe, next to the guards that enforce it, so the sentence
// an operator agrees to and the rule the host applies cannot drift apart.

// pluginPackage is the file an operator uploads for the code tier. It is
// untrusted input that *requests* capabilities; nothing in it grants anything.
type pluginPackage struct {
	Manifest     int            `json:"manifest"`
	Kind         string         `json:"kind"`
	Name         string         `json:"name"`
	Version      string         `json:"version"`
	Capabilities []pluginCapReq `json:"capabilities"`
	QuotaBytes   int64          `json:"quotaBytes"`
}

type pluginCapReq struct {
	Capability string `json:"capability"`
	Scope      string `json:"scope"`
}

// installRequest is a package plus the operator's decision about it. Consent is
// a field rather than an implication: a POST that carries a package and no
// explicit grant decision is refused, so a client that forgot to show the
// consent screen cannot install anything by omission.
type installRequest struct {
	Package pluginPackage `json:"package"`
	// GrantsAccepted must be true. It is the operator saying the words.
	GrantsAccepted bool `json:"grantsAccepted"`
}

type describedGrant = plugin.DescribedGrant

// installView is one installed plugin as the administration surface reads it.
type installView struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Version  string           `json:"version"`
	Enabled  bool             `json:"enabled"`
	Grants   []describedGrant `json:"grants"`
	Provides []string         `json:"provides"`
	Pending  *pendingView     `json:"pending,omitempty"`
	Health   plugin.Health    `json:"health"`
}

// pendingView is an upgrade waiting on an operator, rendered as a diff against
// the grants in force. Added is what the new version wants and does not have;
// Removed is what it would give up. The plugin keeps running on Current until
// somebody approves.
type pendingView struct {
	Version string           `json:"version"`
	Grants  []describedGrant `json:"grants"`
	Added   []describedGrant `json:"added"`
	Removed []describedGrant `json:"removed"`
}

// previewResponse is what the consent screen renders before anything is
// installed. It is computed by the server because the server is the enforcer:
// a client that expanded its own wildcards would be describing a rule nobody
// applies.
type previewResponse struct {
	Name     string           `json:"name"`
	Version  string           `json:"version"`
	Grants   []describedGrant `json:"grants"`
	Upgrade  bool             `json:"upgrade"`
	Current  []describedGrant `json:"current,omitempty"`
	Added    []describedGrant `json:"added,omitempty"`
	Removed  []describedGrant `json:"removed,omitempty"`
	Widens   bool             `json:"widens"`
	Provides []string         `json:"provides,omitempty"`
}

func (a *app) pluginsAvailable() bool { return a.plugins != nil }

// mountPlugins registers the administration tree. The caller supplies the
// admin gate.
func (a *app) mountPlugins(r chi.Router) {
	r.Get("/", a.handleListPlugins)
	r.Post("/preview", a.handlePreviewPlugin)
	r.Post("/", a.handleInstallPlugin)
	r.Post("/{id}/upgrade", a.handleApproveUpgrade)
	r.Post("/{id}/enabled", a.handleSetPluginEnabled)
	r.Delete("/{id}", a.handleUninstallPlugin)
	// The theme tier executes nothing and lives in the operator's own browser,
	// so there is no server-side record of it to change — but "every install
	// lands in the audit log" does not have an exception for the tier that is
	// easy. These write the audit row and nothing else.
	r.Post("/themes", a.handleAuditThemeInstall)
	r.Delete("/themes", a.handleAuditThemeReset)
}

func (a *app) handleListPlugins(w http.ResponseWriter, r *http.Request) {
	if !a.pluginsAvailable() {
		writeJSON(w, http.StatusOK, map[string]any{
			"hostRunning": false, "secretsAvailable": false, "installs": []installView{},
		})
		return
	}
	rows, err := a.plugins.Pool.Query(r.Context(),
		`select id from plugin_installs order by name`)
	if err != nil {
		slog.Error("listing plugin installs", "error", err)
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}

	views := make([]installView, 0, len(ids))
	for _, id := range ids {
		view, err := a.installView(r.Context(), id)
		if err != nil {
			slog.Error("reading a plugin install", "install_id", id, "error", err)
			http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
			return
		}
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hostRunning":      a.pluginHost != nil,
		"secretsAvailable": a.plugins.Cipher != nil,
		"installs":         views,
	})
}

func (a *app) installView(ctx context.Context, id string) (installView, error) {
	state, err := a.plugins.State(ctx, id)
	if err != nil {
		return installView{}, err
	}
	out := installView{
		ID:      state.Install.ID,
		Name:    state.Install.Name,
		Version: state.Install.Version,
		Enabled: state.Install.Enabled,
		Grants:  plugin.DescribeAll(sortGrants(state.Grants)),
		Health:  plugin.Health{State: plugin.HealthOK},
	}
	if !state.Install.Enabled {
		out.Health = plugin.Health{State: plugin.HealthDisabled, Reason: "an operator switched it off"}
	}
	if a.pluginHost != nil {
		out.Health = a.pluginHost.Health(id, state.Install.Enabled)
	}
	blocking, err := a.plugins.BlockingSessions(ctx, id)
	if err != nil {
		return installView{}, err
	}
	for _, k := range blocking {
		out.Provides = append(out.Provides, k.Display)
	}
	pending, ok, err := a.plugins.Pending(ctx, id)
	if err != nil {
		return installView{}, err
	}
	if ok {
		added, removed := diffGrants(state.Grants, pending.Grants)
		out.Pending = &pendingView{
			Version: pending.Version,
			Grants:  plugin.DescribeAll(sortGrants(pending.Grants)),
			Added:   plugin.DescribeAll(added),
			Removed: plugin.DescribeAll(removed),
		}
	}
	return out, nil
}

func (a *app) handlePreviewPlugin(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	pkg, ok := a.readPackage(w, r)
	if !ok {
		return
	}
	grants := pkg.grants()
	out := previewResponse{
		Name:    pkg.Name,
		Version: pkg.Version,
		Grants:  plugin.DescribeAll(grants),
	}
	current, found, err := a.installByName(r.Context(), pkg.Name)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	if found {
		added, removed := diffGrants(current.Grants, grants)
		out.Upgrade = true
		out.Current = plugin.DescribeAll(sortGrants(current.Grants))
		out.Added, out.Removed = plugin.DescribeAll(added), plugin.DescribeAll(removed)
		out.Widens = len(added) > 0
	} else {
		out.Widens = len(grants) > 0
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleInstallPlugin(w http.ResponseWriter, r *http.Request) {
	var req installRequest
	if err := httprequest.DecodeJSON(w, r, 64<<10, &req); err != nil {
		http.Error(w, `{"error":"that is not a plugin package"}`, http.StatusBadRequest)
		return
	}
	if !a.requirePluginStore(w) {
		return
	}
	// The explicit decision. A package with capabilities cannot be installed
	// by a client that never asked anybody.
	if !req.GrantsAccepted {
		http.Error(w,
			`{"error":"this plugin's capabilities have to be granted explicitly before it can be installed"}`,
			http.StatusBadRequest)
		return
	}
	if msg, ok := req.Package.validate(); !ok {
		http.Error(w, `{"error":`+jsonString(msg)+`}`, http.StatusBadRequest)
		return
	}
	pkg := req.Package
	grants := pkg.grants()

	current, found, err := a.installByName(r.Context(), pkg.Name)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	if !found {
		in, err := a.plugins.Install(r.Context(), plugin.InstallRequest{
			Name: pkg.Name, Version: pkg.Version, Grants: grants,
			QuotaBytes: pkg.quota(),
		})
		if err != nil {
			a.pluginError(w, err, "could not install that plugin")
			return
		}
		a.auditPlugin(r, "plugin.install",
			fmt.Sprintf("installed %s %s with %d capabilities", pkg.Name, pkg.Version, len(grants)))
		view, err := a.installView(r.Context(), in.ID)
		if err != nil {
			http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, view)
		return
	}

	err = a.plugins.Upgrade(r.Context(), current.Install.ID, pkg.Version, grants)
	switch {
	case errors.Is(err, plugin.ErrUpgradePending):
		// The install keeps its old version and its old grants. This is the
		// success path for a widening upgrade, not a failure.
		a.auditPlugin(r, "plugin.upgrade_requested",
			fmt.Sprintf("%s requested %s with wider capabilities; it is waiting for approval", pkg.Name, pkg.Version))
		view, viewErr := a.installView(r.Context(), current.Install.ID)
		if viewErr != nil {
			http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusAccepted, view)
		return
	case err != nil:
		a.pluginError(w, err, "could not upgrade that plugin")
		return
	}
	a.auditPlugin(r, "plugin.upgrade",
		fmt.Sprintf("upgraded %s to %s within the capabilities already granted", pkg.Name, pkg.Version))
	view, err := a.installView(r.Context(), current.Install.ID)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handleApproveUpgrade(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Approve bool `json:"approve"`
	}
	if err := decodeOptional(w, r, &body); err != nil {
		http.Error(w, `{"error":"that is not a decision"}`, http.StatusBadRequest)
		return
	}
	// Approval is never the default. A POST that does not say so leaves the
	// plugin on the grants it already had, which is also what the screen's
	// quiet "keep the current grants" action does.
	if !body.Approve {
		http.Error(w,
			`{"error":"approving wider capabilities has to be said explicitly"}`,
			http.StatusBadRequest)
		return
	}
	if _, err := a.plugins.State(r.Context(), id); err != nil {
		http.Error(w, `{"error":"no such plugin"}`, http.StatusNotFound)
		return
	}
	pending, ok, err := a.plugins.Pending(r.Context(), id)
	if err != nil {
		a.pluginError(w, err, "could not read the pending upgrade")
		return
	}
	if !ok {
		http.Error(w, `{"error":"there is no upgrade waiting on this plugin"}`, http.StatusNotFound)
		return
	}
	if err := a.plugins.ApproveUpgrade(r.Context(), id); err != nil {
		a.pluginError(w, err, "could not approve that upgrade")
		return
	}
	a.auditPlugin(r, "plugin.upgrade_approved",
		fmt.Sprintf("approved %s and the %d capabilities it asked for", pending.Version, len(pending.Grants)))
	view, err := a.installView(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handleSetPluginEnabled(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeOptional(w, r, &body); err != nil {
		http.Error(w, `{"error":"that is not a decision"}`, http.StatusBadRequest)
		return
	}
	state, err := a.plugins.State(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"no such plugin"}`, http.StatusNotFound)
		return
	}
	// Disable is reversible and never routes through Uninstall, which destroys
	// the plugin's stored data and its unrecoverable encrypted secrets.
	if a.pluginHost != nil {
		if body.Enabled {
			err = a.pluginHost.Enable(r.Context(), id)
		} else {
			err = a.pluginHost.Disable(r.Context(), id, "an operator switched it off")
		}
	} else {
		err = a.plugins.SetEnabled(r.Context(), id, body.Enabled)
	}
	if err != nil {
		a.pluginError(w, err, "could not change that plugin")
		return
	}
	action, word := "plugin.disable", "disabled"
	if body.Enabled {
		action, word = "plugin.enable", "re-enabled"
	}
	a.auditPlugin(r, action, word+" "+state.Install.Name)
	view, err := a.installView(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handleUninstallPlugin(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	id := chi.URLParam(r, "id")
	state, err := a.plugins.State(r.Context(), id)
	if err != nil {
		http.Error(w, `{"error":"no such plugin"}`, http.StatusNotFound)
		return
	}
	err = a.plugins.Uninstall(r.Context(), id)
	var blocked *plugin.BlockedError
	if errors.As(err, &blocked) {
		// 409, and the refusal carries the rooms that block it rather than
		// leaving the operator to guess.
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   blocked.Error(),
			"blocked": blocked.Sessions,
		})
		return
	}
	if err != nil {
		a.pluginError(w, err, "could not uninstall that plugin")
		return
	}
	if a.pluginHost != nil {
		a.pluginHost.Forget(r.Context(), id)
	}
	a.auditPlugin(r, "plugin.uninstall",
		fmt.Sprintf("uninstalled %s %s, destroying its stored data and secrets", state.Install.Name, state.Install.Version))
	w.WriteHeader(http.StatusNoContent)
}

// handleAuditThemeInstall records that an operator applied a theme pack. The
// pack itself never reaches the server — it is a value map applied in the
// browser — so this route exists only so the tier that executes nothing is
// still accountable to the same log as the tier that does.
func (a *app) handleAuditThemeInstall(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name                 string `json:"name"`
		Version              string `json:"version"`
		ContrastAcknowledged bool   `json:"contrastAcknowledged"`
	}
	if err := decodeOptional(w, r, &body); err != nil {
		http.Error(w, `{"error":"that is not a theme"}`, http.StatusBadRequest)
		return
	}
	detail := fmt.Sprintf("applied the theme pack %s %s",
		clip(body.Name, 64), clip(body.Version, 32))
	if body.ContrastAcknowledged {
		detail += " after acknowledging that it fails the contrast gate"
	}
	a.auditPlugin(r, "theme.install", detail)
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleAuditThemeReset(w http.ResponseWriter, r *http.Request) {
	a.auditPlugin(r, "theme.reset", "reset to the built-in palette")
	w.WriteHeader(http.StatusNoContent)
}

/* ------------------------------------------------------------- plumbing -- */

func (a *app) requirePluginStore(w http.ResponseWriter) bool {
	if a.plugins == nil {
		http.Error(w, `{"error":"plugins are not enabled on this instance"}`, http.StatusServiceUnavailable)
		return false
	}
	return true
}

func (a *app) readPackage(w http.ResponseWriter, r *http.Request) (pluginPackage, bool) {
	var pkg pluginPackage
	if err := httprequest.DecodeJSON(w, r, 64<<10, &pkg); err != nil {
		http.Error(w, `{"error":"that is not a plugin package"}`, http.StatusBadRequest)
		return pluginPackage{}, false
	}
	if msg, ok := pkg.validate(); !ok {
		http.Error(w, `{"error":`+jsonString(msg)+`}`, http.StatusBadRequest)
		return pluginPackage{}, false
	}
	return pkg, true
}

func (a *app) installByName(ctx context.Context, name string) (plugin.State, bool, error) {
	var id string
	err := a.plugins.Pool.QueryRow(ctx, `select id from plugin_installs where name = $1`, name).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return plugin.State{}, false, nil
	}
	if err != nil {
		return plugin.State{}, false, err
	}
	state, err := a.plugins.State(ctx, id)
	return state, err == nil, err
}

// pluginError keeps a refusal the plugin package already worded — an
// unenforceable allowlist entry, secrets with no key — as a 400 the operator
// can act on, rather than flattening it into "something went wrong".
func (a *app) pluginError(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, plugin.ErrNoSecretKey) || errors.Is(err, plugin.ErrAllowPattern) {
		http.Error(w, `{"error":`+jsonString(err.Error())+`}`, http.StatusBadRequest)
		return
	}
	slog.Error("plugin administration", "error", err)
	http.Error(w, `{"error":`+jsonString(fallback)+`}`, http.StatusInternalServerError)
}

// auditPlugin writes one row of org_audit_log, the log an org admin's
// escalations already land in (0023_org_custody.sql). The insert is written
// here rather than reused from internal/api/custody because that package
// deliberately links nothing session-shaped and this one is not part of that
// boundary — the columns are the same ones, and the row names the acting user.
//
// A failed audit write is logged loudly rather than failing the request the
// action already completed: the alternative is a plugin that is installed and
// a caller told it was not.
func (a *app) auditPlugin(r *http.Request, action, detail string) {
	org := orgFrom(r.Context())
	p, _ := PrincipalFrom(r.Context())
	var actor *string
	if p.UserID != "" {
		actor = &p.UserID
	}
	if _, err := a.pool.Exec(r.Context(), `
		insert into org_audit_log (org_id, org_slug, actor_id, action, detail)
		values ($1, $2, $3, $4, $5)`,
		org.ID, org.Slug, actor, action, clip(detail, 500)); err != nil {
		slog.Error("could not write a plugin audit record",
			"action", action, "org", org.Slug, "actor", p.UserID, "error", err)
	}
}

func (p pluginPackage) quota() int64 {
	const defaultQuota = 1 << 20
	if p.QuotaBytes > 0 {
		return p.QuotaBytes
	}
	return defaultQuota
}

func (p pluginPackage) grants() []plugin.Grant {
	out := make([]plugin.Grant, 0, len(p.Capabilities))
	for _, c := range p.Capabilities {
		out = append(out, plugin.Grant{
			Capability: strings.TrimSpace(c.Capability),
			Scope:      strings.TrimSpace(c.Scope),
		})
	}
	return sortGrants(out)
}

var pluginName = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)
var pluginVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// validate screens the uploaded file. The shape mirrors the theme pack's, so
// an operator's two tiers read as two versions of the same act.
func (p pluginPackage) validate() (string, bool) {
	switch {
	case p.Manifest != 1:
		return "the manifest version must be 1", false
	case p.Kind != "plugin":
		return `the kind must be "plugin" — a theme pack is installed on the theme tier`, false
	case len(p.Name) == 0 || len(p.Name) > 64 || !pluginName.MatchString(p.Name):
		return "the name must be lowercase dot- or hyphen-separated, 64 characters or fewer", false
	case !pluginVersion.MatchString(p.Version):
		return "the version must be major.minor.patch", false
	case len(p.Capabilities) > 64:
		return "a plugin may not request more than 64 capabilities", false
	}
	for _, c := range p.Capabilities {
		if strings.TrimSpace(c.Capability) == "" {
			return "a requested capability has no name", false
		}
		if len(c.Scope) > 253 {
			return "a capability scope is longer than any hostname or key prefix can be", false
		}
	}
	return "", true
}

// sortGrants gives a grant set one order, so a diff and a screen are stable.
func sortGrants(in []plugin.Grant) []plugin.Grant {
	out := append([]plugin.Grant(nil), in...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Capability != out[j].Capability {
			return out[i].Capability < out[j].Capability
		}
		return out[i].Scope < out[j].Scope
	})
	return out
}

// diffGrants is the upgrade diff the consent screen renders: what the new set
// asks for beyond what is in force, and what it gives up.
func diffGrants(current, want []plugin.Grant) (added, removed []plugin.Grant) {
	has := func(set []plugin.Grant, g plugin.Grant) bool {
		for _, x := range set {
			if x.Capability == g.Capability && x.Scope == g.Scope {
				return true
			}
		}
		return false
	}
	// A wider grant is one the install does not already allow — State.Allows,
	// so a capability already held without a scope covers a scoped request,
	// exactly as Store.Upgrade decides whether an upgrade is pending.
	inForce := plugin.State{Grants: current}
	for _, g := range sortGrants(want) {
		if !inForce.Allows(g.Capability, g.Scope) {
			added = append(added, g)
		}
	}
	for _, g := range sortGrants(current) {
		if !has(want, g) {
			removed = append(removed, g)
		}
	}
	return added, removed
}

// clip bounds a string an operator supplied, on a rune boundary — a byte-wise
// cut would put half a character into the audit log.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	runes := []rune(s)
	for len(string(runes)) > n {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

// jsonString quotes a message for the `{"error":…}` bodies this package writes
// as string literals everywhere else, so a message carrying a quote cannot
// produce a malformed body.
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `"something went wrong"`
	}
	return string(b)
}
