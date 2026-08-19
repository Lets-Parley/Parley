package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

type meResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
}

func avatarHue(userID string) int { return store.AvatarHue(userID) }

func toMeResponse(u store.User) meResponse {
	return meResponse{ID: u.ID, Name: u.Name, AvatarHue: avatarHue(u.ID)}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (a *app) handleGetMe(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, toMeResponse(store.User{ID: p.UserID, Name: p.Display}))
}

// handlePostMe creates an identity, or renames the existing one (rotating its
// token) when the caller already has a valid session cookie.
func (a *app) handlePostMe(w http.ResponseWriter, r *http.Request) {
	// With an identity provider configured this is the whole of the bypass:
	// anyone could otherwise mint themselves an anonymous identity here and
	// never sign in at all. Names come from the provider in that mode, so
	// renaming is refused too rather than being silently overwritten at the
	// next sign-in.
	if a.authMode == ModeOIDC {
		http.Error(w, `{"error":"this server signs in through its identity provider"}`, http.StatusForbidden)
		return
	}

	var body struct {
		Name string `json:"name"`
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

	plain, hash := store.NewToken()

	if p, ok := PrincipalFrom(r.Context()); ok {
		c, _ := r.Cookie(sessionCookie)
		oldHash, err := store.HashToken(c.Value)
		if err != nil {
			http.Error(w, `{"error":"invalid session"}`, http.StatusBadRequest)
			return
		}
		u, err := a.users.Rename(r.Context(), p.UserID, name, oldHash, hash)
		if err != nil {
			http.Error(w, `{"error":"could not update name"}`, http.StatusInternalServerError)
			return
		}
		setSessionCookie(w, plain, a.secureCookies)
		writeJSON(w, http.StatusOK, toMeResponse(u))
		return
	}

	u, err := a.users.CreateOpen(r.Context(), name, hash, clientKey(r), a.limits.IdentityIPHourly, a.limits.IdentityGlobalHourly)
	var limited *store.IdentityRateLimitError
	if errors.As(err, &limited) {
		w.Header().Set("Retry-After", strconv.Itoa(limited.RetryAfter))
		http.Error(w, `{"error":"too many identities created — try again after the current hour"}`, http.StatusTooManyRequests)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create user"}`, http.StatusInternalServerError)
		return
	}
	setSessionCookie(w, plain, a.secureCookies)
	writeJSON(w, http.StatusCreated, toMeResponse(u))
}

func (a *app) handleDeleteMe(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		if hash, err := store.HashToken(c.Value); err == nil {
			if err := a.users.DeleteToken(r.Context(), hash); err != nil {
				http.Error(w, `{"error":"could not end session"}`, http.StatusInternalServerError)
				return
			}
			a.hub.DisconnectToken(string(hash))
		}
	}
	clearSessionCookie(w, a.secureCookies)
	w.WriteHeader(http.StatusNoContent)
}
