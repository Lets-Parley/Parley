package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/db"
)

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := db.Migrate(context.Background(), pool, log); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Router(pool, false))
	t.Cleanup(srv.Close)
	return srv
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
	resp, _ := getMe(t, srv, forged)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged cookie: got %d, want 401", resp.StatusCode)
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
