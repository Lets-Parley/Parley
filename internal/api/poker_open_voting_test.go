package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The autoReveal x openVoting matrix, all four combinations:
//
//	on  x on  — TestOpenRoundCompletesWithNobodyConnected
//	off x on  — TestOpenRoundWithAutoRevealOffStaysManual
//	on  x off — TestClosedRoundIgnoresAnAbsentMember
//	off x off — TestAutoRevealDefaultsOff (poker_test.go)

// joinRoom attaches to a room the way a person does. The websocket handshake
// is what records that somebody belongs to this session, and that record is
// durable: it outlives the connection, so a round opened later still waits for
// them even though they have gone. Reading the opening frame is the
// handshake's own acknowledgement that the join has landed, which is what
// makes this deterministic instead of a sleep.
func joinRoom(t *testing.T, srv *httptest.Server, sessionID string, c *http.Cookie) *websocket.Conn {
	t.Helper()
	ws, _, err := dialWS(t, srv, sessionID, c, testOrigin)
	if err != nil {
		t.Fatalf("join room: %v", err)
	}
	t.Cleanup(func() { ws.Close() })
	if _, ok := readEnvelope(t, ws, 5*time.Second); !ok {
		t.Fatal("join room: no opening frame")
	}
	return ws
}

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
	// Both join the room and both go away again: the round is opened, and
	// completed, with nobody holding a connection.
	joinRoom(t, srv, id, fac).Close()
	joinRoom(t, srv, id, member).Close()
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
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, guest)
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

// The snapshot is taken when the round opens, so somebody who first turns up
// afterwards is not one of its expected voters. Two halves, and the second is
// the one that bites: they cannot hold the round open, and their vote — cast
// from outside the recorded set — must not hold it open either. A latecomer
// who only joins never exercises that second half, because an empty
// voters-minus-expected set satisfies a subset check for free.
func TestOpenRoundIgnoresAMemberWhoJoinedAfterItOpened(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Latecomer Space")
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Latecomer story", fac)
	selectStory(t, srv, id, story, fac)

	latecomer := signup(t, srv, "Lena")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-latecomer-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-latecomer-space", latecomer, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join latecomer: %d", resp.StatusCode)
	}
	joinRoom(t, srv, id, latecomer)

	// The latecomer votes, so their vote sits outside the recorded set while
	// the round is still short of it.
	if resp := vote(t, srv, id, story, "8", latecomer); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("latecomer vote: %d", resp.StatusCode)
	}
	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed before every expected voter had cast")
	}
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a vote from somebody who turned up after the round opened held it shut")
	}
}

// A spectator is not an expected voter, so an open round never waits for one.
func TestOpenRoundSkipsSpectators(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Spectator Space")
	other := signup(t, srv, "Ora")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-spectator-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-spectator-space", other, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join other: %d", resp.StatusCode)
	}
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, other)
	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}
	story := addStory(t, srv, id, "Spectator story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	// The spectator is out of the set, but the third estimator is still in it:
	// without this the test would pass just as well against a reveal that
	// fires on the first vote.
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed while an expected voter had not cast")
	}
	vote(t, srv, id, story, "5", other)
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
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	setAutoReveal(t, srv, id, true, fac)
	story := addStory(t, srv, id, "Mid-round story", fac)
	selectStory(t, srv, id, story, fac)
	setConfig(t, srv, id, `{"openVoting":true}`, fac)

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("the mid-round snapshot revealed with one of two votes")
	}
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("open voting turned on mid-round left the round unable to complete")
	}
}

// AC3, on the open path: a small round inside a big space. Everybody who is
// actually here estimates, and the members who never came to this room — the
// other thirty-five of the forty — are not part of it and cannot hold it open.
func TestOpenRoundInABigSpaceWaitsOnlyForItsParticipants(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Big Space")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-big-space", "", fac)
	code, _ := sp["passcode"].(string)
	for _, name := range []string{"Ada", "Bo", "Cy", "Di", "Eli"} {
		bystander := signup(t, srv, name)
		if resp := joinSpace(t, srv, "open-big-space", bystander, code); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join %s: %d", name, resp.StatusCode)
		}
	}
	// Only these two ever come to the room.
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Big space story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed with one of two votes")
	}
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("members of the space who never came to this room blocked the round")
	}
}

// AC1: belonging to a session is durable, not a reading of who is plugged in.
// Somebody who has been here but is away when the story goes on the table is
// still one of the people the round is waiting for, and their vote — cast
// after everybody else has finished, with no connection at all — completes it.
func TestOpenRoundWaitsForAParticipantWhoWasOfflineWhenItOpened(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Offline Space")
	joinRoom(t, srv, id, fac)
	// The member turns up, then leaves before the round is opened.
	joinRoom(t, srv, id, member).Close()

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Offline story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("the round stopped waiting for somebody who was merely away")
	}
	if resp := vote(t, srv, id, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("offline member vote: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("a returning participant's vote did not complete the round")
	}
}

// A person recorded when the round opened, then removed from the space, is no
// longer somebody who can vote — so the round must stop waiting for them.
// Otherwise auto-reveal is dead for that round forever: the votes it wants can
// never arrive, and only a manual reveal can end it.
func TestOpenRoundStopsWaitingForAMemberWhoLeftTheSpace(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Departed Space")
	leaver, leaverID := signupWithID(t, srv, "Lou")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-departed-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-departed-space", leaver, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join leaver: %d", resp.StatusCode)
	}
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, leaver)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Departed story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	vote(t, srv, id, story, "5", member)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed while a recorded voter was still expected")
	}
	if resp, body := doJSON(t, srv, "DELETE",
		"/api/orgs/default/spaces/open-departed-space/members/"+leaverID, "", fac); resp.StatusCode >= 300 {
		t.Fatalf("remove member: %d (%v)", resp.StatusCode, body)
	}
	// Nothing else happens in the room: the next vote is what re-tests the
	// round, so the facilitator re-casts theirs.
	vote(t, srv, id, story, "3", fac)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a member who left the space wedged auto-reveal shut for the round")
	}
}

// The same shape for a link guest: once the link is revoked the guest cannot
// vote, so the round must not go on waiting for one.
func TestOpenRoundStopsWaitingForAGuestWhoseLinkWasRevoked(t *testing.T) {
	srv := testServer(t)
	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Open Revoked Space", fac)
	slug := sp["slug"].(string)
	_, sess := createSession(t, srv, slug, "poker", "Sprint 12", fac)
	id := sess["id"].(string)
	_, minted := mintLink(t, srv, id, fac)
	linkID, _ := minted["id"].(string)
	token, _ := minted["token"].(string)
	if linkID == "" || token == "" {
		t.Fatalf("mint returned no id/token: %v", minted)
	}
	r, body, guest := redeem(t, srv, token, "Gus")
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: %d (%v)", r.StatusCode, body)
	}
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, guest)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Revoked guest story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed while the guest was still expected")
	}
	if resp, out := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode >= 300 {
		t.Fatalf("revoke link: %d (%v)", resp.StatusCode, out)
	}
	vote(t, srv, id, story, "3", fac)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a revoked link guest wedged auto-reveal shut for the round")
	}
}

// Read the recorded set directly rather than inferring it from a reveal: the
// people who have joined this session, minus the spectators, and nobody else.
func TestOpeningAStoryRecordsExactlyTheParticipants(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, facID := signupWithID(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Roster Space", fac)
	slug := sp["slug"].(string)
	code, _ := sp["passcode"].(string)
	_, sess := createSession(t, srv, slug, "poker", "Sprint 12", fac)
	id := sess["id"].(string)

	estimator, estimatorID := signupWithID(t, srv, "Mel")
	watcher, _ := signupWithID(t, srv, "Wes")
	absentee, _ := signupWithID(t, srv, "Abe")
	for _, c := range []*http.Cookie{estimator, watcher, absentee} {
		if resp := joinSpace(t, srv, slug, c, code); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join space: %d", resp.StatusCode)
		}
	}
	// Everybody but the absentee comes to the room; the watcher then makes
	// themselves a spectator.
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, estimator)
	joinRoom(t, srv, id, watcher)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, watcher); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}

	setConfig(t, srv, id, `{"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Roster story", fac)
	selectStory(t, srv, id, story, fac)

	rows, err := pool.Query(context.Background(),
		"select user_id::text from round_voters where story_id = $1", story)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := []string{}
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			t.Fatal(err)
		}
		got = append(got, uid)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{facID, estimatorID}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("round_voters = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("round_voters = %v, want %v", got, want)
		}
	}
}
