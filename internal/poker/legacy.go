package poker

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// This file keeps the two pre-dispatcher story routes — PATCH /stories/{id}
// and POST /stories/{id}/vote — alive for one release. They carry the story in
// the path instead of the body, so they cannot go through the core dispatcher,
// which keys everything off /sessions/{id}: they resolve the session from the
// story and then run the same member and ended-session checks themselves.
// Delete this file, and Handler with it, when the aliases expire; the actions
// in routes.go are the real routes.

type Handler struct {
	pool      *pgxpool.Pool
	hub       *hub.Hub
	presence  *store.Presence
	sessions  *store.Sessions
	broadcast func(ctx context.Context, sessionID string)
}

func New(pool *pgxpool.Pool, h *hub.Hub, presence *store.Presence, broadcast func(ctx context.Context, sessionID string)) *Handler {
	return &Handler{pool: pool, hub: h, presence: presence, sessions: &store.Sessions{Pool: pool}, broadcast: broadcast}
}

// MountLegacyStories attaches the deprecated story-scoped routes to an /api
// router that already runs resolvePrincipal.
func (h *Handler) MountLegacyStories(r chi.Router) {
	r.Patch("/stories/{id}", h.withStory(func(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, storyID string) {
		var body patchBody
		if !decode(w, r, &body) {
			return
		}
		applyPatch(w, r, ac, storyID, body)
	}))
	r.Post("/stories/{id}/vote", h.withStory(func(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, storyID string) {
		var body voteBody
		if !decode(w, r, &body) {
			return
		}
		castVote(w, r, ac, storyID, body.Value)
	}))
}

// withStory resolves the story's own session — the binding the dispatcher gets
// from the URL — then applies the same ladder the dispatcher applies: member
// of the space, and the session not ended.
func (h *Handler) withStory(fn func(http.ResponseWriter, *http.Request, session.ActionCtx, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		storyID := chi.URLParam(r, "id")
		var sessionID string
		if err := h.pool.QueryRow(r.Context(),
			"select session_id::text from stories where id = $1", storyID).Scan(&sessionID); err != nil {
			http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
			return
		}
		p, ok := principal.From(r.Context())
		if !ok {
			http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
			return
		}
		sess, err := h.sessions.ByID(r.Context(), sessionID)
		if err != nil {
			http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
			return
		}
		member, err := (&store.Spaces{Pool: h.pool}).IsMember(r.Context(), sess.SpaceID, p.UserID)
		if err != nil || !member {
			http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
			return
		}
		if sess.EndedAt != nil {
			http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
			return
		}
		fn(w, r, session.ActionCtx{
			Presence:  h.presence,
			Pool:      h.pool,
			Hub:       h.hub,
			Broadcast: h.broadcast,
			Session:   sess,
			UserID:    p.UserID,
		}, storyID)
	}
}
