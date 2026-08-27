package api

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/auth"
)

// fakeIdP is just enough of an OpenID provider to sign in against: discovery,
// a JWKS, and a token endpoint. It exists so the sign-in path is tested for
// real — signature, audience, expiry and nonce all verified by the same
// library that will face Keycloak or Clerk in production.
type fakeIdP struct {
	*httptest.Server
	key *rsa.PrivateKey
	// claims the next issued id_token will carry, overridable per test.
	nonce   string
	subject string
	name    string
	// omitIDToken reproduces a provider that answers without an id_token.
	omitIDToken bool
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	f := &fakeIdP{key: key, subject: "user-1", name: "Dana Whitlock"}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                f.URL,
			"authorization_endpoint":                f.URL + "/authorize",
			"token_endpoint":                        f.URL + "/token",
			"jwks_uri":                              f.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		pub := f.key.PublicKey
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": "test",
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		// PKCE is the point of the flow; a provider that never sees a verifier
		// means Parley stopped sending one.
		if r.Form.Get("code_verifier") == "" {
			http.Error(w, "missing code_verifier", http.StatusBadRequest)
			return
		}
		body := map[string]any{"access_token": "at", "token_type": "Bearer"}
		if !f.omitIDToken {
			body["id_token"] = f.signIDToken(t)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(body)
	})

	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *fakeIdP) signIDToken(t *testing.T) string {
	t.Helper()
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": "test"}
	claims := map[string]any{
		"iss":   f.URL,
		"sub":   f.subject,
		"aud":   "parley-test",
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
		"nonce": f.nonce,
		"name":  f.name,
	}
	seg := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signing := seg(header) + "." + seg(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// oidcServer wires a Parley router in OIDC mode against the fake provider.
func oidcServer(t *testing.T, idp *fakeIdP) *httptest.Server {
	t.Helper()
	srv, _ := oidcServerPool(t, idp)
	return srv
}

// oidcServerPool is oidcServer for the tests that also have to read the rows
// the handlers wrote.
func oidcServerPool(t *testing.T, idp *fakeIdP) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return testServerWith(t, pool, Options{
		AllowedOrigin: "http://example.test",
		Context:       testContext(t),
		AuthMode:      ModeOIDC,
		OIDC: auth.New(auth.Config{
			Issuer:       idp.URL,
			ClientID:     "parley-test",
			ClientSecret: "shh",
			RedirectURL:  "http://example.test/auth/callback",
		}),
	}), pool
}

// noRedirect keeps the test client from following the sign-in hops, so each
// one can be inspected.
func noRedirect() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// startSignin performs GET /auth/login and returns the provider URL it was
// sent to plus the in-flight cookie.
func startSignin(t *testing.T, srv *httptest.Server, next string) (*url.URL, *http.Cookie) {
	t.Helper()
	path := "/auth/login"
	if next != "" {
		path += "?next=" + url.QueryEscape(next)
	}
	resp, err := noRedirect().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("login status = %d, want 302", resp.StatusCode)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}
	for _, c := range resp.Cookies() {
		if c.Name == flowCookie {
			return loc, c
		}
	}
	t.Fatal("login set no sign-in cookie")
	return nil, nil
}

func callback(t *testing.T, srv *httptest.Server, flow *http.Cookie, state string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/auth/callback?code=abc&state="+url.QueryEscape(state), nil)
	req.AddCookie(flow)
	resp, err := noRedirect().Do(req)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	return resp
}

func TestSigninCreatesUserFromClaims(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	authURL, flow := startSignin(t, srv, "/s/platform-team")

	// The request to the provider must carry PKCE and a nonce, not just state.
	q := authURL.Query()
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("authorize URL missing S256 PKCE challenge: %s", authURL)
	}
	if q.Get("nonce") == "" {
		t.Errorf("authorize URL missing nonce: %s", authURL)
	}
	idp.nonce = q.Get("nonce")

	resp := callback(t, srv, flow, q.Get("state"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d, want 302", resp.StatusCode)
	}
	if got := resp.Header.Get("Location"); got != "/s/platform-team" {
		t.Errorf("landed at %q, want the page the sign-in started from", got)
	}

	var session *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("callback issued no session cookie")
	}

	_, me := getMe(t, srv, session)
	if me["name"] != "Dana Whitlock" {
		t.Errorf("name = %v, want the name claim from the provider", me["name"])
	}
}

func TestSigninIsIdempotentPerSubject(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	signIn := func() string {
		authURL, flow := startSignin(t, srv, "")
		idp.nonce = authURL.Query().Get("nonce")
		resp := callback(t, srv, flow, authURL.Query().Get("state"))
		defer resp.Body.Close()
		for _, c := range resp.Cookies() {
			if c.Name == sessionCookie && c.Value != "" {
				_, me := getMe(t, srv, c)
				return me["id"].(string)
			}
		}
		t.Fatal("no session cookie")
		return ""
	}

	first := signIn()
	// A second sign-in by the same person must land on the same account, or
	// every login would fork a new identity and orphan their history.
	idp.name = "Dana W."
	if second := signIn(); second != first {
		t.Errorf("second sign-in produced user %s, want the original %s", second, first)
	}
}

func TestSigninRejectsStateMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)
	authURL, flow := startSignin(t, srv, "")
	idp.nonce = authURL.Query().Get("nonce")

	resp := callback(t, srv, flow, "not-the-state-we-issued")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a forged state", resp.StatusCode)
	}
}

func TestSigninRejectsNonceMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)
	authURL, flow := startSignin(t, srv, "")
	// A token that is perfectly valid but was minted for a different sign-in.
	idp.nonce = "some-other-signin"

	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for a replayed token", resp.StatusCode)
	}
}

func TestSigninRejectsMissingIDToken(t *testing.T) {
	idp := newFakeIdP(t)
	idp.omitIDToken = true
	srv := oidcServer(t, idp)
	authURL, flow := startSignin(t, srv, "")

	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403 when the provider returns no id_token", resp.StatusCode)
	}
}

func TestSigninWithoutFlowCookieIsRefused(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	resp, err := noRedirect().Get(srv.URL + "/auth/callback?code=abc&state=whatever")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 without the sign-in cookie", resp.StatusCode)
	}
}

func TestSigninNextCannotLeaveTheSite(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	// "//evil.example" is protocol-relative: a browser reads it as another
	// origin, so it must never survive as a redirect target.
	authURL, flow := startSignin(t, srv, "//evil.example/steal")
	idp.nonce = authURL.Query().Get("nonce")

	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()
	if got := resp.Header.Get("Location"); got != "/" {
		t.Errorf("redirected to %q, want / — an off-site next must be dropped", got)
	}
}

// In OIDC mode the anonymous door has to be shut, or signing in is optional and
// therefore pointless.
func TestAnonymousIdentityRefusedInOIDCMode(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	resp, _ := postMe(t, srv, "Someone Uninvited", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("POST /api/me = %d, want 403 when an identity provider is configured", resp.StatusCode)
	}
}

func TestSigninRoutesAbsentInOpenMode(t *testing.T) {
	srv := testServer(t)
	resp, err := noRedirect().Get(srv.URL + "/auth/login")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer resp.Body.Close()
	// The SPA handler serves index.html for unknown paths, so the check that
	// matters is that this never becomes a redirect to an identity provider.
	if resp.StatusCode == http.StatusFound {
		t.Errorf("open mode redirected to a provider: %s", resp.Header.Get("Location"))
	}
}

func TestAuthConfigReportsMode(t *testing.T) {
	idp := newFakeIdP(t)
	for _, tc := range []struct {
		name string
		srv  *httptest.Server
		want string
	}{
		{"open", testServer(t), ModeOpen},
		{"oidc", oidcServer(t, idp), ModeOIDC},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Get(tc.srv.URL + "/api/auth")
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			defer resp.Body.Close()
			var body map[string]any
			json.NewDecoder(resp.Body).Decode(&body)
			if body["mode"] != tc.want {
				t.Errorf("mode = %v, want %s", body["mode"], tc.want)
			}
		})
	}
}
