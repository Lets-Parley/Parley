package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

// kudoBody is a kudo as a member submits it. There is no "from": the sender is
// whoever is holding the cookie.
type kudoBody struct {
	To   string `json:"to"`
	Text string `json:"text"`
}

// maxKudoRunes matches the check in 0033_kudos.sql. The SQL is the backstop:
// without this check a 281-character kudo reaches Postgres, trips the
// constraint and comes back as a 500 that tells the caller nothing.
const maxKudoRunes = 280

func (a *app) handleListKudos(w http.ResponseWriter, r *http.Request) {
	// The cursor is the last row's createdAt, sent back verbatim, and its id.
	var before time.Time
	q := r.URL.Query()
	if q.Has("waiting") {
		a.listWaitingKudos(w, r)
		return
	}
	beforeID := q.Get("beforeId")
	if q.Has("before") || q.Has("beforeId") {
		var err error
		before, err = time.Parse(time.RFC3339Nano, q.Get("before"))
		if err != nil || beforeID == "" {
			http.Error(w, `{"error":"before and beforeId must be given together, as a timestamp and a kudo id"}`, http.StatusBadRequest)
			return
		}
	}
	kudos, err := a.kudos.ListForSpace(r.Context(), spaceFrom(r.Context()).ID, before, beforeID)
	if errors.Is(err, store.ErrBadCursor) {
		http.Error(w, `{"error":"beforeId is not a kudo id"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load kudos"}`, http.StatusInternalServerError)
		return
	}
	// unread goes to the recipient alone. Everyone else gets no key at all —
	// a false would tell the sender their kudo was read.
	p, _ := PrincipalFrom(r.Context())
	out := make([]kudoView, len(kudos))
	for i, k := range kudos {
		out[i] = kudoView{Kudo: k}
		if k.ToUserID == p.UserID {
			out[i].Unread = &kudos[i].Unread
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// listWaitingKudos is ?waiting=1: the caller's own unread kudos in this space,
// newest first, whatever page of the wall they sit on. It is not a page of the
// wall, so it takes no cursor.
func (a *app) listWaitingKudos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("waiting") != "1" || q.Has("before") || q.Has("beforeId") {
		http.Error(w, `{"error":"waiting takes the value 1 and no cursor"}`, http.StatusBadRequest)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	kudos, err := a.kudos.WaitingFor(r.Context(), spaceFrom(r.Context()).ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load kudos"}`, http.StatusInternalServerError)
		return
	}
	out := make([]kudoView, len(kudos))
	for i, k := range kudos {
		out[i] = kudoView{Kudo: k, Unread: &kudos[i].Unread}
	}
	writeJSON(w, http.StatusOK, out)
}

type kudoView struct {
	store.Kudo
	Unread *bool `json:"unread,omitempty"`
}

// handleSeenKudo is the recipient putting a letter with the others. Like
// withdraw, the row is read first so another space's id is a 404 and a
// caller who is not the recipient is a 403.
func (a *app) handleSeenKudo(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	space := spaceFrom(r.Context()).ID
	kudo, err := a.kudos.Get(r.Context(), space, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"no such kudo"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not mark kudo seen"}`, http.StatusInternalServerError)
		return
	}
	if kudo.ToUserID != p.UserID {
		http.Error(w, `{"error":"only the recipient can mark a kudo seen"}`, http.StatusForbidden)
		return
	}
	// A kudo withdrawn in between is gone either way; nothing left to read.
	if err := a.kudos.MarkSeen(r.Context(), space, kudo.ID, p.UserID); err != nil && !errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"could not mark kudo seen"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleGiveKudo(w http.ResponseWriter, r *http.Request) {
	var body kudoBody
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || utf8.RuneCountInString(text) > maxKudoRunes {
		http.Error(w, `{"error":"a kudo is between 1 and 280 characters"}`, http.StatusBadRequest)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	kudo, err := a.kudos.Create(r.Context(), spaceFrom(r.Context()).ID, p.UserID, body.To, text, "", a.limits.KudosPerSpace)
	if writeKudoError(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, kudo)
}

// handleWithdrawKudo removes a kudo the caller sent. The store's Delete is
// scoped by sender alone and answers "not there" and "not yours" with one
// error, so the row is read back first: that scopes the delete to this space —
// an id from another space is a 404 here, not a silent cross-space delete —
// and it tells a 403 from a 404, which one sentinel cannot.
func (a *app) handleWithdrawKudo(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	id := chi.URLParam(r, "id")

	kudo, err := a.kudos.Get(r.Context(), spaceFrom(r.Context()).ID, id)
	if errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"no such kudo"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not withdraw kudo"}`, http.StatusInternalServerError)
		return
	}
	if kudo.FromUserID != p.UserID {
		http.Error(w, `{"error":"only the sender can withdraw a kudo"}`, http.StatusForbidden)
		return
	}
	// A racing withdrawal of the same kudo leaves it gone either way, which is
	// what the caller asked for.
	if err := a.kudos.Delete(r.Context(), id, p.UserID); err != nil && !errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"could not withdraw kudo"}`, http.StatusInternalServerError)
		return
	}
	a.refreshKudoRoom(r.Context(), kudo)
	w.WriteHeader(http.StatusNoContent)
}

// handleAnswerKudo is the recipient's one line back. Read first, like
// withdraw, so another space's id is a 404 and anyone but the recipient a 403.
// There is no edit: an answered kudo is a 409 until the answer is withdrawn.
func (a *app) handleAnswerKudo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	kudo, ok := a.recipientsKudo(w, r)
	if !ok {
		return
	}
	p, _ := PrincipalFrom(r.Context())
	switch err := a.kudos.Answer(r.Context(), spaceFrom(r.Context()).ID, kudo.ID, p.UserID, body.Text); {
	case err == nil:
		a.refreshKudoRoom(r.Context(), kudo)
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrBadAnswer):
		http.Error(w, `{"error":"an answer is between 1 and 80 characters"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrAnswered):
		http.Error(w, `{"error":"this kudo already has an answer; withdraw it first"}`, http.StatusConflict)
	case errors.Is(err, store.ErrNoKudo):
		// Withdrawn by its sender while this request was in flight.
		http.Error(w, `{"error":"no such kudo"}`, http.StatusNotFound)
	default:
		http.Error(w, `{"error":"could not save your answer"}`, http.StatusInternalServerError)
	}
}

// handleUnanswerKudo withdraws the recipient's answer.
func (a *app) handleUnanswerKudo(w http.ResponseWriter, r *http.Request) {
	kudo, ok := a.recipientsKudo(w, r)
	if !ok {
		return
	}
	p, _ := PrincipalFrom(r.Context())
	// A kudo withdrawn in between took the answer with it.
	if err := a.kudos.Unanswer(r.Context(), spaceFrom(r.Context()).ID, kudo.ID, p.UserID); err != nil && !errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"could not withdraw your answer"}`, http.StatusInternalServerError)
		return
	}
	a.refreshKudoRoom(r.Context(), kudo)
	w.WriteHeader(http.StatusNoContent)
}

// refreshKudoRoom tells the standup a kudo was given in that it changed on the
// wall, so an open room's closing list is not left offering to answer a kudo
// that is already answered or gone. It bumps the room's version, which is what
// makes a client take the new envelope, and broadcasts it. Only a live room is
// touched; a kudo given on the wall has no room at all.
//
// Best-effort, like notify: the write the caller asked for has already been
// made, so a failure here costs the room one refresh — its own answer action
// still refuses a stale send — rather than failing a successful answer.
func (a *app) refreshKudoRoom(ctx context.Context, kudo store.Kudo) {
	if kudo.SessionID == "" {
		return
	}
	bumped, err := a.sessions.BumpLiveVersion(ctx, kudo.SessionID)
	if err != nil {
		slog.Error("could not refresh the room a kudo was given in", "session", kudo.SessionID, "error", err)
		return
	}
	if bumped {
		a.broadcastState(ctx, kudo.SessionID)
	}
}

// recipientsKudo reads the {id} kudo in this space and answers 404 or 403
// itself unless the caller is its recipient.
func (a *app) recipientsKudo(w http.ResponseWriter, r *http.Request) (store.Kudo, bool) {
	p, _ := PrincipalFrom(r.Context())
	kudo, err := a.kudos.Get(r.Context(), spaceFrom(r.Context()).ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNoKudo) {
		http.Error(w, `{"error":"no such kudo"}`, http.StatusNotFound)
		return kudo, false
	}
	if err != nil {
		http.Error(w, `{"error":"could not load kudo"}`, http.StatusInternalServerError)
		return kudo, false
	}
	if kudo.ToUserID != p.UserID {
		http.Error(w, `{"error":"only the recipient can answer a kudo"}`, http.StatusForbidden)
		return kudo, false
	}
	return kudo, true
}

// writeKudoError turns the store's refusals into answers a client can act on
// and reports whether it wrote one. A recipient who is not on the roster — an
// outsider or a link guest — is the caller's mistake, not the server's, so it
// lands as a 400 rather than the 500 a raw pg error would produce.
func writeKudoError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrSelfKudo):
		http.Error(w, `{"error":"a kudo cannot be sent to yourself"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrNotAMember):
		http.Error(w, `{"error":"a kudo can only be sent to a member of this space"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrQuotaExceeded):
		http.Error(w, `{"error":"kudo limit reached for this space"}`, http.StatusConflict)
	default:
		http.Error(w, `{"error":"could not save kudo"}`, http.StatusInternalServerError)
	}
	return true
}
