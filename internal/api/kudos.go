package api

import (
	"errors"
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
	w.WriteHeader(http.StatusNoContent)
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
