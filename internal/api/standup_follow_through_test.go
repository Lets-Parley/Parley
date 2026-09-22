package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// changes reads this session's changed commitments off the wire, keyed by id.
func changes(t *testing.T, srv *httptest.Server, id string, as *http.Cookie) map[string]map[string]any {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", as)
	raw, ok := standupState(env)["changes"].([]any)
	if !ok {
		t.Fatalf("changes missing from the standup state: %v", standupState(env))
	}
	out := map[string]map[string]any{}
	for _, c := range raw {
		m := c.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func drop(t *testing.T, srv *httptest.Server, id string, as *http.Cookie, cid string) *http.Response {
	t.Helper()
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/drop", `{"id":"`+cid+`"}`, as)
	return resp
}

// Dropped closes a commitment — it leaves the open list and stops asking —
// but it is not a landing: the room's record of this standup says which of
// the two it was, and says it identically to everybody.
func TestDroppedClosesACommitmentWithoutLandingIt(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, id, slug := standupSetup(t, srv, "Follow Through Space")
	landed := addCommitment(t, srv, id, m1, "ship the importer")
	dropped := addCommitment(t, srv, id, m1, "rewrite the parser")
	carried := addCommitment(t, srv, id, m1, "chase the vendor")

	// The answers belong to the next standup: that is where "did that land?"
	// is asked of what was taken on here.
	_, sess := createSession(t, srv, slug, "standup", "Daily Two", fac)
	next := sess["id"].(string)

	if resp := answer(t, srv, next, m1, landed, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("answer done: %d", resp.StatusCode)
	}
	if resp := drop(t, srv, next, m1, dropped); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("drop: %d", resp.StatusCode)
	}
	if resp := answer(t, srv, next, m1, carried, false); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("answer still on it: %d", resp.StatusCode)
	}

	open := commitments(t, srv, next, fac)
	if open[dropped] != nil {
		t.Fatalf("a dropped commitment is still open: %v", open[dropped])
	}
	if open[carried] == nil {
		t.Fatal("a commitment still being worked on left the open list")
	}

	got := changes(t, srv, next, fac)
	for cid, want := range map[string]string{landed: "landed", dropped: "dropped", carried: "carried"} {
		c := got[cid]
		if c == nil {
			t.Fatalf("commitment %s is missing from this standup's changes: %v", want, got)
		}
		if c["outcome"] != want {
			t.Errorf("outcome = %v, want %s", c["outcome"], want)
		}
	}
	// Nothing was changed in the first standup, and its record says so.
	if first := changes(t, srv, id, fac); len(first) != 0 {
		t.Errorf("the earlier standup reports changes it did not see: %v", first)
	}

	// Closed is closed: a dropped commitment cannot be answered afterwards,
	// and dropping somebody else's is the same 404 as one that never existed.
	if resp := answer(t, srv, next, m1, dropped, true); resp.StatusCode != http.StatusNotFound {
		t.Errorf("answering a dropped commitment: got %d, want 404", resp.StatusCode)
	}
	if resp := drop(t, srv, next, fac, carried); resp.StatusCode != http.StatusNotFound {
		t.Errorf("dropping somebody else's commitment: got %d, want 404", resp.StatusCode)
	}

	// Dropping moves no carry count: stuck is exactly what it was.
	var reason string
	var carries int
	if err := testDBPool(t).QueryRow(t.Context(),
		"select closed_reason, carried from standup_commitments where id = $1", dropped,
	).Scan(&reason, &carries); err != nil {
		t.Fatal(err)
	}
	if reason != "dropped" || carries != 0 {
		t.Errorf("dropped row: reason %q carried %d, want dropped and 0", reason, carries)
	}
	if err := testDBPool(t).QueryRow(t.Context(),
		"select closed_reason from standup_commitments where id = $1", landed,
	).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "landed" {
		t.Errorf("landed row: reason %q, want landed", reason)
	}
}

func mention(t *testing.T, srv *httptest.Server, id string, as *http.Cookie, to string, needed bool) (*http.Response, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"to": to, "needed": needed})
	return doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/mention", string(body), as)
}

// mentions is the caller's own view: who needs them, and whom they asked.
func mentions(t *testing.T, srv *httptest.Server, id string, as *http.Cookie) (needsYou, asked []string) {
	t.Helper()
	resp, body := doJSON(t, srv, "GET", "/api/sessions/"+id+"/mentions", "", as)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mentions: %d %v", resp.StatusCode, body)
	}
	strs := func(k string) []string {
		raw, ok := body[k].([]any)
		if !ok {
			t.Fatalf("%s missing from %v", k, body)
		}
		out := []string{}
		for _, v := range raw {
			out = append(out, v.(string))
		}
		return out
	}
	return strs("needsYou"), strs("asked")
}

// "Needs you" is the mentioned person's alone. The shared state every socket
// receives carries no trace of it, the person asked sees who asked, the person
// asking sees whom they asked, and a bystander sees neither.
func TestAMentionReachesOnlyThePersonMentioned(t *testing.T) {
	srv := testServer(t)
	fac, m1, m2, sync, _ := standupSetup(t, srv, "Needs You Space")
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async"}`)
	benID, calID := userID(t, srv, m1), userID(t, srv, m2)

	if resp, body := mention(t, srv, id, m1, calID, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("mention: %d %v", resp.StatusCode, body)
	}
	// Idempotent: the same mention twice is one mention.
	if resp, _ := mention(t, srv, id, m1, calID, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("repeat mention: %d", resp.StatusCode)
	}

	if needs, asked := mentions(t, srv, id, m2); len(needs) != 1 || needs[0] != benID || len(asked) != 0 {
		t.Errorf("Cal's view: needsYou %v asked %v, want [%s] and []", needs, asked, benID)
	}
	if needs, asked := mentions(t, srv, id, m1); len(needs) != 0 || len(asked) != 1 || asked[0] != calID {
		t.Errorf("Ben's view: needsYou %v asked %v, want [] and [%s]", needs, asked, calID)
	}
	if needs, asked := mentions(t, srv, id, fac); len(needs) != 0 || len(asked) != 0 {
		t.Errorf("a bystander sees mentions: needsYou %v asked %v", needs, asked)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/api/sessions/"+id, nil)
	req.AddCookie(fac)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(strings.ToLower(string(raw)), "mention") || strings.Contains(string(raw), "needsYou") {
		t.Errorf("the shared state carries mentions: %s", raw)
	}

	if resp, _ := mention(t, srv, id, m1, calID, false); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("withdraw mention: %d", resp.StatusCode)
	}
	if needs, _ := mentions(t, srv, id, m2); len(needs) != 0 {
		t.Errorf("a withdrawn mention is still showing: %v", needs)
	}
}

// Only somebody in the space can be asked for, and the answer to anything else
// is 400: an outsider, yourself, and an id that is not an id.
func TestMentioningANonMemberIsRefused(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, sync, _ := standupSetup(t, srv, "Mention Outsider Space")
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async"}`)
	outsider := userID(t, srv, signup(t, srv, "Oz"))

	for name, to := range map[string]string{
		"outsider":        outsider,
		"self":            userID(t, srv, m1),
		"self, uppercase": strings.ToUpper(userID(t, srv, m1)),
		"malformed":       "not-a-uuid",
		"empty":           "",
	} {
		if resp, body := mention(t, srv, id, m1, to, true); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d (%v), want 400", name, resp.StatusCode, body)
		}
	}
}

// A link guest holds a capability on one room, not a place in the team, so it
// neither asks for anybody nor is asked for, and it has no "needs you" to read.
func TestLinkGuestsCannotMentionOrBeMentioned(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, sync, _ := standupSetup(t, srv, "Mention Guest Space")
	id := asyncStandup(t, srv, sync, fac, `{"mode":"async"}`)
	guest, guestID := standupLinkGuest(t, srv, id, "Gus", fac)

	if resp, body := mention(t, srv, id, guest, userID(t, srv, m1), true); resp.StatusCode != http.StatusForbidden {
		t.Errorf("guest mentioning a member: got %d (%v), want 403", resp.StatusCode, body)
	}
	if resp, body := mention(t, srv, id, m1, guestID, true); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("mentioning a guest: got %d (%v), want 400", resp.StatusCode, body)
	}
	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id+"/mentions", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Errorf("guest reading mentions: got %d, want 403", resp.StatusCode)
	}
	var n int
	if err := testDBPool(t).QueryRow(t.Context(), "select count(*) from standup_mentions").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("%d mention rows were written for a guest", n)
	}
}

// A sync standup never shows a mention, so it does not take one — but a link
// guest is still refused as a guest there, before the mode is looked at.
func TestASyncStandupRefusesMentions(t *testing.T) {
	srv := testServer(t)
	fac, m1, m2, id, _ := standupSetup(t, srv, "Mention Sync Space")
	if resp, body := mention(t, srv, id, m1, userID(t, srv, m2), true); resp.StatusCode != http.StatusConflict {
		t.Errorf("mention in a sync standup: got %d (%v), want 409", resp.StatusCode, body)
	}
	guest, _ := standupLinkGuest(t, srv, id, "Gus", fac)
	if resp, body := mention(t, srv, id, guest, userID(t, srv, m1), true); resp.StatusCode != http.StatusForbidden {
		t.Errorf("guest mention in a sync standup: got %d (%v), want 403", resp.StatusCode, body)
	}
}

// Once a standup has ended its record keeps its entries only, so the room
// stops serving what it changed.
func TestAnEndedStandupServesNoChangedCommitments(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, id, slug := standupSetup(t, srv, "Ended Changes Space")
	cid := addCommitment(t, srv, id, m1, "ship the importer")
	_, sess := createSession(t, srv, slug, "standup", "Daily Two", fac)
	next := sess["id"].(string)
	if resp := drop(t, srv, next, m1, cid); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("drop: %d", resp.StatusCode)
	}
	if got := changes(t, srv, next, fac); len(got) != 1 {
		t.Fatalf("an open standup's changes: %v, want the one it moved", got)
	}
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+next, "", fac); resp.StatusCode/100 != 2 {
		t.Fatalf("end the standup: %d", resp.StatusCode)
	}
	if got := changes(t, srv, next, fac); len(got) != 0 {
		t.Errorf("an ended standup still serves its changes: %v", got)
	}
}
