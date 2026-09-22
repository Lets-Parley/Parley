package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// asyncStandup creates an async standup in the space standupSpace built,
// returning the new session id.
func asyncStandup(t *testing.T, srv *httptest.Server, anySession string, fac *http.Cookie, config string) string {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+anySession, "", fac)
	slug := env["spaceSlug"].(string)
	resp, sess := doJSON(t, srv, "POST", "/api/orgs/default/spaces/"+slug+"/sessions",
		`{"kind":"standup","title":"Async","config":`+config+`}`, fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create async standup: got %d (%v)", resp.StatusCode, sess)
	}
	return sess["id"].(string)
}

// Async mode has no speaker, so the speaker actions refuse rather than
// quietly turning the room into a round-robin.
func TestAsyncStandupRefusesSpeakerActions(t *testing.T) {
	srv := testServer(t)
	cookies, _, sync := standupSpace(t, srv, "Async Speaker Space", "Amy", "Ben")
	fac, member := cookies[0], cookies[1]
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async"}`)

	defer closeAll(connectAll(t, srv, id, fac, member))()
	for _, action := range []string{"start", "next", "skip"} {
		if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+action, "", fac); resp.StatusCode != http.StatusConflict {
			t.Errorf("%s in async mode: got %d, want 409", action, resp.StatusCode)
		}
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["phase"] == "speaking" || standupState(env)["currentSpeakerId"] != nil {
		t.Errorf("a refused start still started the round: %v", env)
	}
	if got := standupState(env)["mode"]; got != "async" {
		t.Errorf("state mode = %v, want async", got)
	}
}

// Closing is a published cutoff, not an end: an answer after closesAt is
// accepted like any other and carries the time it was posted.
func TestAsyncStandupAcceptsALateAnswer(t *testing.T) {
	srv := testServer(t)
	cookies, ids, sync := standupSpace(t, srv, "Async Late Space", "Amy", "Ben")
	fac, member := cookies[0], cookies[1]
	closed := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async","closesAt":"`+closed+`"}`)

	before := time.Now().Add(-time.Minute)
	if resp, body := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"","today":"late but here","blockers":""}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("late answer: got %d (%v), want 204", resp.StatusCode, body)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["endedAt"] != nil {
		t.Errorf("passing closesAt ended the session: %v", env["endedAt"])
	}
	st := standupState(env)
	if st["closesAt"] != closed {
		t.Errorf("state closesAt = %v, want %s", st["closesAt"], closed)
	}
	entries := st["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v, want the one late answer", entries)
	}
	e := entries[0].(map[string]any)
	if e["userId"] != ids[1] || e["today"] != "late but here" {
		t.Errorf("entry = %v", e)
	}
	posted, err := time.Parse(time.RFC3339Nano, e["postedAt"].(string))
	if err != nil || posted.Before(before) {
		t.Errorf("postedAt = %v (%v), want the time it was posted", e["postedAt"], err)
	}
}

// A signed-link guest answers an async standup while its token is valid.
func TestAsyncStandupLinkGuestAnswers(t *testing.T) {
	srv := testServer(t)
	cookies, _, sync := standupSpace(t, srv, "Async Guest Space", "Amy")
	fac := cookies[0]
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async"}`)
	guest, guestID := standupLinkGuest(t, srv, id, "Gus", fac)

	if resp, body := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"","today":"from another timezone","blockers":""}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest answer: got %d (%v), want 204", resp.StatusCode, body)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest)
	found := false
	for _, e := range standupState(env)["entries"].([]any) {
		if e.(map[string]any)["userId"] == guestID {
			found = true
		}
	}
	if !found {
		t.Errorf("the guest's answer is missing from %v", standupState(env)["entries"])
	}
}
