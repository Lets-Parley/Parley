package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/jacorbello/parley/internal/auth"
)

// A browser reads a backslash as a slash, so "/\evil.example" is every bit as
// protocol-relative as "//evil.example" — and tab, newline and carriage return
// are stripped out of a URL before it is parsed, so they smuggle the same shape
// past a naive prefix check.
func TestSafeNextRejectsEveryOffSiteShape(t *testing.T) {
	for _, raw := range []string{
		"//evil.example/steal",
		`/\evil.example/steal`,
		`/\/evil.example`,
		"/\t//evil.example",
		"/\n//evil.example",
		"/\r//evil.example",
		"https://evil.example",
		"http://evil.example",
		`\\evil.example`,
		"",
	} {
		if got := safeNext(raw); got != "/" {
			t.Errorf("safeNext(%q) = %q, want \"/\" — that target leaves this site", raw, got)
		}
	}
	// Ordinary in-site destinations still survive.
	for _, raw := range []string{"/", "/s/platform-team", "/session/abc?x=1"} {
		if got := safeNext(raw); got != raw {
			t.Errorf("safeNext(%q) = %q, want it unchanged", raw, got)
		}
	}
}

// The sign-in cookie is base64 JSON, not a signature. Anything read back out of
// it is input from the browser, so the redirect target has to be re-checked on
// the way out rather than trusted because it was clean on the way in.
func TestForgedFlowCookieCannotRedirectOffSite(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)

	authURL, flow := startSignin(t, srv, "/s/platform-team")
	idp.nonce = authURL.Query().Get("nonce")

	// Keep the genuine state, nonce and PKCE verifier; swap only the target.
	blob, err := base64.RawURLEncoding.DecodeString(flow.Value)
	if err != nil {
		t.Fatalf("decode flow cookie: %v", err)
	}
	var f signinFlow
	if err := json.Unmarshal(blob, &f); err != nil {
		t.Fatalf("unmarshal flow: %v", err)
	}
	f.Next = "https://evil.example/harvest"
	forged, _ := json.Marshal(f)
	flow.Value = base64.RawURLEncoding.EncodeToString(forged)

	resp := callback(t, srv, flow, f.State)
	defer resp.Body.Close()
	if got := resp.Header.Get("Location"); got != "/" {
		t.Errorf("callback redirected to %q — a forged cookie steered an authenticated user off-site", got)
	}
}

// The flow cookie carries the state, nonce and PKCE verifier for one attempt.
// Leaving it in the browser keeps a spent sign-in replayable for its full life.
func TestFlowCookieIsClearedByTheCallback(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)
	authURL, flow := startSignin(t, srv, "")
	idp.nonce = authURL.Query().Get("nonce")

	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()

	for _, c := range resp.Cookies() {
		if c.Name == flowCookie && c.MaxAge < 0 {
			return
		}
	}
	t.Errorf("the callback never expired %s: %v", flowCookie, resp.Cookies())
}

// Checking the budget and spending it under separate locks lets every request
// that arrives together see the same "still allowed", so a guesser gets one
// free attempt per parallel connection.
func TestThrottleHoldsUnderConcurrency(t *testing.T) {
	l := newAttemptLimiter()

	var mu sync.Mutex
	through := 0
	var wg sync.WaitGroup
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.take("addr|space") {
				mu.Lock()
				through++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if through > passcodeAttemptLimit {
		t.Errorf("%d guesses got through a limit of %d — the check and the charge are not atomic", through, passcodeAttemptLimit)
	}
}

// A correct code costs nothing, so a whole team can file in through one office
// address without the stragglers being refused.
func TestCorrectCodeRefundsItsGuess(t *testing.T) {
	l := newAttemptLimiter()
	for range passcodeAttemptLimit * 3 {
		if !l.take("addr|space") {
			t.Fatal("a correct code should never exhaust the budget")
		}
		l.refund("addr|space")
	}
	if l.blockedFor("addr|space") {
		t.Error("refunded guesses still counted against the budget")
	}
}

// Turning sign-in on has to mean something for the sessions already out there.
// Refusing to mint new anonymous identities leaves every token handed out while
// the instance was open still valid for its full idle window.
func TestAnonymousSessionsStopWorkingInOIDCMode(t *testing.T) {
	idp := newFakeIdP(t)
	pool := testPool(t)

	// An instance that started out open, with someone signed in the old way.
	open := httptest.NewServer(Router(pool, Options{AllowedOrigin: "http://example.test"}))
	defer open.Close()
	anon := signup(t, open, "Anonymous Ann")

	// The same database, now running behind an identity provider.
	federated := httptest.NewServer(Router(pool, Options{
		AllowedOrigin: "http://example.test",
		AuthMode:      ModeOIDC,
		OIDC: auth.New(auth.Config{
			Issuer: idp.URL, ClientID: "parley-test", ClientSecret: "shh",
			RedirectURL: "http://example.test/auth/callback",
		}),
	}))
	defer federated.Close()

	resp, _ := getMe(t, federated, anon)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("an old anonymous session still resolved: GET /api/me = %d, want 401", resp.StatusCode)
	}
	if r := createSpaceResp(t, federated, "Sneaky Space", anon); r != http.StatusUnauthorized {
		t.Errorf("an old anonymous session could still create a space: %d, want 401", r)
	}
}

func createSpaceResp(t *testing.T, srv *httptest.Server, name string, c *http.Cookie) int {
	t.Helper()
	resp, _ := createSpace(t, srv, name, c)
	resp.Body.Close()
	return resp.StatusCode
}
