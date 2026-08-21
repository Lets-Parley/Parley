package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

type meResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// AvatarHue is always the derived integer, never null: clients do
	// arithmetic on it.
	AvatarHue       int    `json:"avatarHue"`
	AvatarIcon      string `json:"avatarIcon"`
	AvatarAccessory string `json:"avatarAccessory"`
}

// avatarID is the only thing the server knows about an icon or accessory id.
// It deliberately does not enumerate them, so the picker can grow without a
// server release. The empty string is not an id — it clears the choice.
var avatarID = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

func avatarHue(userID string) int { return store.AvatarHue(userID) }

func toMeResponse(u store.User) meResponse {
	return meResponse{
		ID: u.ID, Name: u.Name, AvatarHue: avatarHue(u.ID),
		AvatarIcon: u.AvatarIcon, AvatarAccessory: u.AvatarAccessory,
	}
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
	writeJSON(w, http.StatusOK, toMeResponse(store.User{
		ID: p.UserID, Name: p.Display,
		AvatarIcon: p.AvatarIcon, AvatarAccessory: p.AvatarAccessory,
	}))
}

// handlePatchMeAvatar writes the caller's chosen avatar.
//
// It is its own route rather than a wider POST /api/me because that handler
// mints a new token on every call — an avatar write through it would rotate
// the caller's session cookie and race their other tabs — refuses everything
// with 403 under OIDC before it reads the body, and creates a user when there
// is no principal instead of answering 401.
func (a *app) handlePatchMeAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}

	var body struct {
		Icon      string `json:"icon"`
		Accessory string `json:"accessory"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	for _, id := range []string{body.Icon, body.Accessory} {
		if id != "" && !avatarID.MatchString(id) {
			http.Error(w, `{"error":"icon and accessory must be lowercase letters, digits or hyphens, 1-32 characters"}`, http.StatusBadRequest)
			return
		}
	}

	if _, err := a.users.SetAvatar(r.Context(), p.UserID, body.Icon, body.Accessory); err != nil {
		http.Error(w, `{"error":"could not save avatar"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, toMeResponse(store.User{
		ID: p.UserID, Name: p.Display,
		AvatarIcon: body.Icon, AvatarAccessory: body.Accessory,
	}))
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
			// Local first and directly, so revocation on this replica never
			// depends on a database round trip completing.
			a.hub.DisconnectToken(string(hash))
			// Then the other replicas, which hold their own sockets for this
			// token and their own hubs to close them with. Published only after
			// the row is gone: a replica acting on this can then never
			// revalidate the token back into existence. Best-effort — the
			// logout has already succeeded in the database, and revalidate is
			// the backstop if the notification is lost.
			a.notifyRevoke(r.Context(), hash)
		}
	}
	clearSessionCookie(w, a.secureCookies)
	w.WriteHeader(http.StatusNoContent)
}
