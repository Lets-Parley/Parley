package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The cookie must expire no later than the server-side session does. Whichever
// of the two lifetimes is shorter is the one that ends the session, so that is
// the one the browser is told about: a cookie outliving the token leaves
// people signed "in" to a session the server has already dropped.
func TestSessionCookieMaxAgeIsTheSmallerLifetime(t *testing.T) {
	for _, tc := range []struct {
		name       string
		idle, max  time.Duration
		wantMaxAge int
	}{
		// 2160h = 90 days = 7776000s, the shipped default for both.
		{"defaults", 2160 * time.Hour, 2160 * time.Hour, 7776000},
		// 8h idle inside a 30-day cap: 8 * 3600.
		{"idle is shorter", 8 * time.Hour, 720 * time.Hour, 28800},
		// A 24h absolute cap under a 2160h idle window: 24 * 3600.
		{"absolute is shorter", 2160 * time.Hour, 24 * time.Hour, 86400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &app{sessionIdleTTL: tc.idle, sessionMaxTTL: tc.max}
			w := httptest.NewRecorder()
			a.setSessionCookie(w, "tok")
			for _, c := range w.Result().Cookies() {
				if c.Name == sessionCookie {
					if c.MaxAge != tc.wantMaxAge {
						t.Fatalf("cookie Max-Age = %d, want %d", c.MaxAge, tc.wantMaxAge)
					}
					return
				}
			}
			t.Fatal("session cookie not set")
		})
	}
}

// api.Options carrying the lifetimes is only half the wiring: Router has to
// hand them to the store.Users it builds, and nothing in the cookie test above
// would notice if it did not. This drives the whole seam — Options in, a real
// request refused out — so an Options field that never reaches the store is a
// failure here rather than a silently 90-day session in production.
func TestRouterGivesTheStoreTheConfiguredLifetimes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	// A four-hour absolute cap under a ninety-day idle window: only the cap
	// can refuse a token created five hours ago and used a moment ago.
	srv := testServerWith(t, pool, Options{
		AllowedOrigin:  "http://example.test",
		SessionIdleTTL: 2160 * time.Hour,
		SessionMaxTTL:  4 * time.Hour,
	})
	resp, body := postMe(t, srv, "Wired", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/me = %d, want 201", resp.StatusCode)
	}
	cookie := sessionCookieOf(t, resp)
	userID, _ := body["id"].(string)
	if userID == "" {
		t.Fatalf("POST /api/me returned no id: %v", body)
	}

	if got, _ := getMe(t, srv, cookie); got.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me on a fresh session = %d, want 200", got.StatusCode)
	}

	if _, err := pool.Exec(ctx,
		"update session_tokens set created_at = now() - interval '5 hours' where user_id = $1",
		userID); err != nil {
		t.Fatal(err)
	}
	if got, _ := getMe(t, srv, cookie); got.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /api/me on a 5h-old session under SESSION_MAX_TTL=4h = %d, want 401", got.StatusCode)
	}

	// The control: the same 5h-old row on an instance that left the lifetimes
	// at their defaults still resolves, so the 401 above is the configured cap
	// and not the backdating.
	def := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	if got, _ := getMe(t, def, cookie); got.StatusCode != http.StatusOK {
		t.Errorf("GET /api/me on a 5h-old session under the 90-day defaults = %d, want 200", got.StatusCode)
	}
}
