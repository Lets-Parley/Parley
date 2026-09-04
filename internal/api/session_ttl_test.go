package api

import (
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
