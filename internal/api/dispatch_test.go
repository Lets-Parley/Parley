package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func reopenSession(t *testing.T, srv *httptest.Server, id string, fac *http.Cookie) {
	t.Helper()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reopen", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reopen session: %d", resp.StatusCode)
	}
}

// TestEndedSessionRejectsPokerActionsOnLegacyPaths is a characterization test:
// it pins the 409-on-a-closed-session behaviour that today lives inside each
// kind's own route wrapper, so a refactor that collapses those wrappers onto
// the shared member middleware cannot quietly drop it.
func TestEndedSessionRejectsPokerActionsOnLegacyPaths(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Ended Poker Legacy")
	story := addStory(t, srv, id, "Login page", fac)
	// Select the story before closing the session. With no current story,
	// castVote rejects with 409 "voting is not open on this story" whatever the
	// session's state, so the vote case below would pass for a reason that has
	// nothing to do with the ended-session guard this test exists to pin.
	selectStory(t, srv, id, story, fac)
	closeSession(t, srv, id, fac)

	cases := []struct {
		method, path, body string
		cookie             *http.Cookie
	}{
		{"POST", "/api/sessions/" + id + "/stories", `{"title":"Nope"}`, fac},
		{"POST", "/api/sessions/" + id + "/select", `{"storyId":"` + story + `"}`, fac},
		{"POST", "/api/sessions/" + id + "/reveal", "", fac},
		{"POST", "/api/sessions/" + id + "/reset", "", fac},
		{"POST", "/api/sessions/" + id + "/spectator", `{"on":true}`, member},
		{"PATCH", "/api/stories/" + story, `{"title":"Renamed"}`, fac},
		{"POST", "/api/stories/" + story + "/vote", `{"value":"5"}`, member},
	}
	for _, c := range cases {
		resp, _ := doJSON(t, srv, c.method, c.path, c.body, c.cookie)
		if resp.StatusCode != http.StatusConflict {
			t.Errorf("%s %s on an ended session: got %d, want 409", c.method, c.path, resp.StatusCode)
		}
	}

	// Reopening still works, and the actions come back with it.
	reopenSession(t, srv, id, fac)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/stories", `{"title":"After reopen"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add story after reopen: %d", resp.StatusCode)
	}
}

func TestEndedSessionRejectsStandupActionsOnLegacyPaths(t *testing.T) {
	srv := testServer(t)
	fac, member, _, id, _ := standupSetup(t, srv, "Ended Standup Legacy")
	closeSession(t, srv, id, fac)

	cases := []struct {
		method, path, body string
		cookie             *http.Cookie
	}{
		{"PUT", "/api/sessions/" + id + "/standup", `{"today":"stuff"}`, member},
		{"POST", "/api/sessions/" + id + "/start", "", fac},
		{"POST", "/api/sessions/" + id + "/next", "", fac},
		{"POST", "/api/sessions/" + id + "/skip", "", fac},
	}
	for _, c := range cases {
		resp, _ := doJSON(t, srv, c.method, c.path, c.body, c.cookie)
		if resp.StatusCode != http.StatusConflict {
			t.Errorf("%s %s on an ended session: got %d, want 409", c.method, c.path, resp.StatusCode)
		}
	}

	reopenSession(t, srv, id, fac)
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup", `{"today":"stuff"}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("standup entry after reopen: %d", resp.StatusCode)
	}
}

// TestEndedSessionRejectsActionsOnDispatcher is the same property stated
// against the dispatcher path.
func TestEndedSessionRejectsActionsOnDispatcher(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Ended Poker Dispatch")
	story := addStory(t, srv, id, "Login page", fac)
	closeSession(t, srv, id, fac)

	cases := []struct {
		verb, action, body string
		cookie             *http.Cookie
	}{
		{"POST", "stories", `{"title":"Nope"}`, fac},
		{"POST", "select", `{"storyId":"` + story + `"}`, fac},
		{"POST", "reveal", "", fac},
		{"POST", "reset", "", fac},
		{"PATCH", "story", `{"storyId":"` + story + `","title":"Renamed"}`, fac},
		{"POST", "vote", `{"storyId":"` + story + `","value":"5"}`, member},
	}
	for _, c := range cases {
		resp, _ := doJSON(t, srv, c.verb, "/api/sessions/"+id+"/actions/"+c.action, c.body, c.cookie)
		if resp.StatusCode != http.StatusConflict {
			t.Errorf("%s actions/%s on an ended session: got %d, want 409", c.verb, c.action, resp.StatusCode)
		}
	}

	reopenSession(t, srv, id, fac)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/stories", `{"title":"After reopen"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add story after reopen: %d", resp.StatusCode)
	}
}

// TestStoryActionsRejectAForeignSession pins the story-to-session binding: a
// story id from one session, used under another session's path, is rejected
// even though the caller is a member of both.
func TestStoryActionsRejectAForeignSession(t *testing.T) {
	srv := testServer(t)
	fac := signup(t, srv, "Fay")
	member := signup(t, srv, "Mel")
	_, sp := createSpace(t, srv, "Binding Space", fac)
	slug := sp["slug"].(string)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	_, sessA := createSession(t, srv, slug, "poker", "Session A", fac)
	idA := sessA["id"].(string)
	_, sessB := createSession(t, srv, slug, "poker", "Session B", fac)
	idB := sessB["id"].(string)

	story := addStory(t, srv, idA, "Belongs to A", fac)
	selectStory(t, srv, idA, story, fac)

	for _, c := range []struct{ verb, action, body string }{
		{"PATCH", "story", `{"storyId":"` + story + `","title":"Renamed"}`},
		{"POST", "vote", `{"storyId":"` + story + `","value":"5"}`},
	} {
		resp, _ := doJSON(t, srv, c.verb, "/api/sessions/"+idB+"/actions/"+c.action, c.body, member)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("actions/%s with a story from another session: got %d, want 404", c.action, resp.StatusCode)
		}
	}

	// The same call under the story's own session still works.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+idA+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote under the story's own session: %d", resp.StatusCode)
	}
}

// TestDispatcherRejectsForeignAndUnknownActions: an action belonging to
// another kind, or to no kind at all, is not routable.
func TestDispatcherRejectsForeignAndUnknownActions(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Wrong Kind Space")
	for _, action := range []string{"start", "next", "skip", "standup", "nonsense"} {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+action, "{}", fac)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("poker session, actions/%s: got %d, want 404", action, resp.StatusCode)
		}
	}
}

// TestEndedSessionKeeps404ForUnknownActions pins the deliberate ordering in
// dispatch: the action lookup runs before the ended-session check, so an action
// that does not exist for the kind stays a 404 even once the session is ended.
// Hoisting the ended check ahead of the lookup would turn every unroutable
// action name on an ended session into a 409, leaking "this session has ended"
// as the answer to a question about an action that never existed.
func TestEndedSessionKeeps404ForUnknownActions(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Ended Unknown Action Space")
	closeSession(t, srv, id, fac)

	// A real poker action on the same ended session is a 409, so the 404s below
	// are the ordering and not a dead route.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("known action on an ended session: got %d, want 409", resp.StatusCode)
	}
	// "start" belongs to standup, "nonsense" to no kind at all.
	for _, action := range []string{"start", "next", "skip", "standup", "nonsense"} {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+action, "{}", fac)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("unknown action %q on an ended session: got %d, want 404", action, resp.StatusCode)
		}
	}
}

// TestDispatcherStillEnforcesMembershipAndFacilitator: the dispatcher does not
// widen who may act.
func TestDispatcherStillEnforcesMembershipAndFacilitator(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Dispatch Authz Space")
	outsider := signup(t, srv, "Otto")

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", outsider); resp.StatusCode != http.StatusNotFound {
		t.Errorf("outsider reveal: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("anonymous reveal: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", member); resp.StatusCode != http.StatusForbidden {
		t.Errorf("non-facilitator reveal: got %d, want 403", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Errorf("facilitator reveal: got %d, want 204", resp.StatusCode)
	}
}

// TestStandupDispatcherActions covers the standup kind end to end on the
// dispatcher, including the PUT that writes the caller's entry.
func TestStandupDispatcherActions(t *testing.T) {
	srv := testServer(t)
	fac, m1, m2, id, _ := standupSetup(t, srv, "Standup Dispatch Space")
	conns := connectAll(t, srv, id, fac, m1, m2)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()

	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"a","today":"b","blockers":"c"}`, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("standup entry: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", m1); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-facilitator start: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/next", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("next: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/skip", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("skip: %d", resp.StatusCode)
	}
}

// TestDispatcherRoutesOnTheActionsVerb pins the verb-per-action shape: an
// action is reachable only through the verb it declares, and a real action
// reached with the wrong verb is a 405 carrying Allow — not a 404, which would
// say the action does not exist when it plainly does. The 404 is reserved for
// a name this kind has no action for, whatever the verb.
func TestDispatcherRoutesOnTheActionsVerb(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Verb Dispatch Space")
	story := addStory(t, srv, id, "Verb story", fac)
	selectStory(t, srv, id, story, fac)

	// PATCH is the story edit's declared verb.
	if resp, _ := doJSON(t, srv, "PATCH", "/api/sessions/"+id+"/actions/story",
		`{"storyId":"`+story+`","title":"Renamed"}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PATCH actions/story: got %d, want 204", resp.StatusCode)
	}

	// The same action under any other verb is a 405, and says which verb works.
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		resp, _ := doJSON(t, srv, method, "/api/sessions/"+id+"/actions/story",
			`{"storyId":"`+story+`","title":"Renamed again"}`, member)
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s actions/story: got %d, want 405", method, resp.StatusCode)
		}
		if got := resp.Header.Get("Allow"); got != "PATCH" {
			t.Errorf("%s actions/story: Allow = %q, want %q", method, got, "PATCH")
		}
	}

	// A name this kind has no action for stays a 404 under every verb, so the
	// 405 above is the verb check and not a blanket method filter.
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, action := range []string{"standup", "nonsense"} {
			resp, _ := doJSON(t, srv, method, "/api/sessions/"+id+"/actions/"+action, "{}", fac)
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("%s actions/%s on a poker session: got %d, want 404", method, action, resp.StatusCode)
			}
		}
	}
}

// TestStandupEntryIsAPut pins PUT as the canonical standup entry route: the
// entry write is an upsert of the caller's own row, and PUT is what carries
// that idempotency signal to a client.
func TestStandupEntryIsAPut(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Standup Verb Space")

	body := `{"yesterday":"a","today":"b","blockers":"c"}`
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup", body, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT actions/standup: got %d, want 204", resp.StatusCode)
	}
	// Repeating it is the same upsert, not a second entry.
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup", body, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("repeat PUT actions/standup: got %d, want 204", resp.StatusCode)
	}
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/standup", body, m1)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST actions/standup: got %d, want 405", resp.StatusCode)
	}
	if got := resp.Header.Get("Allow"); got != "PUT" {
		t.Errorf("POST actions/standup: Allow = %q, want %q", got, "PUT")
	}

	// The deprecated PUT /sessions/{id}/standup alias keeps working.
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup", body, m1); resp.StatusCode != http.StatusNoContent {
		t.Errorf("legacy PUT /standup: got %d, want 204", resp.StatusCode)
	}
}
