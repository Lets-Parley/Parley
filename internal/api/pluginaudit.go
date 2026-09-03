package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/lets-parley/parley/internal/api/custody"
)

// pluginRouteHeader is how the browser names the plugin panel an action came
// from. It is not a credential and grants nothing: the request carries the
// user's own cookie and is authorised as that user whatever this says. It
// exists so a host-mediated action is attributable to the surface that
// proposed it.
const pluginRouteHeader = "X-Parley-Plugin-Route"

// statusRecorder remembers what a handler answered, so the audit records only
// the actions that actually happened.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// pluginRouteAudit records an action a plugin panel proposed and the user's
// own session then performed.
//
// The name is checked against the installs table before it is written. A user
// can put any string in a request header, and an unchecked one would let a
// visitor write arbitrary text into the org's audit log — the record has to
// name a plugin that exists on this instance or it names nothing.
//
// Reads are never audited: a GET changes nothing, and a record per poll would
// bury the writes it exists to show.
func (a *app) pluginRouteAudit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plugin := r.Header.Get(pluginRouteHeader)
		if plugin == "" || r.Method == http.MethodGet || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status < 200 || rec.status >= 300 {
			// A refused action is not an action. The server's own answer is
			// what decides, not what the plugin asked for.
			return
		}
		a.recordPluginAction(r, plugin)
	})
}

func (a *app) recordPluginAction(r *http.Request, plugin string) {
	// The response is already written, so this outlives the request context
	// deliberately: a client that hangs up must not lose the record of a
	// change the server has already made.
	ctx := context.WithoutCancel(r.Context())
	// The org is the room's, never the instance's default. This middleware
	// runs inside /sessions/{id}, so the session is already resolved and is
	// the only correct answer: defaulting it would file one tenant's action in
	// another tenant's log, and would ask "is this plugin installed?" of the
	// wrong org.
	org, err := a.orgs.BySpaceID(ctx, sessionFrom(ctx).SpaceID)
	if err != nil {
		slog.Error("could not resolve the org for a plugin action", "error", err)
		return
	}
	installed, err := a.pluginInstalled(ctx, org.ID, plugin)
	if err != nil {
		slog.Error("could not check the plugin named on an action", "plugin", plugin, "error", err)
		return
	}
	if !installed {
		slog.Warn("an action named a plugin this org does not run", "plugin", plugin, "org", org.Slug)
		return
	}
	p, _ := PrincipalFrom(ctx)
	scope := custody.Scope{OrgID: org.ID, OrgSlug: org.Slug, ActorID: p.UserID}
	if err := custody.RecordPluginAction(ctx, a.pool, scope, plugin, r.Method+" "+r.URL.Path); err != nil {
		slog.Error("could not record a plugin action", "plugin", plugin, "error", err)
	}
}

// pluginInstalled asks whether *this org* runs the named plugin. A name is
// unique inside an org and not across the instance since 0034, so an unscoped
// check would let a plugin any tenant installed vouch for an action in every
// other tenant's room.
func (a *app) pluginInstalled(ctx context.Context, orgID, name string) (bool, error) {
	var exists bool
	err := a.pool.QueryRow(ctx,
		`select exists (select 1 from plugin_installs where name = $1 and org_id = $2 and enabled)`,
		name, orgID).Scan(&exists)
	return exists, err
}
