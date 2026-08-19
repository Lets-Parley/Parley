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
	// Presence answers "who is in this room" across every replica. Actions must
	// use it rather than Hub, which only sees the clients attached here.
	Presence *store.Presence
	// Broadcast pushes a fresh envelope to everyone watching the session.
	Broadcast func(ctx context.Context, sessionID string)
	Session   store.Session
	UserID    string
}

// ActionFunc handles one action. It owns the response body and status.
type ActionFunc func(w http.ResponseWriter, r *http.Request, ac ActionCtx)

// Action is one entry in a kind's dispatch table.
type Action struct {
	Do ActionFunc
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
	if !ok || a.Do == nil {
		return Action{}, false
	}
	return a, true
}
