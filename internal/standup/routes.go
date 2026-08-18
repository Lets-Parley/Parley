package standup

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/store"
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

func (h *Handler) Mount(r chi.Router) {
	r.Put("/sessions/{id}/standup", h.withSession(h.putEntry, false))
	r.Post("/sessions/{id}/start", h.withSession(h.start, true))
	r.Post("/sessions/{id}/next", h.withSession(h.next, true))
	r.Post("/sessions/{id}/skip", h.withSession(h.skip, true))
}

type reqCtx struct {
	principal principal.Principal
	sess      store.Session
}

func (h *Handler) withSession(fn func(http.ResponseWriter, *http.Request, reqCtx), facilitatorOnly bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal.From(r.Context())
		if !ok {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		sess, err := h.sessions.ByID(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		spaces := &store.Spaces{Pool: h.pool}
		member, err := spaces.IsMember(r.Context(), sess.SpaceID, p.UserID)
		if err != nil || !member {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		if facilitatorOnly && sess.FacilitatorID != p.UserID {
			http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
			return
		}
		if sess.EndedAt != nil {
			http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
			return
		}
		fn(w, r, reqCtx{principal: p, sess: sess})
	}
}

func (h *Handler) done(w http.ResponseWriter, r *http.Request, sessionID string) {
	h.sessions.BumpVersion(r.Context(), sessionID)
	h.broadcast(r.Context(), sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) putEntry(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	var body struct {
		Yesterday string `json:"yesterday"`
		Today     string `json:"today"`
		Blockers  string `json:"blockers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if len(body.Yesterday) > 2000 || len(body.Today) > 2000 || len(body.Blockers) > 2000 {
		http.Error(w, `{"error":"each field can be at most 2000 characters"}`, http.StatusBadRequest)
		return
	}
	_, err := h.pool.Exec(r.Context(), `
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		values ($1, $2, $3, $4, $5,
		        (select coalesce(max(position), 0) + 1 from standup_entries where session_id = $1))
		on conflict (session_id, user_id) do update
		set yesterday = excluded.yesterday, today = excluded.today,
		    blockers = excluded.blockers, updated_at = now()`,
		rc.sess.ID, rc.principal.UserID, body.Yesterday, body.Today, body.Blockers)
	if err != nil {
		http.Error(w, `{"error":"could not save your update"}`, http.StatusInternalServerError)
		return
	}
	h.done(w, r, rc.sess.ID)
}

// start snapshots the round-robin roster: connected non-spectator members, in
// roster order. Carry-forward: each person's "yesterday" is prefilled with the
// "today" they wrote in this space's most recent previous standup.
func (h *Handler) start(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	connected := h.hub.Connected(rc.sess.ID)
	if len(connected) == 0 {
		http.Error(w, `{"error":"nobody is connected yet — open the session first"}`, http.StatusConflict)
		return
	}
	_, err := h.pool.Exec(r.Context(), `
		insert into standup_entries (session_id, user_id, yesterday, position)
		select $1, m.user_id,
		       coalesce((
		           select prev.today from standup_entries prev
		           join sessions ps on ps.id = prev.session_id
		           where prev.user_id = m.user_id and ps.space_id = $2 and ps.id <> $1
		           order by ps.created_at desc limit 1
		       ), ''),
		       row_number() over (order by u.name)
		from members m join users u on u.id = m.user_id
		where m.space_id = $2 and not m.spectator and m.user_id::text = any($3)
		on conflict (session_id, user_id) do nothing`,
		rc.sess.ID, rc.sess.SpaceID, connected)
	if err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}
	h.pool.Exec(r.Context(), `
		update sessions set phase = 'speaking', version = version + 1, speaker_started_at = now(),
		current_speaker_id = (select user_id from standup_entries where session_id = $1 order by position limit 1)
		where id = $1`, rc.sess.ID)
	h.broadcast(r.Context(), rc.sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) advance(w http.ResponseWriter, r *http.Request, rc reqCtx, markSkipped bool) {
	if markSkipped {
		h.pool.Exec(r.Context(), `
			update standup_entries set skipped = true
			where session_id = $1 and user_id = (select current_speaker_id from sessions where id = $1)`,
			rc.sess.ID)
	}
	// Next entry after the current speaker's position; none left → done.
	tag, _ := h.pool.Exec(r.Context(), `
		update sessions set version = version + 1, speaker_started_at = now(),
		current_speaker_id = (
		    select e.user_id from standup_entries e
		    where e.session_id = $1 and e.position > coalesce((
		        select position from standup_entries
		        where session_id = $1 and user_id = sessions.current_speaker_id), 0)
		    order by e.position limit 1)
		where id = $1 and phase = 'speaking'`, rc.sess.ID)
	if tag.RowsAffected() == 0 {
		http.Error(w, `{"error":"the standup has not started"}`, http.StatusConflict)
		return
	}
	h.pool.Exec(r.Context(), `
		update sessions set phase = 'done', speaker_started_at = null
		where id = $1 and current_speaker_id is null`, rc.sess.ID)
	h.broadcast(r.Context(), rc.sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) next(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	h.advance(w, r, rc, false)
}

func (h *Handler) skip(w http.ResponseWriter, r *http.Request, rc reqCtx) {
	h.advance(w, r, rc, true)
}
