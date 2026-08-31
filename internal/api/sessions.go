package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// broadcastState pushes the new state to this replica's clients and tells the
// other replicas to do the same. Handlers call it after any mutation.
func (a *app) broadcastState(ctx context.Context, sessionID string) {
	a.broadcastLocal(ctx, sessionID)
	a.notify(ctx, sessionID)
}

// broadcastLocal rebuilds the envelope and pushes it to every connection held
// by THIS replica. It deliberately does not notify: it is also what the
// notification listener calls, and a replica that re-notified on every message
// it received would keep the whole cluster talking forever.
func (a *app) broadcastLocal(ctx context.Context, sessionID string) {
	env, err := a.kinds.BuildEnvelope(ctx, a.pool, a.presence, a.sessions, sessionID)
	// The room is gone — deleted outright, or cascaded away with its space.
	// Every replica reaches this through the same notification, so this one
	// branch closes the sockets cluster-wide. Nothing else would: unlike a
	// removed member, a deleted room leaves no membership row whose absence
	// the revalidation tick could notice.
	if errors.Is(err, store.ErrNoSession) {
		a.hub.DisconnectSession(sessionID)
		return
	}
	if err != nil {
		slog.Error("could not build session state for broadcast", "session", sessionID, "error", err)
		return
	}
	payload, err := json.Marshal(env)
	if err != nil {
		slog.Error("could not marshal session state", "session", sessionID, "error", err)
		return
	}
	// One room, two audiences: a link guest gets the redacted envelope. The
	// guest payload is built even when nobody in the room is one — the hub
	// owns the connections, and asking it first would be a second round trip
	// through its event loop for every broadcast.
	guestPayload, err := json.Marshal(env.RedactForGuest(""))
	if err != nil {
		slog.Error("could not marshal redacted session state", "session", sessionID, "error", err)
		return
	}
	a.hub.BroadcastGuest(sessionID, payload, guestPayload)
}

// unknownKindMessage names the kinds the server actually has registered, so
// adding a kind cannot leave the message behind.
func unknownKindMessage(kinds *session.Registry) string {
	return "kind must be one of " + strings.Join(kinds.Names(), ", ")
}

func (a *app) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	sp, err := a.spaces.BySlug(r.Context(), orgFrom(r.Context()).ID, chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID)
	if err != nil {
		slog.Error("checking space membership", "space", sp.ID, "error", err)
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if !member {
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
	if title == "" || utf8.RuneCountInString(title) > 200 {
		http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
		return
	}
	if !a.kinds.Known(body.Kind) {
		http.Error(w, `{"error":"`+unknownKindMessage(a.kinds)+`"}`, http.StatusBadRequest)
		return
	}
	config, err := a.kinds.ParseConfig(body.Kind, body.Config)
	if err != nil {
		http.Error(w, `{"error":"invalid config for this session kind"}`, http.StatusBadRequest)
		return
	}

	sess, err := a.sessions.Create(r.Context(), sp.ID, body.Kind, title, config, p.UserID, a.limits.SessionsPerSpace)
	if errors.Is(err, store.ErrKindRetired) {
		http.Error(w, `{"error":"that session kind has been retired"}`, http.StatusBadRequest)
		return
	}
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, `{"error":"session limit reached for this space"}`, http.StatusConflict)
		return
	}
	// A kind registered in Go but never seeded into session_kinds passes
	// Known() and only fails here, on the foreign key. That is the one step of
	// the add-a-kind checklist a contributor can skip, so name it rather than
	// serving a generic 500.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" && pgErr.ConstraintName == "sessions_kind_fkey" {
		http.Error(w, `{"error":"that session kind is missing its session_kinds row"}`, http.StatusBadRequest)
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
	env, err := a.kinds.BuildEnvelope(r.Context(), a.pool, a.presence, a.sessions, sess.ID)
	if err != nil {
		http.Error(w, `{"error":"could not load session"}`, http.StatusInternalServerError)
		return
	}
	if p, ok := PrincipalFrom(r.Context()); ok && p.IsLinkGuest() {
		env = env.RedactForGuest(p.UserID)
	}
	writeJSON(w, http.StatusOK, env)
}

// handleCloseSession is idempotent: closing an already-closed session is a
// no-op 204 rather than a conflict, so a retried or double-clicked DELETE
// never reports an error for work that already landed. That is why this route
// sits outside the rejectEnded group — the no-write-on-an-ended-session
// invariant is kept in the store instead: the update carries an `ended_at is
// null` predicate, so the second DELETE matches no row and changes nothing.
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

// handleRemoveParticipant ejects one person from THIS room. It is deliberately
// much smaller than the space-level removal next to it: the session_presence
// row goes and their sockets for this room close, but their space membership is
// untouched and they may walk back in through the same link. Reversible by
// design — blocking a rejoin would need a persisted per-session blocklist.
//
// The facilitator's optional message rides the close frame rather than a frame
// of its own: by the time it would arrive the recipient is no longer a session
// member, and every route that could have carried it would refuse them.
func (a *app) handleRemoveParticipant(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())
	target := chi.URLParam(r, "userId")

	var body struct {
		Message string `json:"message"`
	}
	// The message is optional, so an empty body is not an error.
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil && !errors.Is(err, io.EOF) {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}

	if target == "" {
		http.Error(w, `{"error":"userId is required"}`, http.StatusBadRequest)
		return
	}
	if target == p.UserID {
		http.Error(w, `{"error":"you cannot remove yourself — leave the room instead"}`, http.StatusBadRequest)
		return
	}
	// The role, not the caller. requireFacilitator has already established
	// that the caller holds the role, so this is unreachable today and the
	// guard above catches the same request first; it stays so the rule
	// survives any future route that admits a second privileged caller.
	if target == sess.FacilitatorID {
		http.Error(w, `{"error":"the facilitator cannot be removed — hand the role on first"}`, http.StatusBadRequest)
		return
	}

	// Truncated here so the same bounded value reaches all three consumers:
	// the close frame, the local hub call and the cross-replica notify
	// payload. pg_notify refuses a payload over 8000 bytes, and that failure
	// is best-effort — an untruncated message would leave every other replica
	// never hearing about the removal at all. The hub truncates again for its
	// own close frame; that defence is independent of this one and neither
	// relies on the other.
	body.Message = hub.TruncateCloseReason(body.Message)

	// An open round that is still waiting for the person being ejected could
	// never complete: their vote can no longer arrive. Drop them from the
	// expected voters and let the kind re-check completion in the same
	// transaction, exactly as the spectator toggle does. The vote they had
	// already cast stays, and still counts.
	//
	// The presence clear rides the same transaction. WithActiveSession commits
	// internally, so doing it afterwards would leave a window where the round
	// is durably pruned — and possibly already auto-revealed — for somebody
	// who is in fact still connected. A retry re-runs the prune harmlessly but
	// cannot undo a reveal that has already fired.
	connected, err := a.presence.InSession(r.Context(), sess.ID)
	if err != nil {
		slog.Error("could not read presence for a participant removal", "session", sess.ID, "error", err)
		connected = nil
	}
	connected = slices.DeleteFunc(connected, func(id string) bool { return id == target })
	err = a.sessions.WithActiveSession(r.Context(), sess.ID, p.UserID, false,
		func(tx pgx.Tx, locked store.Session) error {
			if err := a.presence.GoneTx(r.Context(), tx, locked.ID, target); err != nil {
				return fmt.Errorf("clearing presence for the removed participant: %w", err)
			}
			if _, err := tx.Exec(r.Context(), `
				delete from round_voters rv
				using stories st
				where rv.story_id = st.id and rv.user_id = $1 and st.session_id = $2`,
				target, locked.ID); err != nil {
				return fmt.Errorf("dropping the removed participant from open rounds: %w", err)
			}
			if changed, ok := a.kinds.RosterChanged(locked.Kind); ok {
				return changed(r.Context(), tx, locked, connected)
			}
			return nil
		})
	if errors.Is(err, store.ErrSessionEnded) {
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
		return
	}
	if err != nil {
		slog.Error("could not remove a participant from the room",
			"session", sess.ID, "user", target, "error", err)
		http.Error(w, `{"error":"could not remove that person"}`, http.StatusInternalServerError)
		return
	}

	a.hub.DisconnectSessionMember(sess.ID, target, body.Message)
	a.notifyParticipantRemoved(r.Context(), sess.ID, target, body.Message)
	// Belt and braces: dropping the connection above already fires
	// OnPresenceChange, which broadcasts the new envelope on its own, so this
	// is not the only path to it. It stays for the case where the person held
	// no socket on this replica and nothing else here would announce the
	// roster change.
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
	// Read before the transaction, for the same reason the vote path does: the
	// kind's hook may need the connected set, and reading it under the session
	// row lock would hold that lock across another query for no reason.
	connected, err := a.presence.InSession(r.Context(), sess.ID)
	if err != nil {
		slog.Error("could not read presence for a spectator toggle", "session", sess.ID, "error", err)
		connected = nil
	}

	err = a.sessions.WithActiveSession(r.Context(), sess.ID, p.UserID, false,
		func(tx pgx.Tx, locked store.Session) error {
			if _, err := tx.Exec(r.Context(),
				"update members set spectator = $3 where space_id = $1 and user_id = $2",
				locked.SpaceID, p.UserID, body.On); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", locked.ID); err != nil {
				return err
			}
			// Sitting out can be the last thing a round was waiting for, and
			// sitting back down restores the wait. The kind decides what that
			// means; the core just says the roster moved.
			if changed, ok := a.kinds.RosterChanged(locked.Kind); ok {
				return changed(r.Context(), tx, locked, connected)
			}
			return nil
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
