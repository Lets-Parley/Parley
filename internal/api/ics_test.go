package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/api/custody"
	"github.com/lets-parley/parley/internal/store"
)

// icsFixture is a hand-written calendar. It is not produced by RenderCalendar,
// so this test fails if the handler drifts from those RFC 5545 bytes.
const icsFixture = "BEGIN:VCALENDAR\r\n" +
	"VERSION:2.0\r\n" +
	"PRODID:-//Parley//Async standup//EN\r\n" +
	"CALSCALE:GREGORIAN\r\n" +
	"METHOD:PUBLISH\r\n" +
	"BEGIN:VEVENT\r\n" +
	"UID:standup-11111111-1111-4111-8111-111111111111@parley\r\n" +
	"DTSTAMP:20260923T143000Z\r\n" +
	"DTSTART:20260923T140000Z\r\n" +
	"DTEND:20260923T150000Z\r\n" +
	"SUMMARY:Platform\\, East standup\r\n" +
	"DESCRIPTION:https://parley.example/session/11111111-1111-4111-8111-11111111\r\n" +
	" 1111\r\n" +
	"BEGIN:VALARM\r\n" +
	"ACTION:DISPLAY\r\n" +
	"DESCRIPTION:Standup\r\n" +
	"TRIGGER:-PT15M\r\n" +
	"END:VALARM\r\n" +
	"END:VEVENT\r\n" +
	"END:VCALENDAR\r\n"

func TestICSFeedMatchesRFC5545Fixture(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	now := time.Date(2026, 9, 23, 14, 30, 0, 0, time.UTC)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: "https://parley.example",
		Now:           func() time.Time { return now },
	})
	ada := signup(t, srv, "Ada")
	_, me := doJSON(t, srv, "GET", "/api/me", "", ada)
	userID := me["id"].(string)

	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (org_id, slug, name) values ('00000000-0000-0000-0000-000000000001', $1, 'Platform, East') returning id",
		"ics-fix-"+fmt.Sprint(time.Now().UnixNano()),
	).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, userID); err != nil {
		t.Fatal(err)
	}
	const sessionID = "11111111-1111-4111-8111-111111111111"
	if _, err := pool.Exec(ctx, "delete from sessions where id = $1", sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into sessions (id, space_id, kind, title, config, facilitator_id, created_at)
		values ($1, $2, 'standup', 'Async', $3, $4, $5)`,
		sessionID, spaceID,
		`{"mode":"async","closesAt":"2026-09-23T15:00:00Z"}`,
		userID, time.Date(2026, 9, 23, 14, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		 values ($1, $2, 'y', 't', 'never-leak-this-blocker', 1)`,
		sessionID, userID); err != nil {
		t.Fatal(err)
	}

	plain := mintICS(t, srv, ada, 15)
	resp, body := getICS(t, srv, plain)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("feed: got %d (%s)", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/calendar; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if string(body) != icsFixture {
		t.Fatalf("feed mismatch\n got:\n%s\nwant:\n%s", strings.ReplaceAll(string(body), "\r", "\\r"), strings.ReplaceAll(icsFixture, "\r", "\\r"))
	}
	if strings.Contains(string(body), "never-leak-this-blocker") {
		t.Fatal("the feed carried standup entry content")
	}
}

func TestICSRejectsRemindMinutesOutOfRange(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	for _, body := range []string{`{}`, `{"remindMinutes":-1}`, `{"remindMinutes":1441}`, `{"remindMinutes":1.5}`} {
		if resp, _ := doJSON(t, srv, http.MethodPost, "/api/me/ics", body, ada); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", body, resp.StatusCode)
		}
	}
}

func TestRevokedICSTokenAnswers404(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	plain := mintICS(t, srv, ada, 15)

	if resp, _ := getICS(t, srv, plain); resp.StatusCode != http.StatusOK {
		t.Fatalf("live token: got %d, want 200", resp.StatusCode)
	}
	resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/ics", "", ada)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: got %d, want 204", resp.StatusCode)
	}
	if resp, body := getICS(t, srv, plain); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked token: got %d (%s), want 404", resp.StatusCode, body)
	}
	if resp, body := getICS(t, srv, "not-a-token"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("bad token: got %d (%s), want 404", resp.StatusCode, body)
	}
}

func TestLostSpaceVanishesFromICSFeed(t *testing.T) {
	srv := testServer(t)
	cookies, ids, sessionID := standupSpace(t, srv, "Lost Feed Space", "Ada", "Bob")
	ada, bob := cookies[0], cookies[1]
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", ada)
	slug := env["spaceSlug"].(string)
	asyncID := asyncStandup(t, srv, sessionID, ada, `{"mode":"async","closesAt":"2099-01-01T00:00:00Z"}`)

	plain := mintICS(t, srv, bob, 10)
	if resp, body := getICS(t, srv, plain); resp.StatusCode != http.StatusOK || !strings.Contains(string(body), asyncID) {
		t.Fatalf("feed before removal: %d\n%s", resp.StatusCode, body)
	}
	resp, _ := doJSON(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug+"/members/"+ids[1]+"/", "", ada)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove member: got %d", resp.StatusCode)
	}
	resp, body := getICS(t, srv, plain)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("feed after removal: got %d (%s)", resp.StatusCode, body)
	}
	if strings.Contains(string(body), asyncID) || strings.Contains(string(body), slug) {
		t.Fatalf("lost space still in the feed:\n%s", body)
	}
}

// TestOrgTombstoneVanishesFromICSFeed proves the feed also requires a live
// org membership: revoking org_members (revoked_at set, no cascade) without
// touching the members row must still drop the org's windows.
func TestOrgTombstoneVanishesFromICSFeed(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	cookies, _, sessionID := standupSpace(t, srv, "Org Tombstone Space", "Ada", "Bob")
	ada, bob := cookies[0], cookies[1]
	asyncID := asyncStandup(t, srv, sessionID, ada, `{"mode":"async","closesAt":"2099-01-01T00:00:00Z"}`)

	plain := mintICS(t, srv, bob, 10)
	if resp, body := getICS(t, srv, plain); resp.StatusCode != http.StatusOK || !strings.Contains(string(body), asyncID) {
		t.Fatalf("feed before revoke: %d\n%s", resp.StatusCode, body)
	}

	_, bobMe := doJSON(t, srv, "GET", "/api/me", "", bob)
	org, err := (&store.Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"update org_members set revoked_at = now() where org_id = $1 and user_id = $2",
		org.ID, bobMe["id"]); err != nil {
		t.Fatal(err)
	}

	// The members row is deliberately left in place: this proves the feed
	// checks org membership independently of the space-level join.
	var stillMember int
	if err := pool.QueryRow(ctx,
		"select count(*) from members where user_id = $1", bobMe["id"]).Scan(&stillMember); err != nil {
		t.Fatal(err)
	}
	if stillMember == 0 {
		t.Fatal("test setup: members row was removed, this test needs it intact")
	}

	resp, body := getICS(t, srv, plain)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("feed after org revoke: got %d (%s)", resp.StatusCode, body)
	}
	if strings.Contains(string(body), asyncID) {
		t.Fatalf("an org tombstone did not remove the space's windows from the feed:\n%s", body)
	}
}

// TestOpenEndedAsyncWindowStaysCurrent proves an open manual async standup
// (no closesAt) left running past its nominal created+24h window still reads
// as a currently-open event rather than one that ended in the past.
func TestOpenEndedAsyncWindowStaysCurrent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	created := time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)
	now := created.Add(72 * time.Hour) // three days later: created+24h is long past
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: "https://parley.example",
		Now:           func() time.Time { return now },
	})
	ada := signup(t, srv, "Ada")
	_, me := doJSON(t, srv, "GET", "/api/me", "", ada)
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (org_id, slug, name) values ('00000000-0000-0000-0000-000000000001', $1, 'Open Window') returning id",
		"ics-open-"+fmt.Sprint(time.Now().UnixNano()),
	).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, me["id"]); err != nil {
		t.Fatal(err)
	}
	const sessionID = "22222222-2222-4222-8222-222222222222"
	if _, err := pool.Exec(ctx, "delete from sessions where id = $1", sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into sessions (id, space_id, kind, title, config, facilitator_id, created_at)
		values ($1, $2, 'standup', 'Async', $3, $4, $5)`,
		sessionID, spaceID, `{"mode":"async"}`, me["id"], created); err != nil {
		t.Fatal(err)
	}

	plain := mintICS(t, srv, ada, 15)
	resp, body := getICS(t, srv, plain)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("feed: got %d (%s)", resp.StatusCode, body)
	}
	text := string(body)
	if !strings.Contains(text, "DTEND:"+now.Add(1*time.Hour).UTC().Format("20060102T150405Z")) {
		t.Fatalf("open window did not end at now+1h:\n%s", text)
	}
	if strings.Contains(text, "DTEND:"+created.Add(24*time.Hour).UTC().Format("20060102T150405Z")) {
		t.Fatalf("open window still ended at the stale created+24h time:\n%s", text)
	}
}

func TestICSLogLineDoesNotContainTheToken(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	plain := mintICS(t, srv, ada, 15)
	logs := captureDefaultJSON(t)
	getICS(t, srv, plain)
	logged := logs.String()
	if strings.Contains(logged, plain) {
		t.Fatalf("the log line contains the feed token:\n%s", logged)
	}
	if !strings.Contains(logged, "/ics/[redacted]") {
		t.Fatalf("the log line did not record the redacted path:\n%s", logged)
	}
}

func TestOrgRevokeRevokesTheICSToken(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	ada := signup(t, srv, "Ada")
	bob := signup(t, srv, "Bob")
	_, sp := createSpace(t, srv, "Revoke ICS Space", ada)
	if resp := joinSpace(t, srv, sp["slug"].(string), bob, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	plain := mintICS(t, srv, bob, 15)
	_, bobMe := doJSON(t, srv, "GET", "/api/me", "", bob)
	_, adaMe := doJSON(t, srv, "GET", "/api/me", "", ada)

	org, err := (&store.Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"update org_members set role = 'admin' where org_id = $1 and user_id = $2", org.ID, adaMe["id"]); err != nil {
		t.Fatal(err)
	}
	removed, blocked, err := (&custody.Store{Pool: pool}).RevokeOrgMember(ctx, custody.Scope{
		OrgID: org.ID, OrgSlug: org.Slug, ActorID: adaMe["id"].(string),
	}, bobMe["id"].(string))
	if err != nil || len(blocked) != 0 || len(removed) != 1 {
		t.Fatalf("revoke: removed %v blocked %v err %v", removed, blocked, err)
	}
	if resp, body := getICS(t, srv, plain); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("token after org revoke: got %d (%s), want 404", resp.StatusCode, body)
	}
}

func TestUserDeleteDropsTheICSToken(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	ada := signup(t, srv, "Ada")
	plain := mintICS(t, srv, ada, 15)
	_, me := doJSON(t, srv, "GET", "/api/me", "", ada)
	if _, err := pool.Exec(ctx, "delete from users where id = $1", me["id"]); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "select count(*) from ics_feed_tokens where user_id = $1", me["id"]).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("ics token rows after user delete = %d, want 0", n)
	}
	if resp, _ := getICS(t, srv, plain); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("token after user delete: got %d, want 404", resp.StatusCode)
	}
}

func TestScheduledSlotSurvivesSpringForward(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	// 2026-03-08 07:00 UTC is 03:00 EDT, before a 02:30 open that landed at 03:30.
	now := time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: "https://parley.example",
		Now:           func() time.Time { return now },
	})
	ada := signup(t, srv, "Ada")
	_, me := doJSON(t, srv, "GET", "/api/me", "", ada)
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (org_id, slug, name) values ('00000000-0000-0000-0000-000000000001', $1, 'Spring') returning id",
		"ics-spring-"+fmt.Sprint(time.Now().UnixNano()),
	).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, me["id"]); err != nil {
		t.Fatal(err)
	}
	// Sunday only, 02:30 New York. 2026-03-08 is a Sunday and the clocks jump.
	if _, err := pool.Exec(ctx, `
		insert into standup_schedules (space_id, weekdays, open_time, timezone, window_minutes, enabled, updated_by)
		values ($1, '{0}', '02:30', 'America/New_York', 30, true, $2)`, spaceID, me["id"]); err != nil {
		t.Fatal(err)
	}
	plain := mintICS(t, srv, ada, 15)
	resp, body := getICS(t, srv, plain)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("feed: got %d (%s)", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "DTSTART:20260308T073000Z") {
		t.Fatalf("spring-forward slot did not open at 03:30 EDT:\n%s", body)
	}
}

func mintICS(t *testing.T, srv *httptest.Server, cookie *http.Cookie, minutes int) string {
	t.Helper()
	resp, body := doJSON(t, srv, http.MethodPost, "/api/me/ics", fmt.Sprintf(`{"remindMinutes":%d}`, minutes), cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mint feed: got %d (%v)", resp.StatusCode, body)
	}
	url, _ := body["url"].(string)
	token := strings.TrimPrefix(url, "https://parley.example/ics/")
	token = strings.TrimPrefix(token, "http://example.test/ics/")
	if token == "" || token == url {
		t.Fatalf("mint did not return a feed url: %v", body)
	}
	return token
}

func getICS(t *testing.T, srv *httptest.Server, token string) (*http.Response, []byte) {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + "/ics/" + token)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, body
}
