package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The whole point of keeping the counter in Postgres: two replicas share one
// budget. Split the eight guesses across two routers backed by the same
// database and the ninth still has to be refused — with a per-process counter
// each replica hands out its own eight, so N replicas mean 8N guesses.
func TestPasscodeThrottleHoldsAcrossReplicas(t *testing.T) {
	pool := testPool(t)
	one := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	two := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	owner := signup(t, one, "Owner")
	doJSON(t, one, "POST", "/api/spaces", `{"name":"Split Room"}`, owner)
	guesser := signup(t, one, "Guesser")

	guess := func(srv *httptest.Server) int {
		resp, _ := doJSON(t, srv, "POST", "/api/spaces/split-room/join", `{"passcode":"ZZZZZZ"}`, guesser)
		return resp.StatusCode
	}

	for i := range passcodeAttemptLimit {
		srv := one
		if i%2 == 1 {
			srv = two
		}
		if got := guess(srv); got != http.StatusForbidden {
			t.Fatalf("guess %d: status %d, want %d", i+1, got, http.StatusForbidden)
		}
	}
	if got := guess(two); got != http.StatusTooManyRequests {
		t.Fatalf("the guess past the shared limit returned %d, want %d — the budget is per replica", got, http.StatusTooManyRequests)
	}
}
