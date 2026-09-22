package api

import (
	"cmp"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

// embedWSProtocol is the one subprotocol /ws speaks. An embedded frame cannot
// set headers on a browser WebSocket, so it offers `parley.embed, <token>`;
// the upgrader echoes parley.embed and never the token.
const embedWSProtocol = "parley.embed"

// EmbedProvider is a meeting client Parley can run inside. It is a row, not an
// interface: the second provider decides what the abstraction is.
type EmbedProvider struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	// FrameAncestors are the origins allowed to frame Parley's embedded pages.
	FrameAncestors []string `json:"-"`
	// SDKScript is the provider's add-on SDK. Nothing references it unless the
	// operator enables the provider, so an air-gapped install never does.
	SDKScript          string `json:"sdkScript"`
	CloudProjectNumber string `json:"cloudProjectNumber"`
}

// embedProviderTable is every provider this build knows. Configuration picks
// from it; it never adds to it.
var embedProviderTable = map[string]EmbedProvider{
	"meet": {
		Name:           "meet",
		Label:          "Google Meet",
		FrameAncestors: []string{"https://meet.google.com"},
		SDKScript:      "https://www.gstatic.com/meetjs/addons/1.1.0/meet.addons.js",
	},
}

// ParseEmbedProviders resolves EMBED_PROVIDERS against the table. Unknown
// names, and a provider missing its configuration, are errors for the caller
// to make fatal.
func ParseEmbedProviders(list, meetCloudProjectNumber string) ([]EmbedProvider, error) {
	var out []EmbedProvider
	seen := map[string]bool{}
	for _, name := range strings.Split(list, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || seen[name] {
			continue
		}
		p, ok := embedProviderTable[name]
		if !ok {
			return nil, fmt.Errorf("EMBED_PROVIDERS names %q, which is not a known meeting client (known: meet)", name)
		}
		if name == "meet" {
			if _, err := strconv.ParseUint(meetCloudProjectNumber, 10, 64); err != nil {
				return nil, errors.New("EMBED_PROVIDERS includes meet, so MEET_CLOUD_PROJECT_NUMBER must be set to the Google Cloud project number of the Meet add-on")
			}
			p.CloudProjectNumber = meetCloudProjectNumber
		}
		seen[name] = true
		out = append(out, p)
	}
	return out, nil
}

// requireEmbed answers 404 for every embed route unless a provider is
// enabled. The routes are registered either way, because the SPA fallback
// would otherwise answer them 200.
func (a *app) requireEmbed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(a.embedProviders) == 0 {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// embedBearer is the bearer reader for a mount, or nil — cookies only — when
// embedding is off, so a bearer token is never even read.
func (a *app) embedBearer(read func(*http.Request) (string, bool)) func(*http.Request) (string, bool) {
	if len(a.embedProviders) == 0 {
		return nil
	}
	return read
}

func (a *app) embedProvider(name string) (EmbedProvider, bool) {
	for _, p := range a.embedProviders {
		if p.Name == name {
			return p, true
		}
	}
	return EmbedProvider{}, false
}

// decodeChallenge reads an S256 challenge: base64url of a SHA-256 digest.
func decodeChallenge(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return b, err == nil && len(b) == sha256.Size
}

// verifierChallenge checks an RFC 7636 verifier — 43 to 128 unreserved
// characters, so at least 256 bits from a random source — and returns its
// S256 challenge.
func verifierChallenge(v string) ([]byte, bool) {
	if len(v) < 43 || len(v) > 128 {
		return nil, false
	}
	for _, c := range v {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
			return nil, false
		}
	}
	sum := sha256.Sum256([]byte(v))
	return sum[:], true
}

// handleEmbedHandoff opens a sign-in request for a framed page. The frame can
// call this as soon as its panel loads, so the click that opens the sign-in
// popup does nothing but open it: a popup opened after an await is blocked.
func (a *app) handleEmbedHandoff(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider  string `json:"provider"`
		Challenge string `json:"challenge"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	provider, ok := a.embedProvider(body.Provider)
	if !ok {
		http.Error(w, `{"error":"that meeting client is not enabled on this server"}`, http.StatusBadRequest)
		return
	}
	challenge, ok := decodeChallenge(body.Challenge)
	if !ok {
		http.Error(w, `{"error":"challenge must be the base64url SHA-256 of a verifier"}`, http.StatusBadRequest)
		return
	}
	h, err := a.embedHandoffs.Create(r.Context(), challenge, provider.Name, clientKey(r))
	if errors.Is(err, store.ErrHandoffThrottled) {
		w.Header().Set("Retry-After", strconv.Itoa(int(store.EmbedHandoffTTL.Seconds())))
		http.Error(w, `{"error":"too many sign-in requests — wait a few minutes"}`, http.StatusTooManyRequests)
		return
	}
	if errors.Is(err, store.ErrNoHandoff) {
		http.Error(w, `{"error":"that challenge was already used — make a new verifier"}`, http.StatusConflict)
		return
	}
	if err != nil {
		slog.Error("creating embed handoff", "error", err)
		http.Error(w, `{"error":"could not start sign-in"}`, http.StatusInternalServerError)
		return
	}
	logSecEvent(r, secEvent{Event: "embed.handoff", Target: provider.Name})
	writeJSON(w, http.StatusCreated, map[string]any{
		"displayCode": h.DisplayCode,
		"signinPath":  "/embed/signin?c=" + body.Challenge,
		"expiresIn":   int(store.EmbedHandoffTTL.Seconds()),
	})
}

// handleEmbedSession is the frame's poll. It proves possession of the
// verifier and, once somebody has bound the handoff, receives the token once.
func (a *app) handleEmbedSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Verifier string `json:"verifier"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	challenge, ok := verifierChallenge(body.Verifier)
	if !ok {
		http.Error(w, `{"error":"verifier must be 43-128 unreserved characters"}`, http.StatusBadRequest)
		return
	}
	plain, hash := store.NewToken()
	userID, err := a.embedHandoffs.Redeem(r.Context(), challenge, hash)
	if errors.Is(err, store.ErrHandoffPending) {
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "pending"})
		return
	}
	if errors.Is(err, store.ErrNoHandoff) {
		http.Error(w, `{"error":"no such sign-in request — it expired, was used, or never existed"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("redeeming embed handoff", "error", err)
		http.Error(w, `{"error":"could not finish sign-in"}`, http.StatusInternalServerError)
		return
	}
	logSecEvent(r, secEvent{Event: "embed.redeem", ActorUserID: userID, Target: userID})
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     plain,
		"expiresAt": time.Now().Add(store.EmbedTokenTTL).UTC().Format(time.RFC3339),
	})
}

var embedSigninPage = template.Must(template.New("signin").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to {{.Label}} — Parley</title></head>
<body><main>
<h1>{{.Title}}</h1>
{{if .Code}}<p>Code: <strong>{{.Code}}</strong> — check it matches the one in {{.Label}}.</p>{{end}}
<p>{{.Message}}</p>
{{if .SigninURL}}<p><a href="{{.SigninURL}}">Sign in to Parley</a>, then come back to this page.</p>{{end}}
{{if .Challenge}}<form method="post" action="/embed/signin">
<input type="hidden" name="c" value="{{.Challenge}}">
<button type="submit">Continue as {{.Name}}</button>
</form>{{end}}
</main></body></html>
`))

type embedSigninView struct {
	Title, Label, Code, Message, SigninURL, Challenge, Name string
}

func renderEmbedSignin(w http.ResponseWriter, status int, v embedSigninView) {
	if v.Label == "" {
		v.Label = "your meeting"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = embedSigninPage.Execute(w, v)
}

var embedGone = embedSigninView{
	Title:   "This sign-in request has ended",
	Message: "It expired, was already used, or never existed. Press Sign in inside your meeting again.",
}

// handleEmbedSigninPage is the top-level half of the handoff. It never binds
// on a GET: binding is the explicit click below, and the page names the
// provider only from an enabled row, never from anything in the URL.
func (a *app) handleEmbedSigninPage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("c")
	challenge, ok := decodeChallenge(raw)
	if !ok {
		renderEmbedSignin(w, http.StatusNotFound, embedGone)
		return
	}
	h, err := a.embedHandoffs.Pending(r.Context(), challenge)
	provider, enabled := a.embedProvider(h.Provider)
	if err != nil || !enabled {
		renderEmbedSignin(w, http.StatusNotFound, embedGone)
		return
	}
	v := embedSigninView{Label: provider.Label, Code: h.DisplayCode}
	p, ok := PrincipalFrom(r.Context())
	if !ok || p.IsLinkGuest() || p.Embedded {
		v.Title = "Sign in to Parley"
		v.Message = "You need to be signed in to Parley in this browser to continue."
		v.SigninURL = "/"
		if a.authMode == ModeOIDC {
			v.SigninURL = "/auth/login?next=" + url.QueryEscape("/embed/signin?c="+raw)
		}
		renderEmbedSignin(w, http.StatusOK, v)
		return
	}
	v.Title = "Sign in to Parley in " + provider.Label
	v.Message = "Continue only if you just pressed Sign in inside " + provider.Label + "."
	v.Challenge = raw
	v.Name = p.Display
	renderEmbedSignin(w, http.StatusOK, v)
}

// handleEmbedSigninBind binds a handoff to the signed-in person on their
// explicit click. It sits outside /api, so its CSRF story is its own: the
// group runs rejectCrossSite, and the session cookie is SameSite=Lax, which a
// cross-site form POST does not carry.
func (a *app) handleEmbedSigninBind(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	challenge, ok := decodeChallenge(r.PostFormValue("c"))
	if !ok {
		renderEmbedSignin(w, http.StatusNotFound, embedGone)
		return
	}
	p, ok := PrincipalFrom(r.Context())
	if !ok || p.IsLinkGuest() || p.Embedded {
		renderEmbedSignin(w, http.StatusUnauthorized, embedSigninView{
			Title:   "Sign in to Parley first",
			Message: "A guest link or a meeting-client session cannot sign a meeting client in.",
		})
		return
	}
	h, err := a.embedHandoffs.Bind(r.Context(), challenge, p.UserID)
	if errors.Is(err, store.ErrNoHandoff) {
		logSecEvent(r, secEvent{Event: "embed.bind", Outcome: "refused"})
		renderEmbedSignin(w, http.StatusNotFound, embedGone)
		return
	}
	if err != nil {
		slog.Error("binding embed handoff", "error", err)
		renderEmbedSignin(w, http.StatusInternalServerError, embedSigninView{
			Title: "Something went wrong", Message: "Try again in a moment.",
		})
		return
	}
	provider, _ := a.embedProvider(h.Provider)
	logSecEvent(r, secEvent{Event: "embed.bind", Target: h.Provider})
	renderEmbedSignin(w, http.StatusOK, embedSigninView{
		Title: "You're signed in", Label: provider.Label,
		Message: "Go back to " + cmp.Or(provider.Label, "your meeting") + " — Parley will open there in a moment. You can close this tab.",
	})
}
