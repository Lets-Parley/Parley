package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// commitments reads the open commitments off the wire, keyed by id.
func commitments(t *testing.T, srv *httptest.Server, id string, as *http.Cookie) map[string]map[string]any {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", as)
	out := map[string]map[string]any{}
	raw, ok := standupState(env)["commitments"].([]any)
	if !ok {
		t.Fatalf("commitments missing from the standup state: %v", standupState(env))
	}
	for _, c := range raw {
		m := c.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func addCommitment(t *testing.T, srv *httptest.Server, id string, as *http.Cookie, text string) string {
	t.Helper()
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/add", `{"text":"`+text+`"}`, as)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add %q: %d", text, resp.StatusCode)
	}
	for cid, c := range commitments(t, srv, id, as) {
		if c["text"] == text {
			return cid
		}
	}
	t.Fatalf("the commitment %q never reached the wire", text)
	return ""
}

func answer(t *testing.T, srv *httptest.Server, id string, as *http.Cookie, cid string, done bool) *http.Response {
	t.Helper()
	body := `{"id":"` + cid + `","done":false}`
	if done {
		body = `{"id":"` + cid + `","done":true}`
	}
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/answer", body, as)
	return resp
}

// Yes closes the commitment, and a closed commitment leaves the open list.
func TestCommitmentAnsweredYesLeavesTheList(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Yes Space")
	cid := addCommitment(t, srv, id, m1, "finish the importer")

	if resp := answer(t, srv, id, m1, cid, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("answer yes: %d", resp.StatusCode)
	}
	if c := commitments(t, srv, id, m1)[cid]; c != nil {
		t.Fatalf("a finished commitment is still on the open list: %v", c)
	}
}

// No keeps it, and moves the carry count — once per standup. Stuck turns on at
// two carries and is false below that.
//
// Each No here is answered in its own session, because that is what carrying
// over means: the count is a number of standups the work survived, not a
// number of times a button was pressed.
func TestCommitmentAnsweredNoCarriesAndSticks(t *testing.T) {
	srv := testServer(t)
	fac, _, _, id, slug := standupSetup(t, srv, "Commitment No Space")
	cid := addCommitment(t, srv, id, fac, "chase the vendor")

	if c := commitments(t, srv, id, fac)[cid]; c["carried"] != float64(0) || c["stuck"] != false {
		t.Fatalf("a fresh commitment: carried = %v, stuck = %v", c["carried"], c["stuck"])
	}
	for want := 1; want <= 2; want++ {
		if want > 1 {
			_, sess := createSession(t, srv, slug, "standup", "Daily", fac)
			id = sess["id"].(string)
		}
		if resp := answer(t, srv, id, fac, cid, false); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("answer no: %d", resp.StatusCode)
		}
		c := commitments(t, srv, id, fac)[cid]
		if c == nil {
			t.Fatal("answering no removed the commitment")
		}
		if c["carried"] != float64(want) {
			t.Fatalf("carried = %v, want %d", c["carried"], want)
		}
		if wantStuck := want >= 2; c["stuck"] != wantStuck {
			t.Fatalf("carried %d: stuck = %v, want %v", want, c["stuck"], wantStuck)
		}
	}
}

// A mis-click and its correction inside one sitting is not two standups. No,
// Change, No again is a single carry — otherwise a brand-new commitment reads
// as stuck before it has survived a single night, which is precisely the false
// accusation this feature exists to avoid.
func TestARepeatNoInTheSameSessionCarriesOnlyOnce(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Repeat Space")
	cid := addCommitment(t, srv, id, m1, "revisit the estimate")

	for i := 0; i < 3; i++ {
		if resp := answer(t, srv, id, m1, cid, false); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("answer no #%d: %d", i+1, resp.StatusCode)
		}
	}
	c := commitments(t, srv, id, m1)[cid]
	if c == nil {
		t.Fatal("answering no removed the commitment")
	}
	if c["carried"] != float64(1) {
		t.Fatalf("three no answers in one session: carried = %v, want 1", c["carried"])
	}
	if c["stuck"] != false {
		t.Fatal("one sitting made a brand-new commitment look stuck")
	}
}

// The idempotency is per session, not per commitment: the next standup's No
// still counts, so a genuinely stalled commitment still becomes stuck.
func TestANoInALaterSessionStillCarries(t *testing.T) {
	srv := testServer(t)
	fac, _, _, id, slug := standupSetup(t, srv, "Commitment Later Space")
	cid := addCommitment(t, srv, id, fac, "unblock the migration")

	if resp := answer(t, srv, id, fac, cid, false); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first no: %d", resp.StatusCode)
	}
	_, sess := createSession(t, srv, slug, "standup", "Daily Two", fac)
	next := sess["id"].(string)
	if resp := answer(t, srv, next, fac, cid, false); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second no: %d", resp.StatusCode)
	}
	c := commitments(t, srv, next, fac)[cid]
	if c["carried"] != float64(2) || c["stuck"] != true {
		t.Fatalf("a no in a later session: carried = %v, stuck = %v; want 2 and true", c["carried"], c["stuck"])
	}
	// And a yes still closes it, however many times it carried.
	if resp := answer(t, srv, next, fac, cid, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("answer yes: %d", resp.StatusCode)
	}
	if c := commitments(t, srv, next, fac)[cid]; c != nil {
		t.Fatalf("yes left the commitment on the open list: %v", c)
	}
}

// Answering something already finished must be refused, not silently accepted:
// a second yes on a closed row matches nothing, and a 204 there would tell the
// client the list changed when it did not.
func TestAnsweringAClosedCommitmentIsRejected(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Closed Space")
	cid := addCommitment(t, srv, id, m1, "write the postmortem")
	if resp := answer(t, srv, id, m1, cid, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first answer: %d", resp.StatusCode)
	}
	resp := answer(t, srv, id, m1, cid, true)
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("answering a closed commitment: got %d, want a 4xx", resp.StatusCode)
	}
}

// The whole cross-user safety story: no request body carries a user id, and an
// action naming somebody else's commitment must not move it.
func TestCommitmentActionsAreScopedToTheCaller(t *testing.T) {
	srv := testServer(t)
	_, m1, m2, id, _ := standupSetup(t, srv, "Commitment Scope Space")
	cid := addCommitment(t, srv, id, m1, "mine alone")

	if resp := answer(t, srv, id, m2, cid, false); resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("answering another person's commitment: got %d, want a 4xx", resp.StatusCode)
	}
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/remove", `{"id":"`+cid+`"}`, m2)
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("removing another person's commitment: got %d, want a 4xx", resp.StatusCode)
	}
	c := commitments(t, srv, id, m1)[cid]
	if c == nil {
		t.Fatal("somebody else's remove deleted the commitment")
	}
	if c["carried"] != float64(0) {
		t.Fatalf("somebody else's answer moved carried to %v", c["carried"])
	}
}

// Absence does nothing. A whole session can come and go without anybody
// answering, and carried must not have moved.
func TestASessionThatNobodyAnswersLeavesCarriedAlone(t *testing.T) {
	srv := testServer(t)
	fac, _, _, id, slug := standupSetup(t, srv, "Commitment Absence Space")
	cid := addCommitment(t, srv, id, fac, "the long one")

	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close the session: %d", resp.StatusCode)
	}
	_, sess := createSession(t, srv, slug, "standup", "Daily", fac)
	next := sess["id"].(string)

	c := commitments(t, srv, next, fac)[cid]
	if c == nil {
		t.Fatal("the commitment did not carry into the next standup")
	}
	if c["carried"] != float64(0) || c["stuck"] != false {
		t.Fatalf("absence moved the count: carried = %v, stuck = %v", c["carried"], c["stuck"])
	}
}

// Validated in Go, before the DB: a raw check-constraint violation surfaces as
// a 500, which tells the person nothing.
func TestCommitmentTextIsValidatedBeforeTheDatabase(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Length Space")
	for _, tc := range []struct{ name, text string }{
		{"empty", ""},
		{"whitespace only", "   "},
		{"too long", strings.Repeat("é", 501)},
	} {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/add", `{"text":"`+tc.text+`"}`, m1)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", tc.name, resp.StatusCode)
		}
	}
	// 500 characters is legal, and characters are counted rather than bytes.
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/add",
		`{"text":"`+strings.Repeat("é", 500)+`"}`, m1)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("500 characters: got %d, want 204", resp.StatusCode)
	}
}

// An id that is not a uuid at all is simply not a commitment of the caller's.
// Left to the database it is a 22P02 and a 500.
func TestAMalformedCommitmentIdIsNotAServerError(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Malformed Space")
	for _, path := range []string{"answer", "remove"} {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+path,
			`{"id":"not-a-uuid","done":true}`, m1)
		if resp.StatusCode < 400 || resp.StatusCode >= 500 {
			t.Errorf("%s with a malformed id: got %d, want a 4xx", path, resp.StatusCode)
		}
	}
}

// A person answers their own commitments, so none of these may be facilitator-only.
func TestCommitmentActionsAreNotFacilitatorOnly(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Commitment Authz Space")
	cid := addCommitment(t, srv, id, m1, "not the facilitator")
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/remove",
		`{"id":"`+cid+`"}`, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("non-facilitator remove: got %d, want 204", resp.StatusCode)
	}
	if c := commitments(t, srv, id, m1)[cid]; c != nil {
		t.Fatalf("remove left the commitment on the list: %v", c)
	}
}

// Deleting a room must not undo an answer. Open/closed is recorded on the
// commitment itself, so the session row that happened to be open when
// somebody said "done" can go away without the commitment coming back.
func TestDeletingTheClosingRoomDoesNotReopenACommitment(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, id, slug := standupSetup(t, srv, "Commitment Room Delete Space")
	cid := addCommitment(t, srv, id, m1, "ship the importer")

	// Answered in a second room, so the delete below hits the closing room
	// rather than the one the commitment was opened in.
	_, sess := createSession(t, srv, slug, "standup", "Daily Two", fac)
	closing := sess["id"].(string)
	if resp := answer(t, srv, closing, m1, cid, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("answer yes: %d", resp.StatusCode)
	}

	if resp, body := doJSON(t, srv, "DELETE",
		"/api/orgs/default/spaces/"+slug+"/sessions/"+closing, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete the closing room: %d %s", resp.StatusCode, body)
	}

	_, sess = createSession(t, srv, slug, "standup", "Daily Three", fac)
	next := sess["id"].(string)
	if c := commitments(t, srv, next, m1)[cid]; c != nil {
		t.Errorf("deleting the closing room put the finished commitment back on the list: %v", c)
	}
	// And it stays answered: nothing may answer it a second time.
	if resp := answer(t, srv, next, m1, cid, true); resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Errorf("answering the finished commitment again: got %d, want a 4xx", resp.StatusCode)
	}
}
