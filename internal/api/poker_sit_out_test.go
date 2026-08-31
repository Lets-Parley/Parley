package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// sitOut flips the caller's own spectator flag, the way the room's own control
// does.
func sitOut(t *testing.T, srv *httptest.Server, sessionID string, on bool, c *http.Cookie) {
	t.Helper()
	body := `{"on":false}`
	if on {
		body = `{"on":true}`
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+sessionID+"/spectator", body, c); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator %s: %d", body, resp.StatusCode)
	}
}

// addToSpace signs a third person up and puts them in the space.
func addToSpace(t *testing.T, srv *httptest.Server, slug, name string, fac *http.Cookie) *http.Cookie {
	t.Helper()
	c := signup(t, srv, name)
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/"+slug, "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, c, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join %s: %d", name, resp.StatusCode)
	}
	return c
}

// The last person a closed round is waiting on sits out, and the round is
// complete at that moment — not later, when somebody else happens to act.
func TestSitOutCompletesAClosedRound(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Sit Out Closed Space")
	setAutoReveal(t, srv, id, true, fac)
	story := addStory(t, srv, id, "Closed sit-out story", fac)
	selectStory(t, srv, id, story, fac)
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	time.Sleep(2 * time.Second) // let presence settle

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("closed round revealed with one of two votes")
	}
	sitOut(t, srv, id, true, member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("the last outstanding voter sat out and the round stayed open")
	}
}

// Sitting back down before the reveal puts you back in the set the round is
// waiting for: the wait is restored, not merely paused.
func TestReturningFromSittingOutRestoresTheClosedWait(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Sit Out Return Space")
	other := addToSpace(t, srv, "sit-out-return-space", "Ora", fac)
	setAutoReveal(t, srv, id, true, fac)
	story := addStory(t, srv, id, "Closed return story", fac)
	selectStory(t, srv, id, story, fac)
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, other)
	time.Sleep(2 * time.Second)

	vote(t, srv, id, story, "3", fac)
	sitOut(t, srv, id, true, member)
	if revealed(t, srv, id, fac) {
		t.Fatal("round revealed while a third estimator had not cast")
	}
	sitOut(t, srv, id, false, member)
	vote(t, srv, id, story, "5", other)
	if revealed(t, srv, id, fac) {
		t.Fatal("sitting back down did not restore the wait")
	}
	vote(t, srv, id, story, "8", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("the returning voter's own vote did not complete the round")
	}
}

// The same, against an open round: the expected set is the snapshot taken when
// the round opened, and sitting out takes you out of it.
func TestSitOutCompletesAnOpenRound(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Sit Out Open Space")
	other := addToSpace(t, srv, "sit-out-open-space", "Ora", fac)
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, other)
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Open sit-out story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", other)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed while an expected voter had not cast")
	}
	sitOut(t, srv, id, true, member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("the last expected voter sat out and the open round stayed open")
	}
}

// And back again, against the snapshot.
func TestReturningFromSittingOutRestoresTheOpenWait(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Sit Out Open Return Space")
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Open return story", fac)
	selectStory(t, srv, id, story, fac)

	sitOut(t, srv, id, true, member)
	sitOut(t, srv, id, false, member)
	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("sitting back down did not restore the open wait")
	}
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("the returning voter's own vote did not complete the open round")
	}
}

// With auto-reveal off a toggle changes the roster and nothing else.
func TestSitOutWithAutoRevealOffRevealsNothing(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Sit Out Manual Space")
	story := addStory(t, srv, id, "Manual sit-out story", fac)
	selectStory(t, srv, id, story, fac)
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	time.Sleep(2 * time.Second)

	vote(t, srv, id, story, "3", fac)
	sitOut(t, srv, id, true, member)
	if revealed(t, srv, id, fac) {
		t.Fatal("a spectator toggle revealed a round with auto-reveal off")
	}
}

// The toggle is a core route shared with standup, and standup has no round to
// reveal: it must keep meaning exactly what it meant.
func TestStandupSpectatorToggleIsUnaffected(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Sit Out Standup Space", "Amy Stone", "Ben Ito")
	sitOut(t, srv, id, true, cookies[1])
	if resp := setReadyAs(t, srv, id, cookies[1], true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator ready: %d", resp.StatusCode)
	}
	if e := entriesByUser(t, srv, id, cookies[0])[ids[1]]; e != nil {
		t.Fatalf("the standup spectator gained an entry row: %v", e)
	}
	sitOut(t, srv, id, false, cookies[1])
	if resp := setReadyAs(t, srv, id, cookies[1], true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("returning ready: %d", resp.StatusCode)
	}
	if e := entriesByUser(t, srv, id, cookies[0])[ids[1]]; e == nil {
		t.Fatal("sitting back down in standup did not restore the entry row")
	}
}
