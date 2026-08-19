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
		action, body string
		cookie       *http.Cookie
	}{
		{"stories", `{"title":"Nope"}`, fac},
		{"select", `{"storyId":"` + story + `"}`, fac},
		{"reveal", "", fac},
		{"reset", "", fac},
		{"story", `{"storyId":"` + story + `","title":"Renamed"}`, fac},
		{"vote", `{"storyId":"` + story + `","value":"5"}`, member},
	}
	for _, c := range cases {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+c.action, c.body, c.cookie)
		if resp.StatusCode != http.StatusConflict {
			t.Errorf("POST actions/%s on an ended session: got %d, want 409", c.action, resp.StatusCode)
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

	for _, c := range []struct{ action, body string }{
		{"story", `{"storyId":"` + story + `","title":"Renamed"}`},
		{"vote", `{"storyId":"` + story + `","value":"5"}`},
	} {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+idB+"/actions/"+c.action, c.body, member)
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
// dispatcher, including the entry write that used to be a PUT.
func TestStandupDispatcherActions(t *testing.T) {
	srv := testServer(t)
	fac, m1, m2, id, _ := standupSetup(t, srv, "Standup Dispatch Space")
	conns := connectAll(t, srv, id, fac, m1, m2)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/standup",
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
