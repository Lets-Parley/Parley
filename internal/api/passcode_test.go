package api

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPasscodeNormalizeAndMatch(t *testing.T) {
	if !passcodeMatches("K7M2QX", "k7m2 qx") {
		t.Fatal("a pasted code with a space should still match")
	}
	if !passcodeMatches("K7M2QX", "K7M2-QX") {
		t.Fatal("a hyphenated code should still match")
	}
	if passcodeMatches("K7M2QX", "K7M2QY") {
		t.Fatal("a wrong code matched")
	}
	if passcodeMatches("K7M2QX", "") {
		t.Fatal("an empty code matched a protected space")
	}
}

func TestNewPasscodeShape(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		code := newPasscode()
		if len(code) != passcodeLength {
			t.Fatalf("length %d: %q", len(code), code)
		}
		for _, r := range code {
			if !strings.ContainsRune(passcodeAlphabet, r) {
				t.Fatalf("character %q outside the alphabet: %q", r, code)
			}
		}
		seen[code] = true
	}
	// Not a randomness test — just a guard against a constant generator.
	if len(seen) < 190 {
		t.Fatalf("only %d distinct codes out of 200", len(seen))
	}
}

func TestAttemptLimiterWindow(t *testing.T) {
	now := time.Unix(0, 0)
	l := newAttemptLimiter()
	l.now = func() time.Time { return now }

	for i := range passcodeAttemptLimit {
		if !l.allow("addr|space") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if l.allow("addr|space") {
		t.Fatal("the attempt past the limit should be refused")
	}
	// A different caller is unaffected by someone else's guessing.
	if !l.allow("other|space") {
		t.Fatal("a different key should have its own budget")
	}
	// The window slides.
	now = now.Add(passcodeAttemptWindow + time.Second)
	if !l.allow("addr|space") {
		t.Fatal("the budget should refill after the window")
	}
	if len(l.hits) > 2 {
		t.Fatalf("expired keys were not swept: %d", len(l.hits))
	}
}

func TestSpacePasscodeGate(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")

	_, created := doJSON(t, srv, "POST", "/api/spaces", `{"name":"Locked Room"}`, owner)
	code, _ := created["passcode"].(string)
	if code == "" || created["protected"] != true {
		t.Fatalf("a new space should be protected by default: %v", created)
	}

	// A stranger learns the name and that a code is needed — nothing else.
	stranger := signup(t, srv, "Stranger")
	_, view := doJSON(t, srv, "GET", "/api/spaces/locked-room", "", stranger)
	if view["protected"] != true || view["members"] != nil || view["passcode"] != nil {
		t.Fatalf("stranger view leaked something: %v", view)
	}

	// Wrong code is refused with copy that names the problem.
	resp, body := doJSON(t, srv, "POST", "/api/spaces/locked-room/join", `{"passcode":"AAAAAA"}`, stranger)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong passcode: %d", resp.StatusCode)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "6 characters") {
		t.Fatalf("unhelpful error: %v", body["error"])
	}

	// Right code gets in, and the roster then carries the code for sharing.
	if resp, _ := doJSON(t, srv, "POST", "/api/spaces/locked-room/join",
		`{"passcode":"`+strings.ToLower(code)+`"}`, stranger); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("correct passcode rejected: %d", resp.StatusCode)
	}
	_, member := doJSON(t, srv, "GET", "/api/spaces/locked-room", "", stranger)
	if member["passcode"] != code {
		t.Fatalf("members should be able to read the code: %v", member["passcode"])
	}

	// Re-joining as a member never re-presents the code.
	if resp, _ := doJSON(t, srv, "POST", "/api/spaces/locked-room/join", "", stranger); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("member rejoin: %d", resp.StatusCode)
	}

	// Rotating invalidates the old code.
	_, rotated := doJSON(t, srv, "POST", "/api/spaces/locked-room/passcode", "", owner)
	next, _ := rotated["passcode"].(string)
	if next == "" || next == code {
		t.Fatalf("rotate should mint a new code: %v", rotated)
	}
	outsider := signup(t, srv, "Late")
	if resp, _ := doJSON(t, srv, "POST", "/api/spaces/locked-room/join",
		`{"passcode":"`+code+`"}`, outsider); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("the retired code still worked: %d", resp.StatusCode)
	}

	// Opening the space drops the door entirely.
	if resp, opened := doJSON(t, srv, "POST", "/api/spaces/locked-room/passcode", `{"open":true}`, owner); opened["protected"] != false {
		t.Fatalf("open: %d %v", resp.StatusCode, opened)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/spaces/locked-room/join", "", outsider); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("open space should admit anyone: %d", resp.StatusCode)
	}
}

func TestSpacePasscodeThrottled(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	doJSON(t, srv, "POST", "/api/spaces", `{"name":"Throttle Room"}`, owner)

	guesser := signup(t, srv, "Guesser")
	var last int
	for range passcodeAttemptLimit + 2 {
		resp, _ := doJSON(t, srv, "POST", "/api/spaces/throttle-room/join", `{"passcode":"ZZZZZZ"}`, guesser)
		last = resp.StatusCode
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("guessing was never throttled: last status %d", last)
	}
}

func TestOpenSpaceOnRequest(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := doJSON(t, srv, "POST", "/api/spaces", `{"name":"Open Room","open":true}`, owner)
	if created["protected"] != false || created["passcode"] != "" {
		t.Fatalf("explicitly open space: %v", created)
	}
	stranger := signup(t, srv, "Stranger")
	if resp, _ := doJSON(t, srv, "POST", "/api/spaces/open-room/join", "", stranger); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("open space join: %d", resp.StatusCode)
	}
}
