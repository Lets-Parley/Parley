package standup

import (
	"context"
	"testing"
	"time"
)

// The next slot opening ends the previous one and counts its day in the same
// transaction. Eligible is a non-spectator member not away that day by a
// range set before the day was over; answered is those of them who posted.
func TestNextSlotFreezesTheDayItEnds(t *testing.T) {
	pool := testPool(t)
	spaceID, ownerID := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "America/New_York", WindowMinutes: 60, Enabled: true})
	ctx := context.Background()

	member := func(name string) string {
		var id string
		if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id::text", name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", spaceID, id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	plain, spectator, away, lateAway := member("Plain"), member("Spectator"), member("Away"), member("Late Away")
	if _, err := pool.Exec(ctx, "update members set spectator = true where user_id = $1", spectator); err != nil {
		t.Fatal(err)
	}
	// Away's range was set in January; Late Away's the day after the slot's
	// day was over, so it does not count for that day.
	for _, r := range []struct{ user, created string }{{away, "2026-01-01T00:00:00Z"}, {lateAway, "2026-09-24T00:00:00Z"}} {
		if _, err := pool.Exec(ctx,
			"insert into standup_away (user_id, starts_on, ends_on, created_at) values ($1, '2026-09-22', '2026-09-22', $2)",
			r.user, r.created); err != nil {
			t.Fatal(err)
		}
	}
	_ = plain

	// 09:05 in New York on Tuesday 22 September.
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 13, 5, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	slot := scheduledSessions(t, pool, spaceID)[0].ID
	for i, u := range []string{ownerID, spectator} {
		if _, err := pool.Exec(ctx,
			"insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'shipped', $3)", slot, u, i+1); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, "select count(*) from standup_trend_days").Scan(&n); err != nil || n != 0 {
		t.Fatalf("frozen before the day ended: %d rows (%v)", n, err)
	}

	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 13, 1, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	var day string
	var eligible, answered int
	if err := pool.QueryRow(ctx,
		"select day::text, eligible, answered from standup_trend_days where session_id = $1", slot,
	).Scan(&day, &eligible, &answered); err != nil {
		t.Fatalf("no frozen day for the ended slot: %v", err)
	}
	// Eligible: Owner, Plain and Late Away. Answered: Owner only — the
	// spectator's entry is not an answer.
	if day != "2026-09-22" || eligible != 3 || answered != 1 {
		t.Fatalf("frozen day = %s eligible=%d answered=%d, want 2026-09-22, 3 and 1", day, eligible, answered)
	}
}

// Weeks bucket by the slot's local date. A Sunday-evening slot in Los Angeles
// opens on Monday in UTC, and still counts for the week it is local to.
func TestTrendBucketsBySlotLocalDate(t *testing.T) {
	pool := testPool(t)
	spaceID, ownerID := seedSchedule(t, pool, Schedule{Weekdays: []int{0}, OpenTime: "20:00", Timezone: "America/Los_Angeles", WindowMinutes: 60, Enabled: true})
	ctx := context.Background()
	ids := []string{ownerID}
	for _, name := range []string{"Ada", "Bea", "Cy"} {
		var id string
		if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id::text", name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", spaceID, id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	// 20:05 on Sunday 20 September in Los Angeles is 03:05 on Monday in UTC.
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 21, 3, 5, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	slot := scheduledSessions(t, pool, spaceID)[0].ID
	for i, u := range ids[:3] {
		if _, err := pool.Exec(ctx,
			"insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'shipped', $3)", slot, u, i+1); err != nil {
			t.Fatal(err)
		}
	}

	// The slot is still open, but its local day is over, so the trend
	// freezes it before reading: 3 of 4 answered, 0.75, which is 0.8 to one
	// decimal, in the week of Monday 14 September.
	weeks, err := Trend(ctx, pool, spaceID, time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	last := weeks[len(weeks)-1]
	if last.WeekStart != "2026-09-14" || last.Ratio == nil || *last.Ratio != 0.8 {
		t.Fatalf("last week = %+v, want 2026-09-14 at 0.8", last)
	}
}
