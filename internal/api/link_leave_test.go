package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// leave calls DELETE /api/me with the given cookie and returns the response.
func leave(t *testing.T, srv *httptest.Server, c *http.Cookie) *http.Response {
	t.Helper()
	resp, _ := doJSON(t, srv, "DELETE", "/api/me", "", c)
	return resp
}

// A guest on a borrowed or shared browser needs a way to end its own session:
// closing the tab leaves the HttpOnly cookie valid, and the next person on that
// browser inherits the seat. Leaving deletes the caller's own session_tokens
// row, clears the cookie, and touches nothing else.
func TestLinkGuestCanLeaveTheRoom(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Guest Leave Space")

	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest vote: got %d, want 204 (%v)", resp.StatusCode, body)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal: %d", resp.StatusCode)
	}

	resp := leave(t, srv, guest)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /api/me as a link guest: got %d, want 204", resp.StatusCode)
	}
	cleared := false
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("leaving did not clear the session cookie: %v", resp.Cookies())
	}

	// The credential is spent: the same cookie no longer buys the room.
	if got, err := requestStatus(srv, "GET", "/api/sessions/"+id, "", guest); err != nil || got == http.StatusOK {
		t.Errorf("the guest cookie still reads the room after leaving: got %d (%v)", got, err)
	}
	// And nobody else's session went with it.
	if resp, body := doJSON(t, srv, "GET", "/api/me", "", fac); resp.StatusCode != http.StatusOK {
		t.Errorf("the facilitator's session was ended too: got %d (%v)", resp.StatusCode, body)
	}

	// D5: nothing is swept. The vote and its attribution outlive the guest,
	// exactly as they outlive a revoked link.
	csvResp, csv := fetchCSV(t, srv, id, fac)
	if csvResp.StatusCode != http.StatusOK {
		t.Fatalf("export after the guest left: %d", csvResp.StatusCode)
	}
	if !strings.Contains(csv, "Gus: 5") {
		t.Errorf("the guest's vote lost its CSV attribution after leaving:\n%s", csv)
	}
}

// The same guarantee for a standup: the written update stays in the round.
func TestLinkGuestLeavingKeepsItsStandupEntry(t *testing.T) {
	srv := testServer(t)
	cookies, _, id := standupSpace(t, srv, "Guest Leave Standup Space", "Amy", "Ben")
	fac := cookies[0]
	guest, guestID := standupLinkGuest(t, srv, id, "Gus", fac)

	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"read the docs","today":"speak up","blockers":""}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest update: got %d, want 204", resp.StatusCode)
	}
	if resp := leave(t, srv, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /api/me as a link guest: got %d, want 204", resp.StatusCode)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	found := false
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		if entry["userId"] == guestID {
			found = true
			if entry["today"] != "speak up" {
				t.Errorf("the guest's update was rewritten by leaving: %v", entry)
			}
		}
	}
	if !found {
		t.Errorf("the guest's standup entry was swept when it left: %v", standupState(env)["entries"])
	}
}
