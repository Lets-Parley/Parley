package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/store"
)

// testPool hands back an empty, migrated database. Every caller starts from a
// dropped schema, so tests never inherit each other's rows.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := dbtest.DSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(), "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := db.Migrate(context.Background(), pool, log, db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	return testServerWith(t, testPool(t), Options{AllowedOrigin: "http://example.test"})
}

func testServerWith(t *testing.T, pool *pgxpool.Pool, opts Options) *httptest.Server {
	t.Helper()
	// The notification listener has to be bounded or it outlives the test.
	if opts.Context == nil {
		opts.Context = testContext(t)
	}
	handler := Router(pool, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})
	return srv
}

// testContext bounds background work (the cross-replica notification listener)
// to the life of the test, so it does not outlive the pool it borrows from.
func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

func postMe(t *testing.T, srv *httptest.Server, name string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func postMeFrom(t *testing.T, srv *httptest.Server, name, forwardedFor string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func sessionCookieOf(t *testing.T, resp *http.Response) *http.Cookie {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("no session cookie set")
	return nil
}

func getMe(t *testing.T, srv *httptest.Server, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func TestCreateThenRefreshKeepsIdentity(t *testing.T) {
	srv := testServer(t)

	resp, created := postMe(t, srv, "Ada", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", resp.StatusCode)
	}
	cookie := sessionCookieOf(t, resp)
	if !cookie.HttpOnly || cookie.Path != "/" {
		t.Fatalf("cookie attributes wrong: %+v", cookie)
	}

	resp2, me := getMe(t, srv, cookie)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("get me: got %d", resp2.StatusCode)
	}
	if me["id"] != created["id"] || me["name"] != "Ada" {
		t.Fatalf("identity not preserved: created=%v me=%v", created, me)
	}
}

func TestForgedCookieRejected(t *testing.T) {
	srv := testServer(t)

	forged := &http.Cookie{Name: sessionCookie, Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
	resp, body := getMe(t, srv, forged)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged cookie: got %d, want 401", resp.StatusCode)
	}
	if body["error"] != "session ended" {
		t.Fatalf("forged cookie error: got %v, want session ended", body["error"])
	}
}

func TestNoCookieIsNotSignedIn(t *testing.T) {
	srv := testServer(t)

	resp, body := getMe(t, srv, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: got %d, want 401", resp.StatusCode)
	}
	if body["error"] != "not signed in" {
		t.Fatalf("no cookie error: got %v, want not signed in", body["error"])
	}
}

func TestRenamePreservesIDAndRotatesToken(t *testing.T) {
	srv := testServer(t)

	resp, created := postMe(t, srv, "Ada", nil)
	oldCookie := sessionCookieOf(t, resp)

	resp2, renamed := postMe(t, srv, "Grace", oldCookie)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d", resp2.StatusCode)
	}
	if renamed["id"] != created["id"] {
		t.Fatalf("rename minted a new user: %v vs %v", renamed["id"], created["id"])
	}
	newCookie := sessionCookieOf(t, resp2)
	if newCookie.Value == oldCookie.Value {
		t.Fatal("token was not rotated on rename")
	}

	if resp3, _ := getMe(t, srv, oldCookie); resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old token still valid after rotation: got %d", resp3.StatusCode)
	}
	if resp4, me := getMe(t, srv, newCookie); resp4.StatusCode != http.StatusOK || me["name"] != "Grace" {
		t.Fatalf("new token invalid after rename: %d %v", resp4.StatusCode, me)
	}
}

func TestLogoutInvalidatesToken(t *testing.T) {
	srv := testServer(t)

	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp2, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: got %d", resp2.StatusCode)
	}

	if resp3, _ := getMe(t, srv, cookie); resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token still valid after logout: got %d", resp3.StatusCode)
	}
}

func TestLogoutReportsTokenDeletionFailure(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://unused:unused@127.0.0.1/unused")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()

	a := &app{users: &store.Users{Pool: pool}, hub: hub.New()}
	t.Cleanup(a.hub.Shutdown)
	plain, _ := store.NewToken()
	req := httptest.NewRequest(http.MethodDelete, "/api/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: plain})
	rec := httptest.NewRecorder()

	a.handleDeleteMe(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("logout after token deletion failure = %d, want 500", rec.Code)
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookie && cookie.MaxAge < 0 {
			t.Fatal("logout cleared the browser cookie after database revocation failed")
		}
	}
}

func TestNameValidation(t *testing.T) {
	srv := testServer(t)

	if resp, _ := postMe(t, srv, "", nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty name: got %d", resp.StatusCode)
	}
	if resp, _ := postMe(t, srv, strings.Repeat("x", 65), nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("65-char name: got %d", resp.StatusCode)
	}
}

func TestNonJSONBodyRejected(t *testing.T) {
	srv := testServer(t)

	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader("name=Ada"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("form post: got %d, want 415", resp.StatusCode)
	}
}

func TestOversizedJSONBodyReturnsPayloadTooLarge(t *testing.T) {
	a := &app{authMode: ModeOpen}
	req := httptest.NewRequest(http.MethodPost, "/api/me", strings.NewReader(`{"name":"`+strings.Repeat("x", 64<<10)+`"}`))
	rec := httptest.NewRecorder()

	a.handlePostMe(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized JSON status = %d, want 413", rec.Code)
	}
}

func TestOpenIdentityCreationEnforcesPerClientHourlyLimit(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin: "http://example.test",
		Limits:        Limits{IdentityIPHourly: 2, IdentityGlobalHourly: 20},
	})
	for i := 0; i < 2; i++ {
		if resp := postMeFrom(t, srv, "Allowed", ""); resp.StatusCode != http.StatusCreated {
			t.Fatalf("creation %d = %d, want 201", i+1, resp.StatusCode)
		}
	}
	resp := postMeFrom(t, srv, "Blocked", "")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("exhausted client limit = %d, want 429", resp.StatusCode)
	}
	retryAfter, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	if err != nil || retryAfter < 1 || retryAfter > 3600 {
		t.Fatalf("Retry-After = %q, want seconds until the hourly reset", resp.Header.Get("Retry-After"))
	}
}

func TestOpenIdentityCreationEnforcesGlobalHourlyLimit(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:     "http://example.test",
		TrustProxyHeaders: true,
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
		Limits:            Limits{IdentityIPHourly: 20, IdentityGlobalHourly: 2},
	})
	for i, addr := range []string{"198.51.100.1", "198.51.100.2"} {
		if resp := postMeFrom(t, srv, "Allowed", addr); resp.StatusCode != http.StatusCreated {
			t.Fatalf("creation %d = %d, want 201", i+1, resp.StatusCode)
		}
	}
	if resp := postMeFrom(t, srv, "Blocked", "198.51.100.3"); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("exhausted global limit = %d, want 429", resp.StatusCode)
	}
}

func TestConcurrentOpenIdentityCreationCannotExceedClientLimit(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: "http://example.test",
		Limits:        Limits{IdentityIPHourly: 3, IdentityGlobalHourly: 20},
	})

	const attempts = 12
	statuses := concurrentStatuses(t, attempts, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/me", fmt.Sprintf(`{"name":"Person %d"}`, i), nil)
	})
	created := 0
	for _, status := range statuses {
		if status == http.StatusCreated {
			created++
		} else if status != http.StatusTooManyRequests {
			t.Fatalf("concurrent creation status = %d, want 201 or 429", status)
		}
	}
	if created != 3 {
		t.Fatalf("created %d identities, want exactly 3", created)
	}
	var stored int
	if err := pool.QueryRow(context.Background(), "select count(*) from users").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 3 {
		t.Fatalf("stored %d identities, want exactly 3", stored)
	}
}
