package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/session"
)

// legacyAlias is one pre-dispatcher path kept alive for a release. Each maps
// onto exactly one action of one kind, so a poker session answering /start or
// a standup session answering /reveal is now a 404 instead of whichever kind
// happened to mount the path first.
//
// Delete this table — and the routes it wires — one release after v0.3.0.
type legacyAlias struct {
	method, path, action string
}

var legacyAliases = []legacyAlias{
	{"POST", "/stories", "stories"},
	{"POST", "/select", "select"},
	{"POST", "/reveal", "reveal"},
	{"POST", "/reset", "reset"},
	{"PUT", "/standup", "standup"},
	{"POST", "/start", "start"},
	{"POST", "/next", "next"},
	{"POST", "/skip", "skip"},
}

// handleAction is the one dispatcher: POST /sessions/{id}/actions/{action}.
//
// The verb is POST and only POST. Every action is a state transition on the
// session rather than a replacement of a resource at that URL, so a single
// verb is the honest shape; the one route that disagreed, PUT
// /sessions/{id}/standup, is an upsert of the caller's own entry and becomes
// POST .../actions/standup. The old PUT stays live as an alias for a release.
func (a *app) handleAction(w http.ResponseWriter, r *http.Request) {
	a.dispatch(w, r, chi.URLParam(r, "action"))
}

// aliasAction serves one legacy path by dispatching a fixed action name.
func (a *app) aliasAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.dispatch(w, r, action)
	}
}

// dispatch runs the shared authorization ladder and hands off to the kind.
// It sits inside the /sessions/{id} group, so requireSessionMember has already
// resolved the session and rejected non-members with a 404.
func (a *app) dispatch(w http.ResponseWriter, r *http.Request, name string) {
	sess := sessionFrom(r.Context())
	act, ok := a.kinds.Action(sess.Kind, name)
	if !ok {
		http.Error(w, `{"error":"no such action"}`, http.StatusNotFound)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	if act.FacilitatorOnly && sess.FacilitatorID != p.UserID {
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
		return
	}
	// Every kind action is a write, so the ended-session guard covers all of
	// them. It lives here rather than in requireSessionMember because reading,
	// exporting and reopening an ended session all stay legitimate — reopen
	// exists for nothing else. This is the guard that used to be duplicated
	// inside poker.withSession and standup.withSession.
	if sess.EndedAt != nil {
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
		return
	}
	act.Do(w, r, session.ActionCtx{
		Presence:  a.presence,
		Pool:      a.pool,
		Hub:       a.hub,
		Broadcast: a.broadcastState,
		Session:   sess,
		UserID:    p.UserID,
	})
}
