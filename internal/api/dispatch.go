package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/session"
)

// handleAction is the one dispatcher: /sessions/{id}/actions/{action}, routed
// on the verb each action declares.
//
// The case for POST-only is real and worth stating: every action is a state
// transition on the session rather than a replacement of a resource at that
// URL, so one verb is a defensible shape and spares clients a table. The
// counter, and the reason this routes on (verb, action) instead: an upsert of
// the caller's own standup entry is exactly what PUT is for, and a partial
// story edit exactly what PATCH is for. Collapsing both onto POST loses the
// idempotency signal a client can act on — a retried PUT is safe to send and a
// retried POST is not — and no amount of documentation puts that back.
//
// The action name is a URL parameter, so chi cannot know which names are real
// and its own 405 would fire for every unknown name too. The lookup below owns
// the distinction instead: an unknown name is a 404 whatever the verb, and a
// real action reached with the wrong verb is a 405 naming the verb that works.
func (a *app) handleAction(w http.ResponseWriter, r *http.Request) {
	a.dispatch(w, r, chi.URLParam(r, "action"))
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
	if r.Method != act.Verb {
		w.Header().Set("Allow", act.Verb)
		http.Error(w, `{"error":"that action does not answer this method"}`, http.StatusMethodNotAllowed)
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
		Presence:   a.presence,
		Pool:       a.pool,
		Hub:        a.hub,
		Broadcast:  a.broadcastState,
		Session:    sess,
		UserID:     p.UserID,
		StoryLimit: a.limits.StoriesPerSession,
	})
}
