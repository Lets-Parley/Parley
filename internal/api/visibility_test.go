package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// createOpenSpace makes a passcode-free space, which is the only kind org
// visibility can ever make join-on-click. The default createSpace helper mints
// a passcode, and a passcode-protected space stays gated however it is listed.
func createOpenSpace(t *testing.T, srv *httptest.Server, name string, cookie *http.Cookie) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces", strings.NewReader(`{"name":"`+name+`","open":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create %q: got %d (%v)", name, resp.StatusCode, body)
	}
	return body
}

// makeOrgVisible sets visibility in the database rather than through the new
// route, so a test of the directory or the join door is not also a test of the
// PATCH — and so it works under the open-mode server these tests use, where
// the route deliberately refuses org visibility.
func makeOrgVisible(t *testing.T, pool *pgxpool.Pool, slug string) {
	t.Helper()
	tag, err := pool.Exec(context.Background(),
		"update spaces set visibility = $2 where slug = $1", slug, store.VisibilityOrg)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("marking %q org-visible touched %d rows, want 1", slug, tag.RowsAffected())
	}
}

// directoryPage is the paginated envelope the directory answers with.
type directoryPage struct {
	Spaces []map[string]any `json:"spaces"`
	Next   string           `json:"next"`
}

// listOrgSpacesRaw reads one page of the directory, passing the query string
// through verbatim so a test can ask for a bad cursor or a bad limit.
func listOrgSpacesRaw(t *testing.T, srv *httptest.Server, query string, cookie *http.Cookie) (*http.Response, directoryPage) {
	t.Helper()
	url := srv.URL + "/api/orgs/" + store.DefaultOrgSlug + "/spaces"
	if query != "" {
		url += "?" + query
	}
	req, _ := http.NewRequest("GET", url, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var page directoryPage
	json.NewDecoder(resp.Body).Decode(&page)
	resp.Body.Close()
	return resp, page
}

// listOrgSpaces reads the whole directory, following the cursor to its end.
// Every existing caller wants "what may this person see", which is now spread
// across pages, and walking them here is also what proves the disclosure rule
// holds on the later ones and not only on the first.
func listOrgSpaces(t *testing.T, srv *httptest.Server, cookie *http.Cookie) (*http.Response, []map[string]any) {
	t.Helper()
	return listOrgSpacesPaged(t, srv, cookie, 0)
}

// listOrgSpacesPaged walks the directory with an explicit page size, so a test
// can force several pages without creating a page's worth of spaces. It fails
// on a duplicate slug, because a cursor that hands the same row out twice is
// the paging bug this endpoint exists to avoid.
func listOrgSpacesPaged(t *testing.T, srv *httptest.Server, cookie *http.Cookie, limit int) (*http.Response, []map[string]any) {
	t.Helper()
	query := ""
	if limit > 0 {
		query = "limit=" + strconv.Itoa(limit)
	}
	first, page := listOrgSpacesRaw(t, srv, query, cookie)
	if first.StatusCode != http.StatusOK {
		return first, page.Spaces
	}
	rows := page.Spaces
	seen := map[string]bool{}
	for _, row := range rows {
		seen[row["slug"].(string)] = true
	}
	for pages := 0; page.Next != ""; pages++ {
		if pages > 50 {
			t.Fatalf("the directory cursor never reached the end after %d pages", pages)
		}
		next := "after=" + url.QueryEscape(page.Next)
		if query != "" {
			next = query + "&" + next
		}
		var resp *http.Response
		resp, page = listOrgSpacesRaw(t, srv, next, cookie)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("following the directory cursor = %d, want 200", resp.StatusCode)
		}
		for _, row := range page.Spaces {
			slug := row["slug"].(string)
			if seen[slug] {
				t.Errorf("the space %q appeared on two pages — the cursor is duplicating rows", slug)
			}
			seen[slug] = true
		}
		rows = append(rows, page.Spaces...)
	}
	return first, rows
}

func setVisibility(t *testing.T, srv *httptest.Server, slug, visibility string, cookie *http.Cookie) int {
	t.Helper()
	got, err := requestStatus(srv, "PATCH",
		"/api/orgs/"+store.DefaultOrgSlug+"/spaces/"+slug+"/visibility",
		`{"visibility":"`+visibility+`"}`, cookie)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// TestLinkGuestGetsNeitherDirectoryNorEntry is the acceptance criterion this
// whole phase turns on, proved through a real redeemed link rather than a
// hand-built principal: a link guest is a users row in no org and no space, so
// if the directory ever answered for one, a single link to a single standup
// would become a listing of every org-visible space on the instance.
//
// Both routes answer 401 through RequireUser, which is why RequireUser stays
// ahead of requireOrgMember on them — reversing the two would turn these into
// 404s, which is a different (and weaker) statement about what happened.
func TestLinkGuestGetsNeitherDirectoryNorEntry(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	_, _, guest := mintAndRedeem(t, srv, "Guest Directory "+randomSlugSuffix(t))

	// The most dangerous space that can exist in this phase: org-visible,
	// no passcode, therefore join-on-click for anybody the door lets through.
	fac := signup(t, srv, "Fay")
	open := createOpenSpace(t, srv, "Open Room "+randomSlugSuffix(t), fac)
	slug := open["slug"].(string)
	makeOrgVisible(t, pool, slug)

	if resp, body := listOrgSpaces(t, srv, guest); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("a link guest reading the org directory = %d, want 401 (%v)", resp.StatusCode, body)
	}
	got, err := requestStatus(srv, "POST",
		"/api/orgs/"+store.DefaultOrgSlug+"/spaces/"+slug+"/join", "{}", guest)
	if err != nil {
		t.Fatal(err)
	}
	if got != http.StatusUnauthorized {
		t.Errorf("a link guest joining an org-visible, passcode-free space = %d, want 401", got)
	}
}

// TestOpenModeRefusesOrgVisibility closes the route around the create-time
// guard. Open mode mints anonymous identities on POST /api/me and enrols every
// non-guest in the default org, so an org-visible space with no passcode there
// is a room any visitor on the internet can walk into. handleCreateSpace
// already forces private; this pins that the new PATCH cannot undo it.
func TestOpenModeRefusesOrgVisibility(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	ada := signup(t, srv, "Ada")
	sp := createOpenSpace(t, srv, "Open Mode "+randomSlugSuffix(t), ada)
	slug := sp["slug"].(string)

	if got := setVisibility(t, srv, slug, store.VisibilityOrg, ada); got != http.StatusForbidden {
		t.Errorf("setting org visibility in open mode = %d, want 403", got)
	}
	var got string
	if err := pool.QueryRow(context.Background(),
		"select visibility from spaces where slug = $1", slug).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != store.VisibilityPrivate {
		t.Errorf("visibility after the refusal = %q, want %q — the refusal has to happen before the store call",
			got, store.VisibilityPrivate)
	}
	// Setting it back to private is not the dangerous direction, so open mode
	// is allowed it: an owner must always be able to close a space.
	if got := setVisibility(t, srv, slug, store.VisibilityPrivate, ada); got != http.StatusNoContent {
		t.Errorf("setting private visibility in open mode = %d, want 204", got)
	}
}

// TestOrgDirectoryScope is the directory's whole disclosure rule: org-visible
// spaces, plus the caller's own — where "own" means one they are a member of,
// not one they happened to create. A private space someone else keeps is
// absent, and someone outside the org gets 404 rather than an empty list,
// because whether the org exists is not disclosed to anyone outside it.
//
// It reads the directory a page at a time, one row per page, and the private
// space is named so that it sorts last. A paginated leak is still a leak, so
// the space this test would catch has to be one that could only ever show up
// on a later page.
func TestOrgDirectoryScope(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	listed := createOpenSpace(t, srv, "Aaa Listed "+randomSlugSuffix(t), fay)
	listedSlug := listed["slug"].(string)
	makeOrgVisible(t, pool, listedSlug)

	// Two more org-visible spaces so the private one below can never be on
	// the first page, whatever order the rest arrive in.
	for _, name := range []string{"Bbb Filler ", "Ccc Filler "} {
		filler := createOpenSpace(t, srv, name+randomSlugSuffix(t), fay)
		makeOrgVisible(t, pool, filler["slug"].(string))
	}

	hidden := createOpenSpace(t, srv, "Zzz Hidden "+randomSlugSuffix(t), fay)
	hiddenSlug := hidden["slug"].(string)

	// A second org member, who belongs to neither space.
	ada, adaID := signupWithID(t, srv, "Ada")

	resp, body := listOrgSpacesPaged(t, srv, ada, 1)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("an org member reading the directory = %d, want 200", resp.StatusCode)
	}
	slugs := map[string]map[string]any{}
	for _, row := range body {
		slugs[row["slug"].(string)] = row
	}
	if _, ok := slugs[listedSlug]; !ok {
		t.Errorf("the org-visible space is missing from the directory: %v", body)
	}
	if _, leaked := slugs[hiddenSlug]; leaked {
		t.Errorf("a private space someone else keeps is listed to a non-member: %v", body)
	}
	if slugs[listedSlug]["member"] != false {
		t.Errorf("member = %v for a space the caller has not joined, want false", slugs[listedSlug]["member"])
	}

	// Membership, not authorship, is what adds a private space to the list.
	if resp := joinSpace(t, srv, hiddenSlug, ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("joining the private space = %d, want 204", resp.StatusCode)
	}
	_, body = listOrgSpacesPaged(t, srv, ada, 1)
	found := false
	for _, row := range body {
		if row["slug"] == hiddenSlug {
			found = true
			if row["member"] != true {
				t.Errorf("member = %v for a space the caller belongs to, want true", row["member"])
			}
		}
	}
	if !found {
		t.Errorf("a private space the caller belongs to is missing from the directory: %v", body)
	}

	// Outside the org: 404, and not an empty 200. A 200 would confirm the org
	// exists, which is the same disclosure requireOrgMember refuses everywhere
	// else.
	if _, err := pool.Exec(ctx,
		"update org_members set revoked_at = now() where user_id = $1", adaID); err != nil {
		t.Fatal(err)
	}
	if resp, body := listOrgSpaces(t, srv, ada); resp.StatusCode != http.StatusNotFound {
		t.Errorf("someone outside the org reading the directory = %d, want 404 (%v)", resp.StatusCode, body)
	}
	// And an anonymous caller never reaches it at all: the directory is a list
	// of rooms, which is exactly what a stranger must not be handed.
	if resp, _ := listOrgSpaces(t, srv, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("an anonymous caller reading the directory = %d, want 401", resp.StatusCode)
	}
}

// TestSetVisibilityIsOwnerOnly pins the gate on the new write. Visibility is
// what decides who can see a room at all, so it is housekeeping on the space —
// the same owner-only class as renaming and deleting it — and a non-member is
// told 404 rather than 403.
func TestSetVisibilityIsOwnerOnly(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	sp := createOpenSpace(t, srv, "Owned "+randomSlugSuffix(t), fay)
	slug := sp["slug"].(string)

	ada := signup(t, srv, "Ada")
	if got := setVisibility(t, srv, slug, store.VisibilityPrivate, ada); got != http.StatusNotFound {
		t.Errorf("a non-member setting visibility = %d, want 404 — 403 would confirm the space exists", got)
	}
	if resp := joinSpace(t, srv, slug, ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("joining = %d, want 204", resp.StatusCode)
	}
	if got := setVisibility(t, srv, slug, store.VisibilityPrivate, ada); got != http.StatusForbidden {
		t.Errorf("an ordinary member setting visibility = %d, want 403", got)
	}
	if got := setVisibility(t, srv, slug, store.VisibilityPrivate, fay); got != http.StatusNoContent {
		t.Errorf("the owner setting visibility = %d, want 204", got)
	}
	if got := setVisibility(t, srv, slug, "public", fay); got != http.StatusBadRequest {
		t.Errorf("an unknown visibility = %d, want 400", got)
	}
}

// TestVisibilityAndPasscodeAreIndependent is what makes "listed but locked" a
// real state. Org visibility governs discovery — being in the directory — and
// never entry, so neither route may silently strip the other: a passcode set
// on an org-visible space would otherwise be one visibility change away from
// being gone, and nothing would say so.
func TestVisibilityAndPasscodeAreIndependent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	// A protected space, which is what createSpace makes by default.
	_, sp := createSpace(t, srv, "Locked "+randomSlugSuffix(t), fay)
	slug := sp["slug"].(string)
	passcode := sp["passcode"].(string)
	makeOrgVisible(t, pool, slug)

	// Setting visibility leaves the passcode exactly where it was.
	if got := setVisibility(t, srv, slug, store.VisibilityPrivate, fay); got != http.StatusNoContent {
		t.Fatalf("setting visibility = %d, want 204", got)
	}
	var stillLocked string
	if err := pool.QueryRow(ctx, "select passcode from spaces where slug = $1", slug).Scan(&stillLocked); err != nil {
		t.Fatal(err)
	}
	if stillLocked != passcode {
		t.Errorf("the passcode changed when visibility did: %q -> %q", passcode, stillLocked)
	}

	// And rotating the passcode leaves visibility where it was.
	makeOrgVisible(t, pool, slug)
	if got, err := requestStatus(srv, "POST",
		"/api/orgs/"+store.DefaultOrgSlug+"/spaces/"+slug+"/passcode", `{}`, fay); err != nil || got != http.StatusOK {
		t.Fatalf("rotating the passcode = %d (%v), want 200", got, err)
	}
	var visibility string
	if err := pool.QueryRow(ctx, "select visibility from spaces where slug = $1", slug).Scan(&visibility); err != nil {
		t.Fatal(err)
	}
	if visibility != store.VisibilityOrg {
		t.Errorf("visibility = %q after a passcode rotation, want %q", visibility, store.VisibilityOrg)
	}
}

// TestPasscodeStillGatesAnOrgVisibleSpace and
// TestOrgMemberJoinsAnOpenOrgVisibleSpace are regression pins rather than
// red-to-green work: handleJoinSpace already sits behind requireOrgMember and
// already gates on the passcode independently of visibility, so this phase
// changes nothing about either. They are here because that independence is
// precisely what makes org visibility safe, and it must not be quietly
// "simplified" later into "org-visible means anyone in the org walks in".
func TestPasscodeStillGatesAnOrgVisibleSpace(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Listed And Locked "+randomSlugSuffix(t), fay)
	slug := sp["slug"].(string)
	passcode := sp["passcode"].(string)
	makeOrgVisible(t, pool, slug)

	ada := signup(t, srv, "Ada")
	if resp := joinSpace(t, srv, slug, ada); resp.StatusCode != http.StatusForbidden {
		t.Errorf("an org member joining a passcode-protected org-visible space with no passcode = %d, want 403 — visibility governs discovery, not entry",
			resp.StatusCode)
	}
	if resp := joinSpace(t, srv, slug, ada, passcode); resp.StatusCode != http.StatusNoContent {
		t.Errorf("the same member presenting the passcode = %d, want 204", resp.StatusCode)
	}
}

func TestOrgMemberJoinsAnOpenOrgVisibleSpace(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	sp := createOpenSpace(t, srv, "Walk In "+randomSlugSuffix(t), fay)
	slug := sp["slug"].(string)
	makeOrgVisible(t, pool, slug)

	ada := signup(t, srv, "Ada")
	if resp := joinSpace(t, srv, slug, ada); resp.StatusCode != http.StatusNoContent {
		t.Errorf("an org member joining an open org-visible space = %d, want 204", resp.StatusCode)
	}
}

// TestMemberSpaceViewCarriesVisibility is what the settings page reads to know
// which control to show. It is member-only on purpose, and
// TestAnonymousSpaceViewCarriesNoOrgData pins the other half: a stranger at the
// door is not told whether the room is listed to its org.
func TestMemberSpaceViewCarriesVisibility(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	fay := signup(t, srv, "Fay")
	sp := createOpenSpace(t, srv, "Shown "+randomSlugSuffix(t), fay)
	slug := sp["slug"].(string)

	_, view := getSpace(t, srv, slug, fay)
	if view["visibility"] != store.VisibilityPrivate {
		t.Errorf("visibility in the member view = %v, want %q", view["visibility"], store.VisibilityPrivate)
	}
	makeOrgVisible(t, pool, slug)
	_, view = getSpace(t, srv, slug, fay)
	if view["visibility"] != store.VisibilityOrg {
		t.Errorf("visibility in the member view = %v, want %q", view["visibility"], store.VisibilityOrg)
	}
}
