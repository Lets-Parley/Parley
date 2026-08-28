package auth

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
	"testing"
	"time"
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
	// extra claims merged into the id_token, so a test can send a group claim
	// of any shape — or the pointer Entra sends instead of one.
	extra map[string]any
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating a signing key: %v", err)
	}
	f := &fakeIdP{key: key, subject: "user-1", name: "Dana Whitlock"}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"issuer":                                f.URL,
			"authorization_endpoint":                f.URL + "/authorize",
			"token_endpoint":                        f.URL + "/token",
			"jwks_uri":                              f.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		pub := f.key.PublicKey
		writeJSON(t, w, map[string]any{"keys": []map[string]any{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": "test",
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "unparseable form", http.StatusBadRequest)
			return
		}
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
		writeJSON(t, w, body)
	})

	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Errorf("writing the fake provider's response: %v", err)
	}
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
	for k, v := range f.extra {
		claims[k] = v
	}
	seg := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshalling a token segment: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signing := seg(header) + "." + seg(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("signing the id_token: %v", err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// providerFor builds a Provider pointed at a given issuer, which is the only
// seam this package has: auth.Provider does real HTTP, so the issuer URL is
// what the tests substitute.
func providerFor(t *testing.T, issuer string) *Provider {
	t.Helper()
	return New(Config{
		Issuer:       issuer,
		ClientID:     "parley-test",
		ClientSecret: "shh",
		RedirectURL:  "http://example.test/auth/callback",
	})
}
