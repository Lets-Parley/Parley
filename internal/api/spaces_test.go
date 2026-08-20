package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/store"
)

func createSpace(t *testing.T, srv *httptest.Server, name string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func getSpace(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/spaces/"+slug, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

// joinSpace knocks on a space door, optionally presenting its room code.
func joinSpace(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie, passcode ...string) *http.Response {
	t.Helper()
	var body io.Reader
	if len(passcode) > 0 {
		body = strings.NewReader(`{"passcode":"` + passcode[0] + `"}`)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/join", body)
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func signup(t *testing.T, srv *httptest.Server, name string) *http.Cookie {
	t.Helper()
	resp, _ := postMe(t, srv, name, nil)
	return sessionCookieOf(t, resp)
}

func TestCreateSpaceSlugifiesAndJoinsCreator(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")

	resp, sp := createSpace(t, srv, "Platform Team", ada)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", resp.StatusCode)
	}
	if sp["slug"] != "platform-team" {
		t.Fatalf("slug: got %v", sp["slug"])
	}

	_, view := getSpace(t, srv, "platform-team", ada)
	members, ok := view["members"].([]any)
	if !ok || len(members) != 1 {
		t.Fatalf("creator not in roster: %v", view)
	}
}

func TestDuplicateSlugConflicts(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")

	createSpace(t, srv, "Dup Space", ada)
	resp, _ := createSpace(t, srv, "Dup   Space", ada)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate slug: got %d, want 409", resp.StatusCode)
	}
}

func TestSpaceLookupRedactsForNonMembers(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Secret Roster", ada)

	// Unauthenticated: name only.
	resp, view := getSpace(t, srv, "secret-roster", nil)
	if resp.StatusCode != http.StatusOK || view["name"] != "Secret Roster" {
		t.Fatalf("unauth lookup: %d %v", resp.StatusCode, view)
	}
	if _, has := view["members"]; has {
		t.Fatal("unauthenticated lookup leaked the roster")
	}

	// Authenticated non-member: still name only.
	eve := signup(t, srv, "Eve")
	_, view2 := getSpace(t, srv, "secret-roster", eve)
	if _, has := view2["members"]; has {
		t.Fatal("non-member lookup leaked the roster")
	}

	// After joining with the room code: roster visible.
	if resp := joinSpace(t, srv, "secret-roster", eve, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}
	_, view3 := getSpace(t, srv, "secret-roster", eve)
	members, ok := view3["members"].([]any)
	if !ok || len(members) != 2 {
		t.Fatalf("member lookup missing roster: %v", view3)
	}
}

func TestJoinRequiresIdentityAndRealSpace(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	createSpace(t, srv, "Join Rules", ada)

	if resp := joinSpace(t, srv, "join-rules", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous join: got %d, want 401", resp.StatusCode)
	}
	if resp := joinSpace(t, srv, "no-such-space", ada); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("join missing space: got %d, want 404", resp.StatusCode)
	}
	// Idempotent re-join.
	if resp := joinSpace(t, srv, "join-rules", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("re-join: got %d", resp.StatusCode)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Platform Team":    "platform-team",
		"  QA / Release  ": "qa-release",
		"émojis 🎉 crew":    "mojis-crew",
		"---":              "",
	}
	for in, want := range cases {
		if got := store.Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestJoinReturnsPayloadTooLargeForOversizedJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/spaces/example/join", strings.NewReader(`{"passcode":"`+strings.Repeat("x", 4<<10)+`"}`))
	rec := httptest.NewRecorder()

	(&app{}).handleJoinSpace(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized JSON status = %d, want 413", rec.Code)
	}
}

// listMySpaces asks for the caller's own memberships.
func listMySpaces(t *testing.T, srv *httptest.Server, cookie *http.Cookie) (*http.Response, []map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/spaces", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body []map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func TestListMySpacesReturnsOnlyMyMembershipsMostRecentFirst(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	bob := signup(t, srv, "Bob")

	createSpace(t, srv, "Alpha Squad", ada)
	createSpace(t, srv, "Beta Squad", ada)
	_, gamma := createSpace(t, srv, "Gamma Squad", bob)
	if resp := joinSpace(t, srv, "gamma-squad", ada, gamma["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}

	resp, mine := listMySpaces(t, srv, ada)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list: got %d", resp.StatusCode)
	}
	slugs := make([]string, len(mine))
	for i, sp := range mine {
		slugs[i] = sp["slug"].(string)
	}
	want := []string{"gamma-squad", "beta-squad", "alpha-squad"}
	if len(slugs) != len(want) {
		t.Fatalf("slugs: got %v, want %v", slugs, want)
	}
	for i := range want {
		if slugs[i] != want[i] {
			t.Fatalf("slugs: got %v, want %v", slugs, want)
		}
	}
	if mine[0]["name"] != "Gamma Squad" || mine[0]["protected"] != true {
		t.Fatalf("first row: got %v", mine[0])
	}
	if _, leaked := mine[0]["passcode"]; leaked {
		t.Fatalf("list leaked a room code: %v", mine[0])
	}

	_, theirs := listMySpaces(t, srv, bob)
	if len(theirs) != 1 || theirs[0]["slug"] != "gamma-squad" {
		t.Fatalf("bob's spaces: got %v", theirs)
	}
}

func TestListMySpacesRefusesAnonymous(t *testing.T) {
	srv := testServer(t)
	resp, _ := listMySpaces(t, srv, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous list: got %d", resp.StatusCode)
	}
}
