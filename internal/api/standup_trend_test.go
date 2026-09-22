package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// trendNow is a Wednesday. The week it sits in (from Monday 21 September) is
// still running, so the last week the trend reports starts 14 September.
var trendNow = time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

func trendURL(slug string) string {
	return "/api/orgs/default/spaces/" + slug + "/standup-trend"
}

// trendSpace is a space holding exactly n members: the owner, who created it
// through the API, and n-1 more written straight in. It returns the owner's
// cookie, the slug, the space id and every member's id, the owner's first.
func trendSpace(t *testing.T, srv *httptest.Server, pool *pgxpool.Pool, n int) (*http.Cookie, string, string, []string) {
	t.Helper()
	owner := signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Trend Space", owner)
	slug := sp["slug"].(string)
	ctx := context.Background()
	var spaceID string
	if err := pool.QueryRow(ctx, "select id::text from spaces where slug = $1", slug).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	ids := []string{userIDOf(t, srv, owner)}
	for i := 1; i < n; i++ {
		ids = append(ids, trendMember(t, pool, spaceID, fmt.Sprintf("Member %d", i)))
	}
	return owner, slug, spaceID, ids
}

func trendMember(t *testing.T, pool *pgxpool.Pool, spaceID, name string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id::text", name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", spaceID, id); err != nil {
		t.Fatal(err)
	}
	return id
}

// asyncStandupOn writes an async standup created at the given instant, and an
// answer from each of the answering users.
func asyncStandupOn(t *testing.T, pool *pgxpool.Pool, spaceID, facilitator string, at time.Time, answering ...string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id, created_at, ended_at)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2, $3::timestamptz, $3::timestamptz + interval '1 day')
		returning id::text`, spaceID, facilitator, at).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for i, u := range answering {
		if _, err := pool.Exec(ctx, `
			insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'shipped it', $3)`,
			id, u, i+1); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func awayOn(t *testing.T, pool *pgxpool.Pool, userID string, from, to string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"insert into standup_away (user_id, starts_on, ends_on) values ($1, $2, $3)", userID, from, to); err != nil {
		t.Fatal(err)
	}
}

func getRaw(t *testing.T, srv *httptest.Server, path string, cookie *http.Cookie) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

type trendWeek struct {
	WeekStart  string   `json:"weekStart"`
	Ratio      *float64 `json:"ratio"`
	Suppressed bool     `json:"suppressed"`
}

func readTrend(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) map[string]trendWeek {
	t.Helper()
	status, body := getRaw(t, srv, trendURL(slug), cookie)
	if status != http.StatusOK {
		t.Fatalf("trend: got %d %s", status, body)
	}
	var out struct {
		Weeks []trendWeek `json:"weeks"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	byWeek := map[string]trendWeek{}
	for _, w := range out.Weeks {
		byWeek[w.WeekStart] = w
	}
	return byWeek
}

func trendServer(t *testing.T) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return testServerWith(t, pool, Options{AllowedOrigin: "http://example.test", Now: func() time.Time { return trendNow }}), pool
}

var lastWeek = time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)

func TestStandupTrendIsSuppressedAtThreeAndShownAtFour(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 3)
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids[0], ids[1])

	w := readTrend(t, srv, slug, owner)["2026-09-14"]
	if !w.Suppressed || w.Ratio != nil {
		t.Fatalf("three eligible: got %+v, want suppressed with no ratio", w)
	}

	trendMember(t, pool, spaceID, "Fourth")
	w = readTrend(t, srv, slug, owner)["2026-09-14"]
	if w.Suppressed || w.Ratio == nil || *w.Ratio != 0.5 {
		t.Fatalf("four eligible, two answered: got %+v, want ratio 0.5", w)
	}
}

// Away people and link guests are not eligible: neither the count that
// decides suppression nor the denominator includes them, and an answer one of
// them wrote is not counted either.
func TestStandupTrendLeavesOutAwayPeopleAndLinkGuests(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 5)
	ctx := context.Background()
	sess := asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids[0], ids[1], ids[4])
	awayOn(t, pool, ids[4], "2026-09-14", "2026-09-16")

	// A link guest holds a users row and no members row. Give this one a
	// members row anyway: the link_id filter has to hold on its own.
	token := make([]byte, 32)
	rand.Read(token)
	var linkID, guest string
	if err := pool.QueryRow(ctx, `
		insert into session_links (session_id, created_by, token_hash, expires_at)
		values ($1, $2, $3, now() + interval '1 day') returning id::text`, sess, ids[0], token).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into users (name, link_id) values ('Guest', $1) returning id::text", linkID).Scan(&guest); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", spaceID, guest); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'hi', 9)", sess, guest); err != nil {
		t.Fatal(err)
	}

	// Eligible: the owner and members 1 to 3. Answered: the owner and member 1.
	w := readTrend(t, srv, slug, owner)["2026-09-14"]
	if w.Suppressed || w.Ratio == nil || *w.Ratio != 0.5 {
		t.Fatalf("got %+v, want ratio 0.5 over four eligible", w)
	}

	// One more away that day brings the eligible count to three: suppressed.
	awayOn(t, pool, ids[3], "2026-09-15", "2026-09-15")
	if w := readTrend(t, srv, slug, owner)["2026-09-14"]; !w.Suppressed || w.Ratio != nil {
		t.Fatalf("three eligible after a second away: got %+v, want suppressed", w)
	}
}

// A day on which fewer than four were eligible contributes nothing, even in a
// week that is shown: otherwise the one person present on a thin day could be
// read out of the week's ratio.
func TestStandupTrendDropsAThinDayInsideAShownWeek(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 4)
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids...)
	thin := lastWeek.AddDate(0, 0, 1)
	asyncStandupOn(t, pool, spaceID, ids[0], thin)
	for _, u := range ids[1:] {
		awayOn(t, pool, u, "2026-09-16", "2026-09-16")
	}
	w := readTrend(t, srv, slug, owner)["2026-09-14"]
	if w.Suppressed || w.Ratio == nil || *w.Ratio != 1 {
		t.Fatalf("got %+v, want 1 from the full day alone", w)
	}
}

// The window is fixed: twelve completed weeks ending before the current one,
// whatever the query string asks for, so moving the window cannot be used to
// difference one week against another. The running week is never reported.
func TestStandupTrendWindowIsFixed(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 4)
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids...)
	asyncStandupOn(t, pool, spaceID, ids[0], trendNow.Add(-time.Hour), ids...)

	_, plain := getRaw(t, srv, trendURL(slug), owner)
	for _, q := range []string{"?weeks=1", "?from=2026-09-21&to=2026-09-28", "?weeks=52&since=2020-01-01"} {
		if _, got := getRaw(t, srv, trendURL(slug)+q, owner); string(got) != string(plain) {
			t.Fatalf("query %s changed the answer:\n%s\nwant\n%s", q, got, plain)
		}
	}
	var out struct {
		Weeks []trendWeek `json:"weeks"`
	}
	if err := json.Unmarshal(plain, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Weeks) != 12 || out.Weeks[0].WeekStart != "2026-06-29" || out.Weeks[11].WeekStart != "2026-09-14" {
		t.Fatalf("weeks: %s", plain)
	}
}

// The response is a team aggregate and nothing else. This reads the raw JSON
// rather than decoding into a struct, so a handler that marshalled an untyped
// map with a per-person field in it would be caught.
func TestStandupTrendResponseCarriesOnlyAllowedKeys(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 5)
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids[0], ids[1], ids[2])
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek.AddDate(0, 0, -7), ids[0])
	awayOn(t, pool, ids[1], "2026-09-07", "2026-09-07")

	status, body := getRaw(t, srv, trendURL(slug), owner)
	if status != http.StatusOK {
		t.Fatalf("trend: %d %s", status, body)
	}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"weeks": true, "weekStart": true, "ratio": true, "suppressed": true}
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, child := range x {
				if !allowed[k] {
					t.Errorf("response key %q is outside the allow-list: %s", k, body)
				}
				walk(child)
			}
		case []any:
			for _, child := range x {
				walk(child)
			}
		}
	}
	walk(raw)
	for _, id := range ids {
		if strings.Contains(string(body), id) {
			t.Errorf("response names user %s: %s", id, body)
		}
	}
}

func TestStandupTrendIsForSpaceMembersOnly(t *testing.T) {
	srv, pool := trendServer(t)
	_, slug, _, _ := trendSpace(t, srv, pool, 1)
	outsider := signup(t, srv, "Outsider")
	if status, body := getRaw(t, srv, trendURL(slug), outsider); status != http.StatusNotFound {
		t.Fatalf("outsider: got %d %s, want 404", status, body)
	}
	if status, _ := getRaw(t, srv, trendURL(slug), nil); status != http.StatusUnauthorized {
		t.Fatalf("anonymous: got %d, want 401", status)
	}
}
