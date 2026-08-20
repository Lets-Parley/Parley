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

// markSeen pings the "I opened this space" endpoint the space page calls.
func markSeen(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/seen", nil)
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

// Opening a space you already belong to is the activity signal the landing
// page orders on. Join only ever fires for a stranger, so the space page says
// so explicitly with a POST — a GET must never write.
func TestListMySpacesOrdersByLastOpenedNotByJoin(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	bob := signup(t, srv, "Bob")

	// Ada's own space, created first and therefore stamped oldest.
	createSpace(t, srv, "Alpha Squad", ada)
	// Then she joins Bob's, which stamps her membership more recently.
	_, gamma := createSpace(t, srv, "Gamma Squad", bob)
	if resp := joinSpace(t, srv, "gamma-squad", ada, gamma["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}

	_, joined := listMySpaces(t, srv, ada)
	if len(joined) != 2 || joined[0]["slug"] != "gamma-squad" {
		t.Fatalf("before opening: got %v, want gamma-squad first", joined)
	}

	// She opens the space she already belongs to and never re-joins.
	if resp := markSeen(t, srv, "alpha-squad", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("mark seen: got %d", resp.StatusCode)
	}

	_, opened := listMySpaces(t, srv, ada)
	if len(opened) != 2 || opened[0]["slug"] != "alpha-squad" {
		t.Fatalf("after opening: got %v, want alpha-squad first", opened)
	}
}

// A GET is reachable cross-site with cookies attached — rejectCrossSite waves
// it through precisely because a GET is meant to change nothing. Reading a
// space must therefore leave the membership stamp exactly as it was.
func TestGetSpaceDoesNotStampLastSeen(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	bob := signup(t, srv, "Bob")

	createSpace(t, srv, "Alpha Squad", ada)
	_, gamma := createSpace(t, srv, "Gamma Squad", bob)
	if resp := joinSpace(t, srv, "gamma-squad", ada, gamma["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}

	// Gamma is the most recently stamped membership. Reading Alpha — even
	// repeatedly — must not move it ahead.
	for range 3 {
		if resp, _ := getSpace(t, srv, "alpha-squad", ada); resp.StatusCode != http.StatusOK {
			t.Fatalf("get space: got %d", resp.StatusCode)
		}
	}

	_, mine := listMySpaces(t, srv, ada)
	if len(mine) != 2 || mine[0]["slug"] != "gamma-squad" {
		t.Fatalf("GET rewrote last_seen_at: got %v, want gamma-squad still first", mine)
	}
}

// The stamp is a members-only write, and a no-op for everyone else: a removed
// member pinging it must not reappear in the room — and must not re-stamp the
// rows of the members who are actually there.
func TestMarkSeenNeverCreatesMembership(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	createSpace(t, srv, "Alpha Squad", ada)
	createSpace(t, srv, "Beta Squad", ada)

	// Beta is Ada's most recently touched membership, so her list order is a
	// fingerprint of which of her rows last moved.
	if resp := markSeen(t, srv, "beta-squad", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("ada mark seen beta: got %d", resp.StatusCode)
	}
	if _, hers := listMySpaces(t, srv, ada); hers[0]["slug"] != "beta-squad" {
		t.Fatalf("setup: got %v, want beta-squad first", hers)
	}

	stranger := signup(t, srv, "Cleo")
	if resp := markSeen(t, srv, "alpha-squad", stranger); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("stranger mark seen: got %d", resp.StatusCode)
	}
	if _, theirs := listMySpaces(t, srv, stranger); len(theirs) != 0 {
		t.Fatalf("stranger gained memberships: %v", theirs)
	}
	if _, view := getSpace(t, srv, "alpha-squad", ada); len(view["members"].([]any)) != 1 {
		t.Fatalf("roster grew: %v", view["members"])
	}
	// The stamp is scoped to the caller's own row. Without the user_id filter
	// the stranger's ping would have re-stamped Ada's alpha membership and
	// shoved it to the top of her list.
	if _, hers := listMySpaces(t, srv, ada); hers[0]["slug"] != "beta-squad" {
		t.Fatalf("a non-member re-stamped someone else's row: got %v, want beta-squad still first", hers)
	}

	// Anonymous callers and unknown spaces get the same answers as every
	// other member-scoped write.
	if resp := markSeen(t, srv, "alpha-squad", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous mark seen: got %d", resp.StatusCode)
	}
	if resp := markSeen(t, srv, "no-such-space", ada); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown space: got %d", resp.StatusCode)
	}
}

// The list is a list: it carries no room code and no internal ordering key.
func TestListMySpacesCarriesOnlyTheListedFields(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	createSpace(t, srv, "Alpha Squad", ada)

	_, mine := listMySpaces(t, srv, ada)
	if len(mine) != 1 {
		t.Fatalf("list: got %v", mine)
	}
	for key := range mine[0] {
		switch key {
		case "slug", "name", "protected":
		default:
			t.Fatalf("unexpected field %q in %v", key, mine[0])
		}
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

// The stamp is a write, so unlike the space read it has to answer to the
// cross-site guard. Both signals the guard reads must turn it away.
func TestMarkSeenRefusesCrossSite(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	createSpace(t, srv, "Alpha Squad", ada)

	for _, tc := range []struct{ name, header, value string }{
		{"origin", "Origin", "https://evil.example"},
		{"sec-fetch-site", "Sec-Fetch-Site", "cross-site"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/alpha-squad/seen", nil)
			req.Header.Set(tc.header, tc.value)
			req.AddCookie(ada)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("%s: got %d, want %d", tc.header, resp.StatusCode, http.StatusForbidden)
			}
		})
	}
}

// Removal has to stick. The stamp matches on an existing membership row, so a
// member who was removed can ping it forever without letting themselves back
// in — the write finds nothing and says so with the same 204 as a no-op.
func TestMarkSeenDoesNotRestoreARemovedMember(t *testing.T) {
	srv := testServer(t)
	slug, owner, _, member, memberID := spaceWithTwo(t, srv)

	if resp, body := removeMember(t, srv, slug, memberID, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove: got %d %s", resp.StatusCode, body)
	}
	if resp := markSeen(t, srv, slug, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("removed member mark seen: got %d", resp.StatusCode)
	}
	if _, theirs := listMySpaces(t, srv, member); len(theirs) != 0 {
		t.Fatalf("removed member came back: %v", theirs)
	}
	if _, view := getSpace(t, srv, slug, owner); len(view["members"].([]any)) != 1 {
		t.Fatalf("roster grew back: %v", view["members"])
	}
}
