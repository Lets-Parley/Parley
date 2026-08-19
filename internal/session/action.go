package session

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/store"
)

// ActionCtx is what the core hands an action handler. Session and UserID are
// already resolved and authorized: the caller is a member of the session's
// space, the session is not ended, and — for a FacilitatorOnly action — the
// caller is its facilitator. A handler never re-checks any of that.
type ActionCtx struct {
	Pool *pgxpool.Pool
	Hub  *hub.Hub
	// Broadcast pushes a fresh envelope to everyone watching the session.
	Broadcast func(ctx context.Context, sessionID string)
	Session   store.Session
	UserID    string
}

// ActionFunc handles one action. It owns the response body and status.
type ActionFunc func(w http.ResponseWriter, r *http.Request, ac ActionCtx)

// Action is one entry in a kind's dispatch table.
type Action struct {
	// Verb is the HTTP method this action answers, and the only one it
	// answers. Most actions are transitions and take POST; an upsert of the
	// caller's own row takes PUT and a partial edit takes PATCH, because the
	// verb is the only place a client can read that idempotency from.
	Verb string
	Do   ActionFunc
	// FacilitatorOnly restricts the action to the session's facilitator.
	FacilitatorOnly bool
}

// Action looks up one action of one kind. Two kinds may use the same action
// name without colliding: the lookup is scoped by the session's own kind, so
// there is no shared action namespace to collide in.
func (r *Registry) Action(kind, name string) (Action, bool) {
	k, ok := r.kinds[kind]
	if !ok {
		return Action{}, false
	}
	a, ok := k.Actions[name]
	if !ok || a.Do == nil || a.Verb == "" {
		return Action{}, false
	}
	return a, true
}
