package poker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/hub"
	"github.com/jacorbello/parley/internal/principal"
	"github.com/jacorbello/parley/internal/store"
)

type Handler struct {
	pool      *pgxpool.Pool
	hub       *hub.Hub
	sessions  *store.Sessions
	broadcast func(ctx context.Context, sessionID string)
}

func New(pool *pgxpool.Pool, h *hub.Hub, broadcast func(ctx context.Context, sessionID string)) *Handler {
	return &Handler{pool: pool, hub: h, sessions: &store.Sessions{Pool: pool}, broadcast: broadcast}
}

// Mount attaches the poker routes to an /api router that already runs
// resolvePrincipal. Authorization is re-checked here per request.
func (h *Handler) Mount(r chi.Router) {
	r.Post("/sessions/{id}/stories", h.withSession(h.addStory, false))
	r.Post("/sessions/{id}/select", h.withSession(h.selectStory, true))
	r.Post("/sessions/{id}/reveal", h.withSession(h.reveal, true))
	r.Post("/sessions/{id}/reset", h.withSession(h.reset, true))
	r.Post("/sessions/{id}/spectator", h.withSession(h.setSpectator, false))
	r.Patch("/stories/{id}", h.withStory(h.patchStory))
	r.Post("/stories/{id}/vote", h.withStory(h.vote))
}

type reqCtx struct {
	principal principal.Principal
	sess      store.Session
	storyID   string
}

func (h *Handler) authorize(r *http.Request, sessionID string) (reqCtx, int) {
	p, ok := principal.From(r.Context())
	if !ok {
		return reqCtx{}, http.StatusNotFound
	}
	sess, err := h.sessions.ByID(r.Context(), sessionID)
	if err != nil {
		return reqCtx{}, http.StatusNotFound
	}
	spaces := &store.Spaces{Pool: h.pool}
	member, err := spaces.IsMember(r.Context(), sess.SpaceID, p.UserID)
	if err != nil || !member {
		return reqCtx{}, http.StatusNotFound
	}
	return reqCtx{principal: p, sess: sess}, 0
}

func (h *Handler) withSession(fn func(http.ResponseWriter, *http.Request, reqCtx), facilitatorOnly bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rc, code := h.authorize(r, chi.URLParam(r, "id"))
		if code != 0 {
			http.Error(w, `{"error":"no such session"}`, code)
			return
		}
		if facilitatorOnly && rc.sess.FacilitatorID != rc.principal.UserID {
			http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
			return
		}
		if rc.sess.EndedAt != nil {
			http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
			return
		}
		fn(w, r, rc)
	}
}

func (h *Handler) withStory(fn func(http.ResponseWriter, *http.Request, reqCtx)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		storyID := chi.URLParam(r, "id")
		var sessionID string
		err := h.pool.QueryRow(r.Context(),
			"select session_id::text from stories where id = $1", storyID).Scan(&sessionID)
		if errors.Is(err, pgx.ErrNoRows) || err != nil {
			http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
			return
		}
		rc, code := h.authorize(r, sessionID)
		if code != 0 {
			http.Error(w, `{"error":"no such story"}`, code)
			return
		}
		if rc.sess.EndedAt != nil {
			http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
			return
		}
		rc.storyID = storyID
		fn(w, r, rc)
	}
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(into); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return false
	}
	return true
}

func (h *Handler) done(w http.ResponseWriter, r *http.Request, sessionID string) {
	h.sessions.BumpVersion(r.Context(), sessionID)
	h.broadcast(r.Context(), sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) addStory(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		Title string `json:"title"`
		Notes string `json:"notes"`
		Ref   string `json:"ref"`
	}
	if !decode(w, r, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	ref := strings.TrimSpace(body.Ref)
	if title == "" || len(title) > 200 || len(body.Notes) > 2000 {
		http.Error(w, `{"error":"title must be 1-200 characters, notes at most 2000"}`, http.StatusBadRequest)
		return
	}
	if len(ref) > 40 {
		http.Error(w, `{"error":"a ticket reference can be at most 40 characters"}`, http.StatusBadRequest)
		return
	}
	_, err := h.pool.Exec(r.Context(), `
		insert into stories (session_id, title, notes, ref, position)
		values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from stories where session_id = $1))`,
		rc.sess.ID, title, body.Notes, ref)
	if err != nil {
		http.Error(w, `{"error":"could not add story"}`, http.StatusInternalServerError)
		return
	}
	h.done(w, r, rc.sess.ID)
}

func (h *Handler) patchStory(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		Title    *string  `json:"title"`
		Notes    *string  `json:"notes"`
		Ref      *string  `json:"ref"`
		Position *float64 `json:"position"`
		Estimate *string  `json:"estimate"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Title != nil {
		t := strings.TrimSpace(*body.Title)
		if t == "" || len(t) > 200 {
			http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
			return
		}
		h.pool.Exec(r.Context(), "update stories set title = $2 where id = $1", rc.storyID, t)
	}
	if body.Notes != nil {
		if len(*body.Notes) > 2000 {
			http.Error(w, `{"error":"notes can be at most 2000 characters"}`, http.StatusBadRequest)
			return
		}
		h.pool.Exec(r.Context(), "update stories set notes = $2 where id = $1", rc.storyID, *body.Notes)
	}
	if body.Ref != nil {
		ref := strings.TrimSpace(*body.Ref)
		if len(ref) > 40 {
			http.Error(w, `{"error":"a ticket reference can be at most 40 characters"}`, http.StatusBadRequest)
			return
		}
		h.pool.Exec(r.Context(), "update stories set ref = $2 where id = $1", rc.storyID, ref)
	}
	if body.Position != nil {
		h.pool.Exec(r.Context(), "update stories set position = $2 where id = $1", rc.storyID, *body.Position)
	}
	if body.Estimate != nil {
		// An estimate has to be a card from this session's deck. Without the
		// check, whatever the client happened to be rendering — a placeholder
		// dash, the coffee glyph — becomes the story's permanent estimate and
		// travels on into the CSV export.
		est := strings.TrimSpace(*body.Estimate)
		if est == "" {
			// An empty estimate is a clear, not an estimate of nothing.
			h.pool.Exec(r.Context(),
				"update stories set estimate = null, status = 'pending' where id = $1", rc.storyID)
		} else {
			var cfg Config
			json.Unmarshal(rc.sess.Config, &cfg)
			deck, ok := DeckByName(cfg.Deck)
			if !ok {
				deck, _ = DeckByName("fibonacci")
			}
			if !deck.Has(est) || isSpecial(est) {
				http.Error(w, `{"error":"an estimate has to be a card from this session's deck"}`, http.StatusBadRequest)
				return
			}
			h.pool.Exec(r.Context(),
				"update stories set estimate = $2, status = 'estimated' where id = $1", rc.storyID, est)
		}
	}
	h.done(w, r, rc.sess.ID)
}

func (h *Handler) selectStory(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		StoryID string `json:"storyId"`
	}
	if !decode(w, r, &body) {
		return
	}
	tag, err := h.pool.Exec(r.Context(), `
		update sessions set current_story_id = $2, revealed = false, version = version + 1
		where id = $1 and exists (select 1 from stories where id = $2 and session_id = $1)`,
		rc.sess.ID, body.StoryID)
	if err != nil || tag.RowsAffected() == 0 {
		http.Error(w, `{"error":"that story is not in this session"}`, http.StatusBadRequest)
		return
	}
	h.pool.Exec(r.Context(),
		"update stories set status = 'voting' where id = $1 and status = 'pending'", body.StoryID)
	h.broadcast(r.Context(), rc.sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) vote(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		Value string `json:"value"`
	}
	if !decode(w, r, &body) {
		return
	}
	if rc.sess.Revealed {
		http.Error(w, `{"error":"votes are revealed — wait for the next round"}`, http.StatusConflict)
		return
	}
	var currentID string
	h.pool.QueryRow(r.Context(),
		"select coalesce(current_story_id::text,'') from sessions where id = $1", rc.sess.ID).Scan(&currentID)
	if currentID != rc.storyID {
		http.Error(w, `{"error":"voting is not open on this story"}`, http.StatusConflict)
		return
	}
	var spectator bool
	if err := h.pool.QueryRow(r.Context(),
		"select spectator from members where space_id = $1 and user_id = $2",
		rc.sess.SpaceID, rc.principal.UserID).Scan(&spectator); err != nil || spectator {
		http.Error(w, `{"error":"spectators cannot vote"}`, http.StatusConflict)
		return
	}
	var cfg Config
	json.Unmarshal(rc.sess.Config, &cfg)
	deck, ok := DeckByName(cfg.Deck)
	if !ok {
		deck, _ = DeckByName("fibonacci")
	}
	if !deck.Has(body.Value) {
		http.Error(w, `{"error":"that vote is not in this session's deck"}`, http.StatusConflict)
		return
	}

	if _, err := h.pool.Exec(r.Context(), `
		insert into votes (story_id, user_id, value) values ($1, $2, $3)
		on conflict (story_id, user_id) do update set value = excluded.value`,
		rc.storyID, rc.principal.UserID, body.Value); err != nil {
		http.Error(w, `{"error":"could not record vote"}`, http.StatusInternalServerError)
		return
	}

	h.maybeAutoReveal(r.Context(), rc.sess, rc.storyID)
	h.done(w, r, rc.sess.ID)
}

// maybeAutoReveal fires only here, on a vote landing — never from presence
// changes, so a disconnect can shrink the denominator but can't reveal.
func (h *Handler) maybeAutoReveal(ctx context.Context, sess store.Session, storyID string) {
	connected := h.hub.Connected(sess.ID)
	if len(connected) == 0 {
		return
	}
	var eligible int
	if err := h.pool.QueryRow(ctx,
		"select count(*) from members where space_id = $1 and not spectator and user_id::text = any($2)",
		sess.SpaceID, connected).Scan(&eligible); err != nil || eligible == 0 {
		return
	}
	var voted int
	if err := h.pool.QueryRow(ctx,
		"select count(*) from votes where story_id = $1", storyID).Scan(&voted); err != nil {
		return
	}
	if voted >= eligible {
		h.pool.Exec(ctx, "update sessions set revealed = true where id = $1 and not revealed", sess.ID)
	}
}

func (h *Handler) reveal(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	h.pool.Exec(r.Context(), "update sessions set revealed = true, version = version + 1 where id = $1", rc.sess.ID)
	h.broadcast(r.Context(), rc.sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) reset(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	h.pool.Exec(r.Context(),
		"delete from votes where story_id = (select current_story_id from sessions where id = $1)", rc.sess.ID)
	h.pool.Exec(r.Context(), "update sessions set revealed = false, version = version + 1 where id = $1", rc.sess.ID)
	h.broadcast(r.Context(), rc.sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) setSpectator(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		On bool `json:"on"`
	}
	if !decode(w, r, &body) {
		return
	}
	h.pool.Exec(r.Context(), "update members set spectator = $3 where space_id = $1 and user_id = $2",
		rc.sess.SpaceID, rc.principal.UserID, body.On)
	h.done(w, r, rc.sess.ID)
}
