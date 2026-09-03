package api

import (
	"errors"
	"net/http"
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
	kudos, err := a.kudos.ListForSpace(r.Context(), spaceFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load kudos"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, kudos)
}

func (a *app) handleGiveKudo(w http.ResponseWriter, r *http.Request) {
	var body kudoBody
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if body.Text == "" || utf8.RuneCountInString(body.Text) > maxKudoRunes {
		http.Error(w, `{"error":"a kudo is between 1 and 280 characters"}`, http.StatusBadRequest)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	kudo, err := a.kudos.Create(r.Context(), spaceFrom(r.Context()).ID, p.UserID, body.To, body.Text, "", a.limits.KudosPerSpace)
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
