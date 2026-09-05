package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// noRedirectGet issues a GET that stops at the first response, so the redirect
// itself is what the assertions see rather than whatever it points at.
func noRedirectGet(t *testing.T, srv *httptest.Server, path string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	client := *srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// capturedResponse is a response flattened for comparison. The header set is
// rendered as a sorted string so two responses can be compared whole.
type capturedResponse struct {
	status  int
	body    string
	headers string
}

// perRequestHeaders are excluded from the comparison because they legitimately
// differ between any two requests, whatever the outcome: Date is a clock
// reading, X-Request-Id is assigned per request. Everything else —
// Content-Type, Content-Length, the security headers — must match, since a
// difference in any of them is as much of an existence oracle as a difference
// in the status line.
var perRequestHeaders = map[string]bool{"Date": true, "X-Request-Id": true}

func captureResponse(t *testing.T, resp *http.Response) capturedResponse {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for name := range resp.Header {
		if !perRequestHeaders[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var sb strings.Builder
	for _, name := range names {
		values := append([]string(nil), resp.Header.Values(name)...)
		sort.Strings(values)
		fmt.Fprintf(&sb, "%s: %s\n", name, strings.Join(values, ", "))
	}
	return capturedResponse{status: resp.StatusCode, body: string(body), headers: sb.String()}
}

// otherOrgHoldingSlug inserts a second org owning a space with the given slug,
// optionally enrolling a user in it. Nothing in the API can create a space in
// a second org, so the slug collisions this file is about are built directly.
func otherOrgHoldingSlug(t *testing.T, pool *pgxpool.Pool, slug, creatorID, memberID string) string {
	t.Helper()
	ctx := context.Background()
	orgSlug := "other-" + randomSlugSuffix(t)
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id", orgSlug,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into spaces (org_id, slug, name, passcode, creator_id, visibility) values ($1, $2, 'Other space', '', $3, $4)",
		orgID, slug, creatorID, store.VisibilityPrivate); err != nil {
		t.Fatal(err)
	}
	if memberID != "" {
		if _, err := pool.Exec(ctx,
			"insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", orgID, memberID); err != nil {
			t.Fatal(err)
		}
	}
	return orgSlug
}

// TestLegacySpaceLinkRedirectsForASingleOrgMember is the whole point of the
// route: a link minted before space URLs carried an org still lands its reader
// in the room.
func TestLegacySpaceLinkRedirectsForASingleOrgMember(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Legacy "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)

	resp := noRedirectGet(t, srv, "/s/"+slug, ada)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("GET /s/%s = %d, want %d", slug, resp.StatusCode, http.StatusFound)
	}
	want := "/o/" + store.DefaultOrgSlug + "/s/" + slug
	if got := resp.Header.Get("Location"); got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

// TestLegacySpaceLinkServesTheSPAToAnonymous holds the case the server cannot
// answer: with no principal there is no membership to resolve against, so the
// client gets the app and sends the visitor through sign-in as it does today.
func TestLegacySpaceLinkServesTheSPAToAnonymous(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Anon "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)

	resp := noRedirectGet(t, srv, "/s/"+slug, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("anonymous GET /s/%s = %d, want 200 from the SPA", slug, resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "" {
		t.Errorf("anonymous GET /s/%s redirected to %q — the server cannot know which org is meant", slug, loc)
	}
}

// TestLegacySpaceLinkIs404WithoutAMatchingMembership separates "not signed in"
// from "signed in and this resolves to nothing": the second is a dead link,
// and saying so discloses nothing, because it is the caller's own memberships
// that were searched.
func TestLegacySpaceLinkIs404WithoutAMatchingMembership(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")

	resp := noRedirectGet(t, srv, "/s/nope-"+randomSlugSuffix(t), ada)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET a slug the caller has no membership for = %d, want 404", resp.StatusCode)
	}
}

// TestLegacySpaceLinkIsIndistinguishableAcrossOrgs closes the existence
// oracle: a slug that exists only in an org the caller is not in must answer
// exactly as a slug that exists nowhere. Status alone is not enough — a body
// or a header that differed would leak the same fact just as loudly — so the
// whole response is compared.
func TestLegacySpaceLinkIsIndistinguishableAcrossOrgs(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	hidden := "hidden-" + randomSlugSuffix(t)
	otherOrgHoldingSlug(t, pool, hidden, userIDOf(t, srv, ada), "")

	elsewhere := captureResponse(t, noRedirectGet(t, srv, "/s/"+hidden, ada))
	nowhere := captureResponse(t, noRedirectGet(t, srv, "/s/nope-"+randomSlugSuffix(t), ada))
	if elsewhere.status != nowhere.status {
		t.Errorf("a slug in an org the caller is not in answered %d but a slug that exists nowhere answered %d — that difference is a cross-org existence oracle", elsewhere.status, nowhere.status)
	}
	if elsewhere.body != nowhere.body {
		t.Errorf("a slug in an org the caller is not in answered body %q but a slug that exists nowhere answered %q — that difference is a cross-org existence oracle", elsewhere.body, nowhere.body)
	}
	if elsewhere.headers != nowhere.headers {
		t.Errorf("a slug in an org the caller is not in answered headers %q but a slug that exists nowhere answered %q — that difference is a cross-org existence oracle", elsewhere.headers, nowhere.headers)
	}
}

// TestLegacySpaceLinkIgnoresAnotherUsersMembershipInAnotherOrg is the test that
// separates "an org I am a member of holds this slug" from "somebody is a
// member of an org that holds this slug". Bob really belongs to the other org;
// Ada does not, and must not be redirected through his membership.
func TestLegacySpaceLinkIgnoresAnotherUsersMembershipInAnotherOrg(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	bob := signup(t, srv, "Bob")
	bobID := userIDOf(t, srv, bob)
	hidden := "hidden-" + randomSlugSuffix(t)
	otherOrgHoldingSlug(t, pool, hidden, bobID, bobID)

	resp := noRedirectGet(t, srv, "/s/"+hidden, ada)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /s/%s = %d %q, want 404 — the slug is held by an org another user belongs to and the caller does not", hidden, resp.StatusCode, resp.Header.Get("Location"))
	}
}

// TestLegacySpaceLinkIgnoresACollisionInAnotherOrg is the guarantee that makes
// an old link stable: a space created later, elsewhere, under the same slug
// cannot change where an existing link sends a member of the original org.
func TestLegacySpaceLinkIgnoresACollisionInAnotherOrg(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Stable "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)
	otherOrgHoldingSlug(t, pool, slug, userIDOf(t, srv, ada), "")

	resp := noRedirectGet(t, srv, "/s/"+slug, ada)
	want := "/o/" + store.DefaultOrgSlug + "/s/" + slug
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != want {
		t.Fatalf("GET /s/%s = %d %q, want %d %q", slug, resp.StatusCode, resp.Header.Get("Location"), http.StatusFound, want)
	}
}

// TestLegacySpaceLinkRefusesAnAmbiguousMatch is the case that did not exist
// before this epic and does now: two of the caller's own orgs hold the slug.
// Guessing would drop somebody into the wrong tenant's room, and the issue
// rules out a disambiguation screen, so the route declines to resolve it.
func TestLegacySpaceLinkRefusesAnAmbiguousMatch(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Ambiguous "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)
	adaID := userIDOf(t, srv, ada)
	otherOrgHoldingSlug(t, pool, slug, adaID, adaID)

	resp := noRedirectGet(t, srv, "/s/"+slug, ada)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /s/%s with two matching memberships = %d, want 404 rather than a guess", slug, resp.StatusCode)
	}
}

// TestLegacyRedirectMatchesOnlySpacePaths pins the blast radius of the route
// pattern: /link, /session/{id} and / still reach the SPA unredirected, so the
// shim resolves /s/{slug} and nothing else. It says nothing about who the
// handler will redirect — that a link guest gets the app shell rather than a
// redirect is pinned by TestLinkGuestRouteTable, and that an anonymous caller
// does by TestLegacySpaceLinkServesTheSPAToAnonymous.
func TestLegacyRedirectMatchesOnlySpacePaths(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")

	for _, path := range []string{"/link", "/session/" + randomSlugSuffix(t), "/"} {
		resp := noRedirectGet(t, srv, path, ada)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200 from the SPA", path, resp.StatusCode)
		}
		if loc := resp.Header.Get("Location"); loc != "" {
			t.Errorf("GET %s redirected to %q — the redirect must match /s/{slug} only", path, loc)
		}
	}
}
