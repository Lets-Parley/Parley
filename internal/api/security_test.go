package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	srv := testServer(t)

	want := map[string]string{
		"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
	}

	for _, path := range []string{"/healthz", "/api/me", "/no-such-page"} {
		t.Run(path, func(t *testing.T) {
			req, err := http.NewRequest("GET", srv.URL+path, nil)
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatalf("request %s: %v", path, err)
			}
			resp.Body.Close()
			for header, value := range want {
				if got := resp.Header.Get(header); got != value {
					t.Fatalf("%s: %s header: got %q, want %q", path, header, got, value)
				}
			}
		})
	}
}

func TestCrossSiteGuardAllowsAbsentOrigin(t *testing.T) {
	srv := testServer(t)

	req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden {
		t.Fatalf("a non-browser client with no Origin header was rejected: got %d", resp.StatusCode)
	}
}

func TestCrossSiteGuardAllowsSameSiteFetch(t *testing.T) {
	srv := testServer(t)

	tests := []struct {
		secFetchSite string
		wantAllowed  bool
	}{
		{secFetchSite: "same-site", wantAllowed: true},
		{secFetchSite: "same-origin", wantAllowed: true},
		{secFetchSite: "cross-site", wantAllowed: false},
	}

	for _, tc := range tests {
		t.Run(tc.secFetchSite, func(t *testing.T) {
			req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Sec-Fetch-Site", tc.secFetchSite)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			resp.Body.Close()
			forbidden := resp.StatusCode == http.StatusForbidden
			if tc.wantAllowed && forbidden {
				t.Fatalf("Sec-Fetch-Site %q: got %d, want the request to pass the guard", tc.secFetchSite, resp.StatusCode)
			}
			if !tc.wantAllowed && !forbidden {
				t.Fatalf("Sec-Fetch-Site %q: got %d, want %d", tc.secFetchSite, resp.StatusCode, http.StatusForbidden)
			}
		})
	}
}

func TestCrossSiteGuardRejectsMismatchedOrigin(t *testing.T) {
	srv := testServer(t)

	req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("mismatched Origin: got %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

func TestRequireJSONBodyRejectsWrongContentType(t *testing.T) {
	srv := testServer(t)

	req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`name=Ada`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain body: got %d, want %d", resp.StatusCode, http.StatusUnsupportedMediaType)
	}
}

// lastUsedAt reads the single session token's activity stamp straight out of
// the table, so a test can prove a request did or did not write to it.
func lastUsedAt(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	var at time.Time
	if err := pool.QueryRow(context.Background(),
		"select last_used_at from session_tokens").Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

// The cross-site guard exempts GET because a cross-site page can send one but
// cannot read the answer — an exemption that only holds while a GET changes
// nothing. Resolving the caller's session used to renew last_used_at on every
// request, GETs included, which handed any third-party page one <img src> per
// visit to keep a victim's idle window open forever and to write to
// session_tokens without limit. A GET must resolve the principal and touch
// nothing.
func TestCrossSiteGetDoesNotRenewSession(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	ada := signup(t, srv, "Ada")
	createSpace(t, srv, "Alpha Squad", ada)

	// Back-date the stamp so any renewal is unmistakable rather than a
	// sub-millisecond difference between two now() calls.
	if _, err := pool.Exec(context.Background(),
		"update session_tokens set last_used_at = now() - interval '1 hour'"); err != nil {
		t.Fatal(err)
	}
	before := lastUsedAt(t, pool)

	// Exactly what a third-party page's <img src> looks like on the wire.
	req, _ := http.NewRequest("GET", srv.URL+"/api/spaces/alpha-squad", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cross-site GET: got %d, want the guard to still wave GETs through", resp.StatusCode)
	}
	if after := lastUsedAt(t, pool); !after.Equal(before) {
		t.Fatalf("cross-site GET renewed the session: last_used_at %v -> %v", before, after)
	}

	// A same-site GET writes nothing either: the invariant is about the
	// method, not about who sent it.
	if resp, _ := getSpace(t, srv, "alpha-squad", ada); resp.StatusCode != http.StatusOK {
		t.Fatalf("same-site GET: got %d", resp.StatusCode)
	}
	if after := lastUsedAt(t, pool); !after.Equal(before) {
		t.Fatalf("same-site GET renewed the session: last_used_at %v -> %v", before, after)
	}

	// chi routes HEAD to the GET handlers, so it is held to the same rule.
	req, _ = http.NewRequest("HEAD", srv.URL+"/api/spaces/alpha-squad", nil)
	req.AddCookie(ada)
	resp, err = srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if after := lastUsedAt(t, pool); !after.Equal(before) {
		t.Fatalf("HEAD renewed the session: last_used_at %v -> %v", before, after)
	}

	// The control: real use still keeps a session alive, so withholding the
	// touch on reads has not quietly broken idle-window renewal.
	if resp := markSeen(t, srv, "alpha-squad", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("mark seen: got %d", resp.StatusCode)
	}
	if after := lastUsedAt(t, pool); !after.After(before) {
		t.Fatalf("a write did not renew the session: last_used_at %v -> %v", before, after)
	}
}
