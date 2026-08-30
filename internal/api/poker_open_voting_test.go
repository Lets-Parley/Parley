package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The autoReveal x openVoting matrix, all four combinations:
//
//	on  x on  — TestOpenRoundCompletesWithNobodyConnected
//	off x on  — TestOpenRoundWithAutoRevealOffStaysManual
//	on  x off — TestClosedRoundIgnoresAnAbsentMember
//	off x off — TestAutoRevealDefaultsOff (poker_test.go)

func setConfig(t *testing.T, srv *httptest.Server, sessionID, body string, c *http.Cookie) {
	t.Helper()
	if resp, _ := doJSON(t, srv, "PATCH", "/api/sessions/"+sessionID+"/actions/config", body, c); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("patch config %s: %d", body, resp.StatusCode)
	}
}

func revealed(t *testing.T, srv *httptest.Server, sessionID string, c *http.Cookie) bool {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", c)
	return env["revealed"] == true
}

// An open round is estimated asynchronously: nobody has to be connected for a
// vote to complete it, which is exactly what the connected-set denominator
// made impossible.
func TestOpenRoundCompletesWithNobodyConnected(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Async Space")
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Async story", fac)
	selectStory(t, srv, id, story, fac)

	if resp := vote(t, srv, id, story, "3", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("facilitator vote: %d", resp.StatusCode)
	}
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed with one of two votes")
	}
	if resp := vote(t, srv, id, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("member vote: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("open round did not complete once every expected voter had cast")
	}
}

// Open voting is not a reveal of its own: with auto-reveal off the facilitator
// still opens the round by hand.
func TestOpenRoundWithAutoRevealOffStaysManual(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Manual Space")
	setConfig(t, srv, id, `{"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Manual story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if revealed(t, srv, id, fac) {
		t.Fatal("open voting revealed a round with auto-reveal off")
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("facilitator reveal did not open the round")
	}
}

// A link guest present when the round opened is one of the expected voters,
// and the round waits for it.
func TestOpenRoundWaitsForALinkGuestPresentWhenItOpened(t *testing.T) {
	srv := testServer(t)
	fac, slug, id, guest := mintAndRedeemIn(t, srv, "Open Guest Space")
	member := signup(t, srv, "Mel")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/"+slug, "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Guest story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed before the link guest had voted")
	}
	if resp := vote(t, srv, id, story, "8", guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest vote: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("the link guest's vote did not complete the open round")
	}
}

// The snapshot is taken when the round opens, so somebody who joins the space
// afterwards is not one of its expected voters and cannot hold it open.
func TestOpenRoundIgnoresAMemberWhoJoinedAfterItOpened(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Latecomer Space")
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Latecomer story", fac)
	selectStory(t, srv, id, story, fac)

	latecomer := signup(t, srv, "Lena")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-latecomer-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-latecomer-space", latecomer, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join latecomer: %d", resp.StatusCode)
	}

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a member who joined after the round opened blocked it")
	}
}

// A spectator is not an expected voter, so an open round never waits for one.
func TestOpenRoundSkipsSpectators(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Spectator Space")
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}
	story := addStory(t, srv, id, "Spectator story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	if !revealed(t, srv, id, fac) {
		t.Fatal("an open round waited for a spectator")
	}
}

// Closed rounds are untouched: the denominator is still who is connected, so a
// member of the space who never showed up does not hold the round open. This
// is the "five-person round in a forty-person space" case.
func TestClosedRoundIgnoresAnAbsentMember(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Closed Absent Space")
	setAutoReveal(t, srv, id, true, fac)
	absent := signup(t, srv, "Abe")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/closed-absent-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "closed-absent-space", absent, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join absent: %d", resp.StatusCode)
	}
	story := addStory(t, srv, id, "Closed story", fac)
	selectStory(t, srv, id, story, fac)

	for _, c := range []*http.Cookie{fac, member} {
		ws, _, err := dialWS(t, srv, id, c, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
	}
	time.Sleep(2 * time.Second)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a member of the space who never connected blocked a closed round")
	}
}

// PATCH config is a partial update: an absent key keeps the value it has, an
// unknown key is refused, and a body with nothing in it changes nothing.
func TestConfigPatchIsPartial(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Partial Config Space")

	setConfig(t, srv, id, `{"openVoting":true}`, fac)
	setConfig(t, srv, id, `{"autoReveal":true}`, fac)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	st := env["state"].(map[string]any)
	if st["openVoting"] != true {
		t.Fatalf("openVoting = %v after a patch that only named autoReveal", st["openVoting"])
	}
	if st["autoReveal"] != true {
		t.Fatal("autoReveal did not land")
	}

	for _, body := range []string{`{}`, ``} {
		if resp, _ := doJSON(t, srv, "PATCH", "/api/sessions/"+id+"/actions/config", body, fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("empty body %q: %d, want 204", body, resp.StatusCode)
		}
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	st = env["state"].(map[string]any)
	if st["openVoting"] != true || st["autoReveal"] != true {
		t.Fatalf("an empty body changed the config: %v", st)
	}

	resp, out := doJSON(t, srv, "PATCH", "/api/sessions/"+id+"/actions/config", `{"autoRevea1":true}`, fac)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown config key: %d, want 400", resp.StatusCode)
	}
	if out["error"] == nil {
		t.Fatal("unknown config key returned no error message")
	}
	if resp, _ := doJSON(t, srv, "PATCH", "/api/sessions/"+id+"/actions/config", `{"autoReveal":"yes"}`, fac); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-boolean config value: %d, want 400", resp.StatusCode)
	}
}

// Turning open voting on mid-round records the expected voters for the story
// already on the table — otherwise that round could never complete on its own.
func TestOpenVotingTurnedOnMidRoundSnapshotsTheCurrentStory(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Mid Round Space")
	setAutoReveal(t, srv, id, true, fac)
	story := addStory(t, srv, id, "Mid-round story", fac)
	selectStory(t, srv, id, story, fac)
	setConfig(t, srv, id, `{"openVoting":true}`, fac)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("open voting turned on mid-round left the round unable to complete")
	}
}
