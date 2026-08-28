package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// joinFrom sends a join attempt carrying a forged forwarded-for header, which
// is what an attacker controls when the server is reachable directly.
func joinFrom(t *testing.T, srv *httptest.Server, slug, forwardedFor, passcode string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/orgs/default/spaces/"+slug+"/join",
		strings.NewReader(`{"passcode":"`+passcode+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

// The room-code throttle is the only thing standing between a six-character
// code and a script. If a header the caller writes can reset the counter, the
// throttle may as well not exist.
func TestPasscodeThrottleSurvivesForgedForwardedFor(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Platform Team", owner)
	slug := sp["slug"].(string)

	guesser := signup(t, srv, "Guesser")
	throttled := false
	for i := range 40 {
		// A fresh address every time: with the header trusted, each guess looks
		// like a different client and the limiter never fires.
		resp := joinFrom(t, srv, slug, fmt.Sprintf("10.0.0.%d", i+1), "WRONGX", guesser)
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
			break
		}
	}
	if !throttled {
		t.Error("40 wrong guesses from forged addresses were all allowed — the throttle is bypassable by setting X-Forwarded-For")
	}
}

// A team behind one office address is a single client to this limiter, so
// counting the people who typed the code correctly locks out the stragglers.
func TestSuccessfulJoinsDoNotConsumeTheGuessBudget(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin: "http://example.test",
		Limits:        Limits{IdentityIPHourly: passcodeAttemptLimit + 10},
	})
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Platform Team", owner)
	slug, code := sp["slug"].(string), sp["passcode"].(string)

	for i := range passcodeAttemptLimit + 4 {
		member := signup(t, srv, fmt.Sprintf("Teammate %d", i))
		resp := joinSpace(t, srv, slug, member, code)
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("teammate %d with the correct code got %d, want 204 — successful joins must not count against the guess budget", i+1, resp.StatusCode)
		}
	}
}
