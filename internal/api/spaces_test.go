package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
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

// The create dialog offers whatever kinds the space view lists, so a kind
// retired in place has to be missing from that list — the DB row survives for
// the sake of existing sessions, and only this filter stops it being offered
// again.
func TestSpaceViewOmitsRetiredKinds(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Kinds Space", ada)
	slug := sp["slug"].(string)

	_, body := getSpace(t, srv, slug, ada)
	if got := kindList(t, body); !slices.Contains(got, "standup") || !slices.Contains(got, "poker") {
		t.Fatalf("space view kinds = %v, want both built-in kinds before retirement", got)
	}

	retireKind(t, pool, "standup")

	_, body = getSpace(t, srv, slug, ada)
	got := kindList(t, body)
	if slices.Contains(got, "standup") {
		t.Fatalf("space view kinds = %v, still offers the retired kind", got)
	}
	// The unretired kind is still offered: a filter that dropped everything
	// would pass the assertion above for the wrong reason.
	if !slices.Contains(got, "poker") {
		t.Fatalf("space view kinds = %v, want the live kind still offered", got)
	}
}

// kindList reads the space view's offerable-kind list, failing the test if it
// is missing or not a list of strings.
func kindList(t *testing.T, body map[string]any) []string {
	t.Helper()
	raw, ok := body["kinds"].([]any)
	if !ok {
		t.Fatalf("space view has no kinds list: %v", body)
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		s, ok := v.(string)
		if !ok {
			t.Fatalf("space view kinds contains a non-string: %v", raw)
		}
		out = append(out, s)
	}
	return out
}
