package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

// handleCreateSessionLink mints a signed link for this room and answers with
// the plain token. This is the only time it is ever readable: nothing stores
// it, and no list response carries one.
func (a *app) handleCreateSessionLink(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())

	plain, hash := store.NewToken()
	link, err := a.links.Create(r.Context(), sess.ID, p.UserID, hash, time.Now().Add(store.LinkLifetime), a.limits.LinksPerSession)
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, `{"error":"link limit reached for this room"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create the link"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        link.ID,
		"token":     plain,
		"expiresAt": link.ExpiresAt,
	})
}

func (a *app) handleListSessionLinks(w http.ResponseWriter, r *http.Request) {
	links, err := a.links.ListForSession(r.Context(), sessionFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load the links"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": links})
}

// handleRevokeSessionLink is idempotent: revoking a link that is already
// revoked is a 204, so a retried request never reads as a failure.
func (a *app) handleRevokeSessionLink(w http.ResponseWriter, r *http.Request) {
	revoked, err := a.links.Revoke(r.Context(), sessionFrom(r.Context()).ID, chi.URLParam(r, "linkId"))
	if errors.Is(err, store.ErrNoLink) {
		http.Error(w, `{"error":"no such link"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not revoke the link"}`, http.StatusInternalServerError)
		return
	}
	// The rows are already gone, so revalidation would sever these sockets on
	// its own tick. Doing it here as well makes revocation immediate on this
	// replica, and the notification carries it to the others — the same path
	// signing out already uses.
	for _, hash := range revoked {
		a.hub.DisconnectToken(string(hash))
		a.notifyRevoke(r.Context(), hash)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRedeemLink trades a link token for a session-scoped identity: an
// ordinary users row flagged link-bound, and a cookie whose token expires with
// the link.
//
// Two budgets are spent here, and both are needed. attemptLimiter caps wrong
// tokens, so the opaque token cannot be guessed; the hourly identity limits cap
// successful ones, so a link that does leak is not an unbounded user-row
// factory. Every 4xx below is the same sentence about the link not working:
// a holder never learns whether it expired, was revoked or was simply wrong,
// and no reply ever repeats the token back.
func (a *app) handleRedeemLink(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
		Name  string `json:"name"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 64 {
		http.Error(w, `{"error":"name must be 1-64 characters"}`, http.StatusBadRequest)
		return
	}

	key := clientKey(r) + "|link"
	if !a.passcodeAttempts.take(r.Context(), key) {
		http.Error(w, `{"error":"too many tries — wait a minute, then open the link again"}`, http.StatusTooManyRequests)
		return
	}

	// A token that is not even the right shape never reaches the database, but
	// it still costs a guess: otherwise malformed input is a free probe.
	hash, err := store.HashToken(body.Token)
	if err != nil {
		http.Error(w, `{"error":"this link is not valid"}`, http.StatusNotFound)
		return
	}
	link, err := a.links.ByToken(r.Context(), hash, store.LinkRedemptionCap)
	if errors.Is(err, store.ErrNoLink) {
		http.Error(w, `{"error":"this link is not valid"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not open the link"}`, http.StatusInternalServerError)
		return
	}
	a.passcodeAttempts.refund(r.Context(), key)

	plain, tokenHash := store.NewToken()
	u, err := a.users.CreateForLink(r.Context(), name, link.ID, tokenHash, link.ExpiresAt,
		store.LinkRedemptionCap, clientKey(r), a.limits.LinkRedemptionIPHourly, a.limits.IdentityGlobalHourly)
	var limited *store.IdentityRateLimitError
	if errors.As(err, &limited) {
		w.Header().Set("Retry-After", strconv.Itoa(limited.RetryAfter))
		http.Error(w, `{"error":"too many identities created — try again after the current hour"}`, http.StatusTooManyRequests)
		return
	}
	// The cap was free a moment ago and is spent now: someone else redeemed
	// the last slot in between.
	if errors.Is(err, store.ErrNoLink) {
		http.Error(w, `{"error":"this link is not valid"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not open the link"}`, http.StatusInternalServerError)
		return
	}

	setLinkSessionCookie(w, plain, a.secureCookies)
	writeJSON(w, http.StatusCreated, map[string]any{
		"sessionId": link.SessionID,
		"expiresAt": link.ExpiresAt,
		"me":        toMeResponse(u),
	})
}
