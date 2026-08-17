package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"golang.org/x/oauth2"

	"github.com/jacorbello/parley/internal/store"
)

// Auth modes. An instance is either anonymous or federated; there is no third
// state, so every "who is this" check has exactly two answers to consider.
const (
	ModeOpen = "open"
	ModeOIDC = "oidc"
)

// The in-flight sign-in cookie. It holds the three per-attempt secrets and dies
// with the attempt: scoped to /auth so it never rides along with anything else,
// and short-lived because a sign-in that takes ten minutes has been abandoned.
const (
	flowCookie    = "parley_signin"
	flowCookieTTL = 600
)

type signinFlow struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Next     string `json:"r"`
}

func randomToken() string {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand does not fail; it panics.
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// safeNext keeps an open redirect out of the sign-in flow. Only a path on this
// site is allowed back: no scheme, no host, and no "//evil.example" which a
// browser reads as protocol-relative.
func safeNext(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return "/"
	}
	return raw
}

// handleAuthConfig tells the frontend which sign-in flow to render. It is
// deliberately public: the answer is visible from the login page anyway, and a
// browser needs it before it has any identity at all.
func (a *app) handleAuthConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"mode": a.authMode})
}

func (a *app) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if a.oidc == nil {
		http.NotFound(w, r)
		return
	}
	flow := signinFlow{
		State:    randomToken(),
		Nonce:    randomToken(),
		Verifier: oauth2.GenerateVerifier(),
		Next:     safeNext(r.URL.Query().Get("next")),
	}
	url, err := a.oidc.AuthCodeURL(r.Context(), flow.State, flow.Nonce, flow.Verifier)
	if err != nil {
		slog.Error("oidc discovery failed", "err", err)
		http.Error(w, "Sign-in is unavailable: the identity provider could not be reached. Try again in a moment.", http.StatusServiceUnavailable)
		return
	}
	blob, _ := json.Marshal(flow)
	http.SetCookie(w, &http.Cookie{
		Name:     flowCookie,
		Value:    base64.RawURLEncoding.EncodeToString(blob),
		Path:     "/auth",
		HttpOnly: true,
		// Lax, not Strict: the browser arrives here from the identity
		// provider's domain, and Strict would withhold the cookie on exactly
		// that hop and break every sign-in.
		SameSite: http.SameSiteLaxMode,
		Secure:   a.secureCookies,
		MaxAge:   flowCookieTTL,
	})
	http.Redirect(w, r, url, http.StatusFound)
}

func (a *app) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	if a.oidc == nil {
		http.NotFound(w, r)
		return
	}
	// Whatever happens next, this attempt is over.
	defer clearFlowCookie(w, a.secureCookies)

	if e := r.URL.Query().Get("error"); e != "" {
		desc := r.URL.Query().Get("error_description")
		slog.Info("sign-in refused by provider", "error", e, "description", desc)
		http.Error(w, "The identity provider refused the sign-in: "+e, http.StatusForbidden)
		return
	}

	c, err := r.Cookie(flowCookie)
	if err != nil {
		http.Error(w, "That sign-in link has expired or was opened in a different browser. Start again from the Parley home page.", http.StatusBadRequest)
		return
	}
	blob, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		http.Error(w, "That sign-in could not be read. Start again from the Parley home page.", http.StatusBadRequest)
		return
	}
	var flow signinFlow
	if err := json.Unmarshal(blob, &flow); err != nil {
		http.Error(w, "That sign-in could not be read. Start again from the Parley home page.", http.StatusBadRequest)
		return
	}

	// State is the CSRF check: it proves this reply belongs to the sign-in this
	// browser started, not one an attacker started elsewhere.
	if subtle.ConstantTimeCompare([]byte(flow.State), []byte(r.URL.Query().Get("state"))) != 1 {
		http.Error(w, "That sign-in reply did not match the request that started it. Start again from the Parley home page.", http.StatusBadRequest)
		return
	}

	ident, err := a.oidc.Exchange(r.Context(), r.URL.Query().Get("code"), flow.Verifier, flow.Nonce)
	if err != nil {
		slog.Error("sign-in exchange failed", "err", err)
		http.Error(w, "Sign-in failed. If this keeps happening, check the server logs — the identity provider gave a reason.", http.StatusForbidden)
		return
	}

	plain, hash := store.NewToken()
	u, err := a.users.UpsertFederated(r.Context(), ident.Issuer, ident.Subject, ident.Name, hash)
	if err != nil {
		slog.Error("could not record signed-in user", "err", err)
		http.Error(w, "Signed in, but the account could not be saved. Try again.", http.StatusInternalServerError)
		return
	}
	slog.Info("sign-in", "user_id", u.ID, "issuer", ident.Issuer)

	setSessionCookie(w, plain, a.secureCookies)
	http.Redirect(w, r, flow.Next, http.StatusFound)
}

func clearFlowCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     flowCookie,
		Value:    "",
		Path:     "/auth",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   -1,
	})
}
