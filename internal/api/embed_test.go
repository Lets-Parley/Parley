package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testMeet is the real Meet row, so the framed documents are served under the
// origins and SDK the shipped binary would use.
var testMeet = func() EmbedProvider {
	p := embedProviderTable["meet"]
	p.CloudProjectNumber = "123"
	return p
}()

func embedServer(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	return testServerWith(t, pool, Options{AllowedOrigin: testOrigin, EmbedProviders: []EmbedProvider{testMeet}})
}

func newVerifier(t *testing.T) (verifier, challenge string) {
	t.Helper()
	raw := make([]byte, 32)
	rand.Read(raw)
	verifier = base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// startHandoff opens a handoff as the frame would, and returns the display
// code the frame shows in the meeting.
func startHandoff(t *testing.T, srv *httptest.Server) (verifier, challenge, code string) {
	t.Helper()
	verifier, challenge = newVerifier(t)
	resp, body := doJSON(t, srv, "POST", "/api/embed/handoff", `{"provider":"meet","challenge":"`+challenge+`"}`, nil)
	code, _ = body["displayCode"].(string)
	if resp.StatusCode != http.StatusCreated || code == "" {
		t.Fatalf("handoff: %d %v", resp.StatusCode, body)
	}
	return verifier, challenge, code
}

// bind types the display code into the sign-in page and presses Continue, as
// the cookie's owner.
func bind(t *testing.T, srv *httptest.Server, challenge, code string, cookie *http.Cookie) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/embed/signin", strings.NewReader(url.Values{"c": {challenge}, "code": {code}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", testOrigin)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func collect(t *testing.T, srv *httptest.Server, verifier string) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, "POST", "/api/embed/session", `{"verifier":"`+verifier+`"}`, nil)
}

// embedToken runs the whole handoff for the cookie's owner.
func embedToken(t *testing.T, srv *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	verifier, challenge, code := startHandoff(t, srv)
	if status, page := bind(t, srv, challenge, code, cookie); status != http.StatusOK {
		t.Fatalf("bind: %d %s", status, page)
	}
	resp, body := collect(t, srv, verifier)
	token, _ := body["token"].(string)
	if resp.StatusCode != http.StatusOK || token == "" {
		t.Fatalf("collect: %d %v", resp.StatusCode, body)
	}
	return token
}

func bearerStatus(t *testing.T, srv *httptest.Server, method, path, body, token string) int {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func getPage(t *testing.T, srv *httptest.Server, path string, cookie *http.Cookie) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestEmbedHappyPath(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	verifier, challenge, code := startHandoff(t, srv)

	// Nothing to collect until somebody binds it.
	resp, _ := collect(t, srv, verifier)
	if resp.StatusCode != http.StatusAccepted || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("collect before bind: got %d Retry-After=%q, want 202 with Retry-After", resp.StatusCode, resp.Header.Get("Retry-After"))
	}

	status, page := getPage(t, srv, "/embed/signin?c="+challenge, ada)
	if status != http.StatusOK || !strings.Contains(page, "Google Meet") || !strings.Contains(page, "Continue as Ada") {
		t.Fatalf("sign-in page: %d %s", status, page)
	}
	// The page asks for the code; it never shows it. A page that displayed
	// the code would let a phished person copy it back without ever looking
	// at their meeting.
	if strings.Contains(page, code) || !strings.Contains(page, `name="code"`) {
		t.Fatalf("the sign-in page must ask for the display code, not show it: %s", page)
	}
	// Viewing the page binds nothing.
	if resp, _ := collect(t, srv, verifier); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("a GET of the sign-in page bound the handoff: collect got %d", resp.StatusCode)
	}

	if status, page := bind(t, srv, challenge, code, ada); status != http.StatusOK {
		t.Fatalf("bind: %d %s", status, page)
	}
	resp, body := collect(t, srv, verifier)
	token, _ := body["token"].(string)
	if resp.StatusCode != http.StatusOK || token == "" {
		t.Fatalf("collect: %d %v", resp.StatusCode, body)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r2, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var me map[string]any
	json.NewDecoder(r2.Body).Decode(&me)
	r2.Body.Close()
	if r2.StatusCode != http.StatusOK || me["name"] != "Ada" {
		t.Fatalf("GET /api/me with the embedded token: %d %v", r2.StatusCode, me)
	}

	// Signing out spends the embedded token.
	if got := bearerStatus(t, srv, "DELETE", "/api/me", "", token); got != http.StatusNoContent {
		t.Fatalf("sign out: %d", got)
	}
	if got := bearerStatus(t, srv, "GET", "/api/me", "", token); got != http.StatusUnauthorized {
		t.Fatalf("GET /api/me after sign out: %d, want 401", got)
	}
}

func TestEmbedHandoffRefusals(t *testing.T) {
	pool := testPool(t)
	srv := embedServer(t, pool)
	ada := signup(t, srv, "Ada")

	t.Run("unknown challenge", func(t *testing.T) {
		_, challenge := newVerifier(t)
		if status, _ := getPage(t, srv, "/embed/signin?c="+challenge, ada); status != http.StatusNotFound {
			t.Errorf("sign-in page for an unknown challenge: %d", status)
		}
		if status, _ := bind(t, srv, challenge, "ABC-DEF", ada); status != http.StatusNotFound {
			t.Errorf("bind of an unknown challenge: %d", status)
		}
	})
	t.Run("wrong verifier", func(t *testing.T) {
		_, challenge, code := startHandoff(t, srv)
		bind(t, srv, challenge, code, ada)
		other, _ := newVerifier(t)
		if resp, body := collect(t, srv, other); resp.StatusCode != http.StatusNotFound {
			t.Errorf("collect with the wrong verifier: %d %v", resp.StatusCode, body)
		}
	})
	t.Run("bound twice", func(t *testing.T) {
		_, challenge, code := startHandoff(t, srv)
		bind(t, srv, challenge, code, ada)
		bob := signup(t, srv, "Bob")
		if status, _ := bind(t, srv, challenge, code, bob); status != http.StatusNotFound {
			t.Errorf("a second bind: %d", status)
		}
	})
	t.Run("collected twice", func(t *testing.T) {
		verifier, challenge, code := startHandoff(t, srv)
		bind(t, srv, challenge, code, ada)
		collect(t, srv, verifier)
		if resp, _ := collect(t, srv, verifier); resp.StatusCode != http.StatusNotFound {
			t.Errorf("a second collect: %d", resp.StatusCode)
		}
	})
	t.Run("late", func(t *testing.T) {
		verifier, challenge, code := startHandoff(t, srv)
		raw, _ := base64.RawURLEncoding.DecodeString(challenge)
		if _, err := pool.Exec(context.Background(), "update embed_handoffs set expires_at = now() - interval '1 second' where challenge_hash = $1", raw); err != nil {
			t.Fatal(err)
		}
		if status, _ := bind(t, srv, challenge, code, ada); status != http.StatusNotFound {
			t.Errorf("bind after expiry: %d", status)
		}
		if resp, _ := collect(t, srv, verifier); resp.StatusCode != http.StatusNotFound {
			t.Errorf("collect after expiry: %d", resp.StatusCode)
		}
	})
	t.Run("replayed challenge", func(t *testing.T) {
		_, challenge, _ := startHandoff(t, srv)
		if resp, _ := doJSON(t, srv, "POST", "/api/embed/handoff", `{"provider":"meet","challenge":"`+challenge+`"}`, nil); resp.StatusCode != http.StatusConflict {
			t.Errorf("a second handoff with one challenge: %d", resp.StatusCode)
		}
	})
	t.Run("short verifier", func(t *testing.T) {
		if resp, _ := collect(t, srv, "tooshort"); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("a short verifier: %d", resp.StatusCode)
		}
	})
	t.Run("unknown provider", func(t *testing.T) {
		_, challenge := newVerifier(t)
		if resp, _ := doJSON(t, srv, "POST", "/api/embed/handoff", `{"provider":"zoom","challenge":"`+challenge+`"}`, nil); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("an unknown provider: %d", resp.StatusCode)
		}
	})
	t.Run("signed out", func(t *testing.T) {
		_, challenge, code := startHandoff(t, srv)
		if status, page := getPage(t, srv, "/embed/signin?c="+challenge, nil); status != http.StatusOK || strings.Contains(page, "<form") {
			t.Errorf("signed-out sign-in page offered to bind: %d", status)
		}
		if status, _ := bind(t, srv, challenge, code, nil); status != http.StatusUnauthorized {
			t.Errorf("a signed-out bind: %d", status)
		}
	})
	t.Run("cross-site bind", func(t *testing.T) {
		_, challenge, code := startHandoff(t, srv)
		req, _ := http.NewRequest("POST", srv.URL+"/embed/signin", strings.NewReader("c="+challenge+"&code="+code))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "https://evil.example")
		req.AddCookie(ada)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("a cross-site bind: %d", resp.StatusCode)
		}
	})
	t.Run("embedded session cannot bind", func(t *testing.T) {
		token := embedToken(t, srv, ada)
		_, challenge, code := startHandoff(t, srv)
		req, _ := http.NewRequest("POST", srv.URL+"/embed/signin", strings.NewReader("c="+challenge+"&code="+code))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("a bind carried by a bearer: %d", resp.StatusCode)
		}
	})
}

// TestEmbedBindRequiresTheDisplayCode: one click on somebody else's sign-in
// link must not bind the clicker to that somebody's frame. The person has to
// type the code their own meeting shows, which an attacker's link cannot
// supply for them.
func TestEmbedBindRequiresTheDisplayCode(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	verifier, challenge, code := startHandoff(t, srv)

	for _, wrong := range []string{"", "ZZZ-ZZZ", code + "X"} {
		if status, page := bind(t, srv, challenge, wrong, ada); status != http.StatusForbidden {
			t.Errorf("bind with code %q: %d, want 403 (%s)", wrong, status, page)
		}
		if resp, _ := collect(t, srv, verifier); resp.StatusCode != http.StatusAccepted {
			t.Fatalf("a bind with code %q bound the handoff: collect %d", wrong, resp.StatusCode)
		}
	}
	// Typed as a person would: lower case, no hyphen, stray spaces.
	typed := " " + strings.ToLower(strings.ReplaceAll(code, "-", "")) + " "
	if status, page := bind(t, srv, challenge, typed, ada); status != http.StatusOK {
		t.Fatalf("bind with the right code typed loosely (%q): %d %s", typed, status, page)
	}
	if resp, body := collect(t, srv, verifier); resp.StatusCode != http.StatusOK || body["token"] == "" {
		t.Fatalf("collect after the right code: %d %v", resp.StatusCode, body)
	}
}

// TestEmbedBindCodeIsThrottled: wrong codes spend from the same per-client
// budget as a space passcode, so the code cannot be walked.
func TestEmbedBindCodeIsThrottled(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	_, challenge, code := startHandoff(t, srv)
	for i := 0; i < passcodeAttemptLimit; i++ {
		bind(t, srv, challenge, "ZZZ-ZZZ", ada)
	}
	if status, _ := bind(t, srv, challenge, code, ada); status != http.StatusTooManyRequests {
		t.Fatalf("the right code after the budget was spent: %d, want 429", status)
	}
}

func TestEmbedHandoffIsThrottledPerClient(t *testing.T) {
	srv := embedServer(t, testPool(t))
	last := 0
	for range 11 {
		_, challenge := newVerifier(t)
		resp, _ := doJSON(t, srv, "POST", "/api/embed/handoff", `{"provider":"meet","challenge":"`+challenge+`"}`, nil)
		last = resp.StatusCode
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("the eleventh handoff from one client: %d, want 429", last)
	}
}

func TestEmbedRefusesLinkGuestBinding(t *testing.T) {
	srv := embedServer(t, testPool(t))
	_, _, guest := mintAndRedeem(t, srv, "Guest Space")
	_, challenge, code := startHandoff(t, srv)
	if status, _ := bind(t, srv, challenge, code, guest); status != http.StatusUnauthorized {
		t.Fatalf("a link guest bound a handoff: %d", status)
	}
}

func TestEmbedDisabledIs404AndIgnoresBearer(t *testing.T) {
	pool := testPool(t)
	on := embedServer(t, pool)
	off := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	ada := signup(t, on, "Ada")
	token := embedToken(t, on, ada)
	_, challenge := newVerifier(t)

	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/embed/signin?c=" + challenge, ""},
		{"POST", "/embed/signin", ""},
		{"GET", "/embed/anything", ""},
		{"POST", "/api/embed/handoff", `{"provider":"meet","challenge":"` + challenge + `"}`},
		{"POST", "/api/embed/session", `{"verifier":"x"}`},
		{"GET", "/api/embed/anything", ""},
	} {
		if got, err := requestStatus(off, tc.method, tc.path, tc.body, nil); err != nil || got != http.StatusNotFound {
			t.Errorf("%s %s with embedding off: %d %v, want 404", tc.method, tc.path, got, err)
		}
	}
	if got := bearerStatus(t, off, "GET", "/api/me", "", token); got != http.StatusUnauthorized {
		t.Errorf("a valid embedded token with embedding off: GET /api/me %d, want 401", got)
	}
	if got := bearerStatus(t, on, "GET", "/api/me", "", token); got != http.StatusOK {
		t.Errorf("control: the same token with embedding on: %d", got)
	}
}

func TestEmbedBearerPrecedence(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")

	// A present Authorization header means the cookie is never read.
	req, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer not-a-token")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || body["error"] != "session ended" {
		t.Errorf("a bad bearer beside a good cookie: %d %v, want 401 session ended", resp.StatusCode, body)
	}
	// An ordinary cookie token is not a bearer.
	if got := bearerStatus(t, srv, "GET", "/api/me", "", ada.Value); got != http.StatusUnauthorized {
		t.Errorf("a cookie token sent as a bearer: %d, want 401", got)
	}
	// Only /api and /ws read a bearer.
	token := embedToken(t, srv, ada)
	_, sp := createSpace(t, srv, "Legacy", ada)
	req, _ = http.NewRequest("GET", srv.URL+"/s/"+sp["slug"].(string), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	client := *srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// Anonymous: no principal, so the shim falls through to the app shell.
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /s/{slug} with only a bearer: %d, want 200 (the app shell an anonymous caller gets)", resp.StatusCode)
	}
}

// TestEmbedSignOutNeverFallsBackToTheCookie: a present Authorization header
// replaces the cookie on sign out too. A bearer that does not resolve must not
// quietly sign out whoever's cookie happens to ride along.
func TestEmbedSignOutNeverFallsBackToTheCookie(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer not-a-token")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got, _ := requestStatus(srv, "GET", "/api/me", "", ada); got != http.StatusOK {
		t.Fatalf("the cookie after a DELETE /api/me carrying a dead bearer: GET /api/me %d, want 200", got)
	}
	// Control: the cookie alone does sign out.
	if got, _ := requestStatus(srv, "DELETE", "/api/me", "", ada); got != http.StatusNoContent {
		t.Fatalf("control: sign out by cookie: %d", got)
	}
	if got, _ := requestStatus(srv, "GET", "/api/me", "", ada); got != http.StatusUnauthorized {
		t.Fatalf("control: the cookie after signing out: %d, want 401", got)
	}
}

// TestEmbedSignOutWithBearerAndCookieSpendsOnlyTheBearer: a meeting frame that
// carries an embedded bearer can still have a first-party parley_session
// cookie riding along on the same request (the same browser, another tab).
// Signing out must spend only the bearer's token — never expire that cookie —
// because the cookie's own session_tokens row is untouched and still resolves.
func TestEmbedSignOutWithBearerAndCookieSpendsOnlyTheBearer(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	token := embedToken(t, srv, ada)

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("sign out with bearer + cookie: %d, want 204", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.MaxAge < 0 {
			t.Fatalf("sign out with an embedded bearer expired the first-party cookie: %+v", c)
		}
	}
	// The bearer's own token is spent.
	if got := bearerStatus(t, srv, "GET", "/api/me", "", token); got != http.StatusUnauthorized {
		t.Fatalf("GET /api/me with the spent bearer: %d, want 401", got)
	}
	// The cookie's token is still valid — its session_tokens row was never
	// touched.
	if got, _ := requestStatus(srv, "GET", "/api/me", "", ada); got != http.StatusOK {
		t.Fatalf("GET /api/me with the cookie after a bearer sign out: %d, want 200", got)
	}

	// Control: unchanged cookie-only sign-out behaviour still clears the
	// cookie and spends its token.
	req2, _ := http.NewRequest("DELETE", srv.URL+"/api/me", nil)
	req2.AddCookie(ada)
	resp2, err := srv.Client().Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	cleared := false
	for _, c := range resp2.Cookies() {
		if c.Name == sessionCookie && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("control: cookie-only sign out did not clear the cookie")
	}
	if got, _ := requestStatus(srv, "GET", "/api/me", "", ada); got != http.StatusUnauthorized {
		t.Fatalf("control: GET /api/me with the cookie after cookie-only sign out: %d, want 401", got)
	}
}

// TestEmbedMemberViewWithholdsThePasscode: GET /api/orgs/{org}/spaces/{slug}
// is on the embedded allow-list, so a phished 12h embedded bearer must not be
// able to harvest a space's passcode from its member view — the passcode is
// a credential, not room state. The same member's cookie still gets it.
func TestEmbedMemberViewWithholdsThePasscode(t *testing.T) {
	srv := embedServer(t, testPool(t))
	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Passcode Team", ada)
	if sp["passcode"] == nil || sp["passcode"] == "" {
		t.Fatalf("fixture space has no passcode: %v", sp)
	}
	token := embedToken(t, srv, ada)

	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/default/spaces/"+sp["slug"].(string), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var embedded map[string]any
	json.NewDecoder(resp.Body).Decode(&embedded)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("embedded member view: %d %v", resp.StatusCode, embedded)
	}
	if _, has := embedded["passcode"]; has {
		t.Fatalf("embedded bearer's member view leaked the passcode: %v", embedded)
	}
	if _, has := embedded["members"]; !has {
		t.Fatalf("embedded bearer's member view lost the rest of the member view: %v", embedded)
	}

	// Control: the same member's cookie still gets the passcode.
	_, cookieView := getSpace(t, srv, sp["slug"].(string), ada)
	if cookieView["passcode"] != sp["passcode"] {
		t.Fatalf("control: cookie member view passcode = %v, want %v", cookieView["passcode"], sp["passcode"])
	}
}

// TestEmbeddedSessionParticipantPowerOnly: on the routes an embedded session
// may reach, it gets exactly what the same person's cookie gets; the admin set
// and the space owner's housekeeping are refused even to an owner and admin.
func TestEmbeddedSessionParticipantPowerOnly(t *testing.T) {
	pool := testPool(t)
	srv := embedServer(t, pool)
	fac, member, sessionID := setupSession(t, srv, "Embed Space")
	outsider := signup(t, srv, "Olly")

	// Parity on the allow-list: same membership, same answer.
	for _, c := range []struct {
		who  *http.Cookie
		name string
	}{{member, "member"}, {outsider, "outsider"}} {
		token := embedToken(t, srv, c.who)
		for _, rt := range []struct{ method, path, body string }{
			{"GET", "/api/sessions/" + sessionID, ""},
			{"GET", "/api/sessions/" + sessionID + "/plugins/panels", ""},
			{"GET", "/api/orgs/default/spaces", ""},
			{"GET", "/api/spaces", ""},
		} {
			want, err := requestStatus(srv, rt.method, rt.path, rt.body, c.who)
			if err != nil {
				t.Fatal(err)
			}
			if got := bearerStatus(t, srv, rt.method, rt.path, rt.body, token); got != want {
				t.Errorf("%s %s %s: bearer %d, cookie %d", c.name, rt.method, rt.path, got, want)
			}
		}
	}

	// The admin set: an org admin's cookie is admitted, their embedded
	// session is not.
	var facID string
	_, me := doJSON(t, srv, "GET", "/api/me", "", fac)
	facID, _ = me["id"].(string)
	if _, err := pool.Exec(context.Background(), "update org_members set role = 'admin' where user_id = $1", facID); err != nil {
		t.Fatal(err)
	}
	if got, _ := requestStatus(srv, "GET", "/api/orgs/default/admin/spaces", "", fac); got != http.StatusOK {
		t.Fatalf("control: the admin's cookie on custody: %d", got)
	}
	_, sess := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", fac)
	slug, _ := sess["spaceSlug"].(string)
	token := embedToken(t, srv, fac)
	for _, rt := range []struct{ method, path, body string }{
		{"GET", "/api/orgs/default/admin/spaces", ""},
		{"GET", "/api/orgs/default/admin/members", ""},
		{"GET", "/api/orgs/default/admin/plugins/", ""},
		{"DELETE", "/api/orgs/default/", `{"confirm":"default"}`},
		{"POST", "/api/sessions/" + sessionID + "/links", "{}"},
		{"POST", "/api/links/redeem", `{"token":"x","name":"y"}`},
		{"POST", "/api/me", `{"name":"Renamed"}`},
		{"POST", "/api/me/ics", "{}"},
		// The space owner's housekeeping, which Fay holds by cookie.
		{"POST", "/api/orgs/default/spaces/" + slug + "/passcode", "{}"},
		{"PATCH", "/api/orgs/default/spaces/" + slug + "/visibility", `{"visibility":"org"}`},
		{"PUT", "/api/orgs/default/spaces/" + slug + "/standup-webhook/", `{"url":"https://example.com/hook"}`},
		{"POST", "/api/orgs/default/spaces/" + slug + "/members/" + facID + "/role", `{"role":"member"}`},
		{"DELETE", "/api/orgs/default/spaces/" + slug, ""},
	} {
		if got := bearerStatus(t, srv, rt.method, rt.path, rt.body, token); got != http.StatusForbidden {
			t.Errorf("embedded admin %s %s: %d, want 403", rt.method, rt.path, got)
		}
	}
	// …while participating still works.
	if got := bearerStatus(t, srv, "GET", "/api/sessions/"+sessionID, "", token); got != http.StatusOK {
		t.Errorf("embedded facilitator reading their room: %d", got)
	}
}

func TestEmbedWebSocketSubprotocol(t *testing.T) {
	srv := embedServer(t, testPool(t))
	fac, _, sessionID := setupSession(t, srv, "WS Space")
	token := embedToken(t, srv, fac)
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?session=" + sessionID

	d := websocket.Dialer{Subprotocols: []string{embedWSProtocol, token}}
	ws, resp, err := d.Dial(base, http.Header{"Origin": {testOrigin}})
	if err != nil {
		t.Fatalf("dial with the subprotocol: %v (%v)", err, resp)
	}
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != embedWSProtocol {
		t.Errorf("echoed subprotocol %q, want %q only", got, embedWSProtocol)
	}
	ws.Close()

	if _, resp, err := websocket.DefaultDialer.Dial(base+"&token="+url.QueryEscape(token), http.Header{"Origin": {testOrigin}}); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("a token in the query was not refused 404: %v", err)
	}
	// ?token= is refused even beside a valid credential.
	if _, resp, err := d.Dial(base+"&token=x", http.Header{"Origin": {testOrigin}}); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("?token= beside a valid subprotocol was not refused: %v", err)
	}
}

// The add-on documents are the only framable pages, and only Meet may frame
// them. The route walk fetches every GET route with Meet enabled and fails on
// anything else that goes out without X-Frame-Options: DENY; the plugin frame
// is its own carve-out and has its own walk. Off, both documents are a plain
// 404 under the full header profile.
func TestOnlyTheMeetDocumentsAreFramable(t *testing.T) {
	pool := testPool(t)
	on := embedServer(t, pool)
	router := on.Config.Handler.(*Handler).Handler.(chi.Router)

	framable := map[string]bool{}
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || strings.HasPrefix(route, pluginFramePrefix) {
			return nil
		}
		path := strings.ReplaceAll(routeParam.ReplaceAllString(route, "x"), "/*", "/x")
		resp, _ := get(t, on, path)
		if resp.Header.Get("X-Frame-Options") != "DENY" {
			framable[route] = true
		}
		return nil
	}
	if err := chi.Walk(router, walk); err != nil {
		t.Fatal(err)
	}
	docs := []string{"/embed/meet/sidepanel", "/embed/meet/mainstage"}
	if len(framable) != len(docs) || !framable[docs[0]] || !framable[docs[1]] {
		t.Fatalf("framable routes = %v, want exactly %v", framable, docs)
	}

	off := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	for _, doc := range docs {
		// Meet appends meet_sdk to the frame URL: it must be served, not redirected.
		resp, body := get(t, on, doc+"?meet_sdk=abc")
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `id="root"`) {
			t.Fatalf("%s: %d, want the app shell", doc, resp.StatusCode)
		}
		csp := resp.Header.Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'self'", "script-src 'self' https://www.gstatic.com/meetjs/addons/1.1.0/;", "frame-ancestors https://meet.google.com"} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s CSP %q lacks %q", doc, csp, want)
			}
		}
		// The SDK's own directory, never the whole host: gstatic.com serves
		// every Google library, and a host source would admit all of them.
		if strings.Contains(csp, "https://www.gstatic.com ") || strings.Contains(csp, "https://www.gstatic.com;") {
			t.Errorf("%s CSP %q allows scripts from the whole gstatic host", doc, csp)
		}
		if !strings.HasSuffix(csp, "frame-ancestors https://meet.google.com") {
			t.Errorf("%s CSP %q lets more than Meet frame it", doc, csp)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s does not send nosniff", doc)
		}
		resp, _ = get(t, off, doc)
		if resp.StatusCode != http.StatusNotFound || resp.Header.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s with embedding off: %d XFO %q, want a 404 under DENY", doc, resp.StatusCode, resp.Header.Get("X-Frame-Options"))
		}
	}
}
