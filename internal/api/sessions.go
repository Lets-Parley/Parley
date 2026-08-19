package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

// broadcastState rebuilds the envelope and pushes it to every connection in the
// room. Handlers call it after any mutation.
func (a *app) broadcastState(ctx context.Context, sessionID string) {
	env, err := a.kinds.BuildEnvelope(ctx, a.pool, a.hub, a.sessions, sessionID)
	if err != nil {
		slog.Error("could not build session state for broadcast", "session", sessionID, "error", err)
		return
	}
	payload, err := json.Marshal(env)
	if err != nil {
		slog.Error("could not marshal session state", "session", sessionID, "error", err)
		return
	}
	a.hub.Broadcast(sessionID, payload)
}

func (a *app) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	sp, err := a.spaces.BySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID)
	if err != nil || !member {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}

	var body struct {
		Kind   string          `json:"kind"`
		Title  string          `json:"title"`
		Config json.RawMessage `json:"config"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || len(title) > 200 {
		http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
		return
	}
	if !a.kinds.Known(body.Kind) {
		http.Error(w, `{"error":"kind must be poker or standup"}`, http.StatusBadRequest)
		return
	}
	config, err := a.kinds.ParseConfig(body.Kind, body.Config)
	if err != nil {
		http.Error(w, `{"error":"invalid config for this session kind"}`, http.StatusBadRequest)
		return
	}

	sess, err := a.sessions.Create(r.Context(), sp.ID, body.Kind, title, config, p.UserID, a.limits.SessionsPerSpace)
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, `{"error":"session limit reached for this space"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create session"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, sess)
}

func (a *app) handleGetSession(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	env, err := a.kinds.BuildEnvelope(r.Context(), a.pool, a.hub, a.sessions, sess.ID)
	if err != nil {
		http.Error(w, `{"error":"could not load session"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, env)
}

// handleCloseSession is idempotent: closing an already-closed session is a
// no-op 204 rather than a conflict, so a retried or double-clicked DELETE
// never reports an error for work that already landed. That is why this route
// sits outside the rejectEnded group — the no-write-on-an-ended-session
// invariant is kept here instead, by skipping the write.
func (a *app) handleCloseSession(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())
	if err := a.sessions.SetEnded(r.Context(), sess.ID, p.UserID, true); errors.Is(err, store.ErrNotFacilitator) {
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
		return
	} else if err != nil {
		http.Error(w, `{"error":"could not close session"}`, http.StatusInternalServerError)
		return
	}
	a.broadcastState(r.Context(), sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleReopenSession(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())
	if err := a.sessions.SetEnded(r.Context(), sess.ID, p.UserID, false); errors.Is(err, store.ErrNotFacilitator) {
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
		return
	} else if err != nil {
		http.Error(w, `{"error":"could not reopen session"}`, http.StatusInternalServerError)
		return
	}
	a.broadcastState(r.Context(), sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleTransferFacilitator(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())
	var body struct {
		UserID string `json:"userId"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"userId is required"}`)
		return
	}
	if body.UserID == "" {
		http.Error(w, `{"error":"userId is required"}`, http.StatusBadRequest)
		return
	}
	if body.UserID == sess.FacilitatorID {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	err := a.sessions.TransferFacilitator(r.Context(), sess.ID, p.UserID, body.UserID)
	if errors.Is(err, store.ErrNotFacilitator) {
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
		return
	}
	if errors.Is(err, store.ErrNotEligible) {
		http.Error(w, `{"error":"that person is not a member of this space"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not transfer facilitator"}`, http.StatusInternalServerError)
		return
	}
	a.broadcastState(r.Context(), sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleClaimFacilitator(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())

	err := a.sessions.ClaimFacilitator(r.Context(), sess.ID, p.UserID)
	if errors.Is(err, store.ErrNotEligible) {
		http.Error(w, `{"error":"the facilitator is still here — the role can be claimed after they have been gone a minute"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not claim facilitator"}`, http.StatusInternalServerError)
		return
	}
	a.broadcastState(r.Context(), sess.ID)
	w.WriteHeader(http.StatusNoContent)
}

// handleSetSpectator toggles the caller's own spectator flag in the session's
// space. Spectating is a property of a member, not of a kind — poker hides
// their vote, standup leaves them out of the round — so it is a core route
// rather than one kind's action.
func (a *app) handleSetSpectator(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	p, _ := PrincipalFrom(r.Context())
	var body struct {
		On bool `json:"on"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	err := a.sessions.WithActiveSession(r.Context(), sess.ID, p.UserID, false,
		func(tx pgx.Tx, locked store.Session) error {
			if _, err := tx.Exec(r.Context(),
				"update members set spectator = $3 where space_id = $1 and user_id = $2",
				locked.SpaceID, p.UserID, body.On); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", locked.ID)
			return err
		})
	if errors.Is(err, store.ErrSessionEnded) {
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not update spectator mode"}`, http.StatusInternalServerError)
		return
	}
	a.broadcastState(r.Context(), sess.ID)
	w.WriteHeader(http.StatusNoContent)
}
