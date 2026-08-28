package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mintHandle knocks on the anonymous mint door with a passcode and hands back
// the raw response plus its decoded body.
func mintHandle(t *testing.T, srv *httptest.Server, org, slug, passcode string) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, "POST", "/api/orgs/"+org+"/spaces/"+slug+"/invite", `{"passcode":"`+passcode+`"}`, nil)
}

// readBody reads a response body as a string, closing it.
func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// rawPost is doJSON without the JSON decode, so a failed mint and a failed
// join can be compared byte for byte.
func rawPost(t *testing.T, srv *httptest.Server, path, body string, cookie *http.Cookie) (int, string) {
	t.Helper()
	req, err := http.NewRequest("POST", srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, readBody(t, resp)
}

// A handle is only ever mintable by someone who already holds the passcode.
// If a wrong code — or no code at all — could mint one, the handle would be a
// passcode bypass, which is strictly worse than parking the code itself.
func TestInviteHandleNeedsTheRightPasscode(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Handle Gate", owner)
	slug := sp["slug"].(string)

	for _, wrong := range []string{"", "ZZZZZZ", "nonsense"} {
		resp, body := mintHandle(t, srv, "default", slug, wrong)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("minting with passcode %q = %d, want 403", wrong, resp.StatusCode)
		}
		if _, ok := body["handle"]; ok {
			t.Fatalf("minting with passcode %q handed back a handle: %v", wrong, body)
		}
	}

	// …and the refusal is indistinguishable from a failed join: same status,
	// same body, so the mint door is not a cheaper oracle than the join door.
	joiner := signup(t, srv, "Joiner")
	joinStatus, joinBody := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/join", `{"passcode":"ZZZZZZ"}`, joiner)
	mintStatus, mintBody := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/invite", `{"passcode":"ZZZZZZ"}`, nil)
	if mintStatus != joinStatus || mintBody != joinBody {
		t.Fatalf("a refused mint (%d %q) differs from a refused join (%d %q)", mintStatus, mintBody, joinStatus, joinBody)
	}
}

// The right passcode mints a handle, and that handle seats exactly one person.
func TestInviteHandleIsSingleUse(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Single Use", owner)
	slug, code := sp["slug"].(string), sp["passcode"].(string)

	resp, body := mintHandle(t, srv, "default", slug, code)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("minting with the right passcode = %d, want 201 (%v)", resp.StatusCode, body)
	}
	handle, _ := body["handle"].(string)
	if handle == "" {
		t.Fatalf("no handle in the mint response: %v", body)
	}

	first := signup(t, srv, "First")
	if got, _ := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/join", `{"handle":"`+handle+`"}`, first); got != http.StatusNoContent {
		t.Fatalf("joining with a fresh handle = %d, want 204", got)
	}
	second := signup(t, srv, "Second")
	if got, _ := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/join", `{"handle":"`+handle+`"}`, second); got != http.StatusForbidden {
		t.Fatalf("joining with an already-spent handle = %d, want 403", got)
	}
}

// Two requests racing on one handle: the database decides, and exactly one of
// them gets in. Application-level "read then mark" would admit both.
func TestConcurrentInviteHandleRedemptionAdmitsOnce(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Race", owner)
	slug, code := sp["slug"].(string), sp["passcode"].(string)

	resp, body := mintHandle(t, srv, "default", slug, code)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint = %d (%v)", resp.StatusCode, body)
	}
	handle := body["handle"].(string)

	const racers = 8
	cookies := make([]*http.Cookie, racers)
	for i := range cookies {
		cookies[i] = signup(t, srv, "Racer")
	}
	statuses := concurrentStatuses(t, racers, func(i int) (int, error) {
		return requestStatus(srv, "POST", "/api/orgs/default/spaces/"+slug+"/join", `{"handle":"`+handle+`"}`, cookies[i])
	})
	admitted := 0
	for _, s := range statuses {
		if s == http.StatusNoContent {
			admitted++
		}
	}
	if admitted != 1 {
		t.Fatalf("%d of %d concurrent redemptions were admitted, want exactly 1 (%v)", admitted, racers, statuses)
	}
}

// A handle is a capability on one space. It must not open a different space,
// and — since a slug is unique only inside an org — must not open a space of
// the same name in another org.
func TestInviteHandleIsBoundToOneSpace(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Bound "+randomSlugSuffix(t), owner)
	slug, code := sp["slug"].(string), sp["passcode"].(string)
	_, other := createSpace(t, srv, "Elsewhere "+randomSlugSuffix(t), owner)
	otherSlug := other["slug"].(string)

	// A same-named space in a second org, with the joiner enrolled there so
	// requireOrgMember cannot be what refuses the handle.
	orgSlug := "twin-" + randomSlugSuffix(t)
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Twin', $1) returning id", orgSlug).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into spaces (org_id, slug, name, passcode) values ($1, $2, 'Twin Space', 'QQQQQQ')", orgID, slug); err != nil {
		t.Fatal(err)
	}

	resp, body := mintHandle(t, srv, "default", slug, code)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint = %d (%v)", resp.StatusCode, body)
	}
	handle := body["handle"].(string)

	joiner, joinerID := signupWithID(t, srv, "Joiner")
	if _, err := pool.Exec(ctx,
		"insert into org_members (org_id, user_id) values ($1, $2)", orgID, joinerID); err != nil {
		t.Fatal(err)
	}

	if got, _ := rawPost(t, srv, "/api/orgs/default/spaces/"+otherSlug+"/join", `{"handle":"`+handle+`"}`, joiner); got != http.StatusForbidden {
		t.Fatalf("a handle for one space joined a different space in the same org: %d, want 403", got)
	}
	if got, _ := rawPost(t, srv, "/api/orgs/"+orgSlug+"/spaces/"+slug+"/join", `{"handle":"`+handle+`"}`, joiner); got != http.StatusForbidden {
		t.Fatalf("a handle for one org's space joined a same-named space in another org: %d, want 403", got)
	}
	// Still unspent where it belongs: the refusals above must not have
	// consumed it.
	if got, _ := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/join", `{"handle":"`+handle+`"}`, joiner); got != http.StatusNoContent {
		t.Fatalf("the handle no longer works on its own space: %d, want 204", got)
	}
}

// The mint endpoint is a passcode attempt, so it spends from the same budget
// the join door does. An unthrottled mint would be a passcode-guessing oracle
// with no account required at all.
func TestInviteHandleMintIsThrottled(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Throttled Mint", owner)
	slug := sp["slug"].(string)

	for i := range passcodeAttemptLimit {
		resp, _ := mintHandle(t, srv, "default", slug, "ZZZZZZ")
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("mint guess %d = %d, want 403", i+1, resp.StatusCode)
		}
	}
	resp, _ := mintHandle(t, srv, "default", slug, "ZZZZZZ")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("the mint past the limit = %d, want 429 — the mint door has its own budget", resp.StatusCode)
	}
	// One budget, not two: the join door is spent as well.
	joiner := signup(t, srv, "Joiner")
	if got, _ := rawPost(t, srv, "/api/orgs/default/spaces/"+slug+"/join", `{"passcode":"ZZZZZZ"}`, joiner); got != http.StatusTooManyRequests {
		t.Fatalf("joining after the mint budget was spent = %d, want 429 — the two doors must share one budget", got)
	}
}

// Nothing anonymous may learn whether a space exists from this route: a bad
// org, a bad slug and a real space in another org all answer the same 404 the
// anonymous space read does.
func TestInviteHandleMintKeepsThe404Posture(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Posture "+randomSlugSuffix(t), owner)
	slug := sp["slug"].(string)

	want := http.StatusNotFound
	for _, path := range []string{
		"/api/orgs/no-such-org/spaces/" + slug + "/invite",
		"/api/orgs/default/spaces/no-such-space-anywhere/invite",
		"/api/orgs/no-such-org/spaces/no-such-space-anywhere/invite",
	} {
		got, body := rawPost(t, srv, path, `{"passcode":"ZZZZZZ"}`, nil)
		if got != want || body != "{\"error\":\"no such space\"}\n" {
			t.Errorf("POST %s = %d %q, want %d and the same body as any other miss", path, got, body, want)
		}
	}
}
