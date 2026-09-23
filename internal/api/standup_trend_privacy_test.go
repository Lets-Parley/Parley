package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These are the attacks from the PR #646 review, run against the real router.
// Each one used to recover a single person's participation or away days from
// the team trend or from a reopened room. The expectations are worked by hand
// in the comments, never computed from the code under test.

type standupStateBody struct {
	State struct {
		Away []string `json:"away"`
	} `json:"state"`
}

func trendRatio(t *testing.T, w trendWeek) float64 {
	t.Helper()
	if w.Suppressed || w.Ratio == nil {
		t.Fatalf("week %s is suppressed, want a ratio", w.WeekStart)
	}
	return *w.Ratio
}

// Removing a member used to rebuild every past week without them, so the
// before-and-after ratios solved to that person's own rate and away days.
// A day is frozen when it ends: nobody joining or leaving afterwards moves it.
func TestTrendDoesNotMoveWhenAMemberLeavesOrJoins(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 6)
	O, A, B, C, D, X := ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]

	// The week of Monday 14 September. X answers Monday, Tuesday and
	// Thursday, misses Wednesday and is away Friday; D misses Thursday and
	// Friday and is never away.
	answers := [][]string{
		{O, A, B, C, D, X},
		{O, A, B, C, D, X},
		{O, A, B, C, D},
		{O, A, B, C, X},
		{O, A, B, C},
	}
	mon := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	for i, who := range answers {
		scheduledStandupOn(t, pool, spaceID, O, mon.AddDate(0, 0, i), who...)
	}
	awayOn(t, pool, X, "2026-09-18", "2026-09-18")

	// Eligible: 6+6+6+6+5 = 29. Answered: 6+6+5+5+4 = 26. 26/29 = 0.897,
	// which is 0.9 to one decimal. So are 26/28 and 26/30, which is why the
	// ratio no longer pins the eligible count down even to an attacker who
	// counted the 26 answers from the ended rooms.
	before := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"])
	if before != 0.9 {
		t.Fatalf("before: ratio %v, want 0.9 (26 of 29)", before)
	}

	resp, _ := doJSON(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug+"/members/"+X, "", owner)
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		t.Fatalf("removing X: got %d", resp.StatusCode)
	}
	// Rebuilt without X this was 22/24 = 0.917: the difference was X.
	if after := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"]); after != before {
		t.Fatalf("after removing X: ratio %v, want the frozen %v", after, before)
	}

	// A joiner is not a non-answerer on days before they joined.
	trendMember(t, pool, spaceID, "Joiner")
	if after := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"]); after != before {
		t.Fatalf("after a join: ratio %v, want the frozen %v", after, before)
	}
}

// A facilitator could reopen any ended standup, and an open async standup
// served its day's away list, so reopening an old one named who was away.
// The list is served only on the standup's own day.
func TestReopeningAnOldStandupServesNoAwayList(t *testing.T) {
	srv, pool := trendServer(t)
	owner, _, spaceID, ids := trendSpace(t, srv, pool, 5)
	X := ids[4]
	day := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC) // seven weeks back
	s := scheduledStandupOn(t, pool, spaceID, ids[0], day, ids[0], ids[1])
	awayOn(t, pool, X, "2026-08-03", "2026-08-07")

	if resp, _ := doJSON(t, srv, http.MethodPost, "/api/sessions/"+s+"/reopen", "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reopen: got %d, want 204", resp.StatusCode)
	}
	status, body := getRaw(t, srv, "/api/sessions/"+s, owner)
	var got standupStateBody
	if status != http.StatusOK || json.Unmarshal(body, &got) != nil {
		t.Fatalf("reopened room: %d %s", status, body)
	}
	if got.State.Away == nil || len(got.State.Away) != 0 {
		t.Fatalf("reopened 3 August standup serves away = %v, want an empty list", got.State.Away)
	}
}

// selfAwayWeek is five members and three scheduled standups in the week of
// 14 September. X, the last member, set Tuesday and Wednesday away well
// before either day. Answers: Monday everyone, Tuesday the owner, A and B,
// Wednesday the owner, A, B and C.
func selfAwayWeek(t *testing.T, srv *httptest.Server, pool *pgxpool.Pool) (*http.Cookie, string) {
	t.Helper()
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 5)
	O, A, B, C, X := ids[0], ids[1], ids[2], ids[3], ids[4]
	scheduledStandupOn(t, pool, spaceID, O, time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC), O, A, B, C, X)
	scheduledStandupOn(t, pool, spaceID, O, time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC), O, A, B)
	scheduledStandupOn(t, pool, spaceID, O, time.Date(2026, 9, 16, 10, 0, 0, 0, time.UTC), O, A, B, C)
	awayOn(t, pool, X, "2026-09-15", "2026-09-16")
	return owner, slug
}

// Setting your own away day on a past day used to drop that day out of the
// week, and the before-and-after ratios read the day back out. A frozen day
// does not move.
func TestSelfAwayOnAPastDayDoesNotMoveAFrozenDay(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug := selfAwayWeek(t, srv, pool)

	before := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"])
	if resp, _ := doJSON(t, srv, http.MethodPost, "/api/me/away", `{"startsOn":"2026-09-15","endsOn":"2026-09-15"}`, owner); resp.StatusCode != http.StatusCreated {
		t.Fatalf("self-away: got %d", resp.StatusCode)
	}
	// Were Tuesday rebuilt with the owner away it would have 3 eligible and
	// be dropped, leaving 9/9 = 1.0, and the change would read Tuesday out.
	if after := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"]); after != before {
		t.Fatalf("self-away on a past day moved the week from %v to %v", before, after)
	}
	// Monday 5 of 5, Tuesday 3 of 4, Wednesday 4 of 4: 12/13 = 0.923, which
	// is 0.9 to one decimal.
	if before != 0.9 {
		t.Fatalf("ratio %v, want 0.9 (12 of 13)", before)
	}
}

// The same backdating with no earlier read, so nothing has frozen the days
// yet: an away range created after a day was over does not count for it.
func TestAwaySetAfterTheDayIsOverDoesNotCount(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug := selfAwayWeek(t, srv, pool)
	if resp, _ := doJSON(t, srv, http.MethodPost, "/api/me/away", `{"startsOn":"2026-09-15","endsOn":"2026-09-15"}`, owner); resp.StatusCode != http.StatusCreated {
		t.Fatalf("self-away: got %d", resp.StatusCode)
	}
	// Still 12/13 = 0.9: the owner's range was created after Tuesday ended.
	if r := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"]); r != 0.9 {
		t.Fatalf("ratio %v, want 0.9 (12 of 13): an away day set after the fact counted", r)
	}
}

// Only standups the schedule opened are trend days. A room anyone can create
// by hand would let extra rooms be added to move a week.
func TestManualAsyncStandupsAreNotTrendDays(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 4)
	asyncStandupOn(t, pool, spaceID, ids[0], lastWeek, ids...)
	if w := readTrend(t, srv, slug, owner)["2026-09-14"]; !w.Suppressed || w.Ratio != nil {
		t.Fatalf("a manual async standup counted: got %+v, want suppressed", w)
	}
}

// Ending a scheduled standup freezes its counts in the same transaction, and
// the first freeze is the only one: a reopen, a late answer and a second end
// change nothing.
func TestEndingAScheduledStandupFreezesItsDayOnce(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 5)
	ctx := context.Background()
	s := scheduledStandupOn(t, pool, spaceID, ids[0], lastWeek, ids[0], ids[1])
	if _, err := pool.Exec(ctx, "update sessions set ended_at = null where id = $1", s); err != nil {
		t.Fatal(err)
	}

	frozen := func() (int, int, bool) {
		var eligible, answered int
		err := pool.QueryRow(ctx,
			"select eligible, answered from standup_trend_days where session_id = $1", s).Scan(&eligible, &answered)
		return eligible, answered, err == nil
	}
	if _, _, ok := frozen(); ok {
		t.Fatal("an open standup already has a frozen day")
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/sessions/"+s, "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("end: got %d", resp.StatusCode)
	}
	if e, a, ok := frozen(); !ok || e != 5 || a != 2 {
		t.Fatalf("frozen at end: eligible=%d answered=%d ok=%v, want 5 and 2", e, a, ok)
	}

	if resp, _ := doJSON(t, srv, http.MethodPost, "/api/sessions/"+s+"/reopen", "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reopen: got %d", resp.StatusCode)
	}
	for i, u := range ids[2:] {
		if _, err := pool.Exec(ctx,
			"insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'late', $3)", s, u, 10+i); err != nil {
			t.Fatal(err)
		}
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/sessions/"+s, "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second end: got %d", resp.StatusCode)
	}
	if e, a, ok := frozen(); !ok || e != 5 || a != 2 {
		t.Fatalf("after a reopen and late answers: eligible=%d answered=%d, want the first 5 and 2", e, a)
	}
	// 2/5 = 0.4.
	if r := trendRatio(t, readTrend(t, srv, slug, owner)["2026-09-14"]); r != 0.4 {
		t.Fatalf("trend: ratio %v, want 0.4 (2 of 5)", r)
	}
}

// A signed link is a capability on one room, never membership of its space:
// the guest's copy of an open async standup carries no away list, though a
// member's copy of the same room does.
func TestLinkGuestIsSentNoAwayList(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	owner, _, spaceID, ids := trendSpace(t, srv, pool, 3)
	ctx := context.Background()
	var s string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2) returning id::text`, spaceID, ids[0]).Scan(&s); err != nil {
		t.Fatal(err)
	}
	today := time.Now().UTC()
	if _, err := pool.Exec(ctx,
		"insert into standup_away (user_id, starts_on, ends_on) values ($1, $2::date, $3::date)",
		ids[2], today.AddDate(0, 0, -1).Format(time.DateOnly), today.AddDate(0, 0, 1).Format(time.DateOnly)); err != nil {
		t.Fatal(err)
	}

	_, member := getRaw(t, srv, "/api/sessions/"+s, owner)
	var mine standupStateBody
	if err := json.Unmarshal(member, &mine); err != nil || !slices.Equal(mine.State.Away, []string{ids[2]}) {
		t.Fatalf("member's copy: away = %v (%v), want [%s]", mine.State.Away, err, ids[2])
	}

	_, minted := mintLink(t, srv, s, owner)
	token, _ := minted["token"].(string)
	guest := redeemAs(t, srv, token, "Gus")
	status, body := getRaw(t, srv, "/api/sessions/"+s, guest)
	if status != http.StatusOK {
		t.Fatalf("guest read: %d %s", status, body)
	}
	var raw struct {
		State map[string]json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	if away, ok := raw.State["away"]; ok && string(away) != "[]" {
		t.Fatalf("guest's copy: away = %s, want [] or absent", away)
	}
	if strings.Contains(string(raw.State["away"]), ids[2]) {
		t.Fatalf("guest's copy names the away member: %s", body)
	}
}
