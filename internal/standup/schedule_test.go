package standup

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// TestUpcomingIncludesAMorningSlotOnTheLastDay picks now so that
// until = now + feedHorizon (14 days) lands at 08:00 UTC on a Tuesday, and
// gives the schedule a 07:00 UTC Tuesday open time. That slot's open instant,
// hand-computed as 2026-10-06T07:00:00Z, is before until and must be listed.
// upcoming used to anchor its calendar-day walk at noon and stop as soon as
// that noon passed until, which drops this exact slot: noon on the last day
// (2026-10-06T12:00:00Z) is after until (08:00Z), so the day was never
// visited even though the slot's real open instant is still in the window.
func TestUpcomingIncludesAMorningSlotOnTheLastDay(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC) // Tuesday
	s := Schedule{
		Weekdays:      []int{2}, // Tuesday
		OpenTime:      "07:00",
		Timezone:      "UTC",
		WindowMinutes: 60,
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("schedule did not validate: %v", err)
	}

	windows, err := s.upcoming(now)
	if err != nil {
		t.Fatalf("upcoming: %v", err)
	}

	wantOpen := time.Date(2026, 10, 6, 7, 0, 0, 0, time.UTC)
	wantClose := time.Date(2026, 10, 6, 8, 0, 0, 0, time.UTC)
	for _, w := range windows {
		if w.Date == "20261006" {
			if !w.Open.Equal(wantOpen) || !w.Close.Equal(wantClose) {
				t.Fatalf("last-day slot = {%v %v}, want {%v %v}", w.Open, w.Close, wantOpen, wantClose)
			}
			return
		}
	}
	t.Fatalf("last-day slot 20261006 missing from upcoming windows: %+v", windows)
}

// TestUpcomingVisitsEachCivilDateOnce walks the horizon across DST
// transitions. In Santiago (2026-09-06) and Havana (2026-03-08) the clocks
// jump from 00:00 straight to 01:00, so local midnight does not exist on the
// transition day; a walk anchored at midnight and stepped with AddDate
// drifts to 23:00 the previous day, visits that day twice and drops the last
// date. Every expected date and UTC instant below is worked out by hand from
// the zone's offsets, never from upcoming itself.
func TestUpcomingVisitsEachCivilDateOnce(t *testing.T) {
	type slot struct {
		date string
		open time.Time
	}
	utc := func(y int, m time.Month, d, h int) time.Time { return time.Date(y, m, d, h, 0, 0, 0, time.UTC) }
	// 2026-03-02..07 at 09:00 -05:00 (14:00Z), 2026-03-08..15 at 09:00 -04:00
	// (13:00Z). Havana and New York share both offsets and the transition
	// date; they differ only in the hour the clocks jump.
	marchDaily := func() []slot {
		var out []slot
		for d := 2; d <= 15; d++ {
			h := 14
			if d >= 8 {
				h = 13
			}
			out = append(out, slot{date: fmt.Sprintf("202603%02d", d), open: utc(2026, 3, d, h)})
		}
		return out
	}
	everyDay := []int{0, 1, 2, 3, 4, 5, 6}
	cases := []struct {
		name   string
		s      Schedule
		now    time.Time
		window time.Duration
		want   []slot
	}{
		{
			// now is Tuesday 2026-09-01 10:00 -04 (14:00Z); until is
			// 2026-09-15 14:00Z, 11:00 -03. That day's 09:00 slot is 12:00Z.
			// The 2026-09-01 slot closed at 10:00 -04, exactly now.
			name:   "santiago tuesday across a midnight gap keeps the last day",
			s:      Schedule{Weekdays: []int{2}, OpenTime: "09:00", Timezone: "America/Santiago", WindowMinutes: 60},
			now:    utc(2026, 9, 1, 14),
			window: time.Hour,
			want: []slot{
				{"20260908", utc(2026, 9, 8, 12)},
				{"20260915", utc(2026, 9, 15, 12)},
			},
		},
		{
			// now is Friday 2026-09-04 12:00 -04 (16:00Z); until is
			// 2026-09-18 16:00Z. Saturday 2026-09-05 is the day before the
			// gap: 09:00 -04 is 13:00Z. 2026-09-12 09:00 -03 is 12:00Z.
			name:   "santiago saturday before a midnight gap is listed once",
			s:      Schedule{Weekdays: []int{6}, OpenTime: "09:00", Timezone: "America/Santiago", WindowMinutes: 60},
			now:    utc(2026, 9, 4, 16),
			window: time.Hour,
			want: []slot{
				{"20260905", utc(2026, 9, 5, 13)},
				{"20260912", utc(2026, 9, 12, 12)},
			},
		},
		{
			// now is 2026-03-01 10:00 -05 (15:00Z); until is 2026-03-15
			// 15:00Z, 11:00 -04. Havana jumps 00:00 -> 01:00 on 2026-03-08.
			// The 2026-03-01 slot closed at 10:00 -05, exactly now.
			name:   "havana daily across its march 2026 midnight gap",
			s:      Schedule{Weekdays: everyDay, OpenTime: "09:00", Timezone: "America/Havana", WindowMinutes: 60},
			now:    utc(2026, 3, 1, 15),
			window: time.Hour,
			want:   marchDaily(),
		},
		{
			// The same walk where the gap is 02:00 -> 03:00, away from
			// midnight: New York on 2026-03-08.
			name:   "new york daily across a 02:00 spring forward",
			s:      Schedule{Weekdays: everyDay, OpenTime: "09:00", Timezone: "America/New_York", WindowMinutes: 60},
			now:    utc(2026, 3, 1, 15),
			window: time.Hour,
			want:   marchDaily(),
		},
		{
			// until is 2026-10-06 08:00Z; the Tuesday 07:00Z slot that day
			// is before it. 2026-09-22's slot closed at 08:00Z, exactly now.
			name:   "utc morning slot on the last day",
			s:      Schedule{Weekdays: []int{2}, OpenTime: "07:00", Timezone: "UTC", WindowMinutes: 60},
			now:    utc(2026, 9, 22, 8),
			window: time.Hour,
			want: []slot{
				{"20260929", utc(2026, 9, 29, 7)},
				{"20261006", utc(2026, 10, 6, 7)},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.s.Validate(); err != nil {
				t.Fatalf("schedule did not validate: %v", err)
			}
			got, err := tc.s.upcoming(tc.now)
			if err != nil {
				t.Fatalf("upcoming: %v", err)
			}
			seen := map[string]int{}
			for _, w := range got {
				seen[w.Date]++
			}
			for d, n := range seen {
				if n > 1 {
					t.Errorf("date %s listed %d times; each becomes a VEVENT with the same UID", d, n)
				}
			}
			var dates []string
			for _, w := range got {
				dates = append(dates, w.Date)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d windows %v, want %d", len(got), dates, len(tc.want))
			}
			for i, w := range tc.want {
				g := got[i]
				if g.Date != w.date || !g.Open.Equal(w.open) || !g.Close.Equal(w.open.Add(tc.window)) {
					t.Errorf("window %d = {%s %v %v}, want {%s %v %v}", i, g.Date, g.Open.UTC(), g.Close.UTC(), w.date, w.open, w.open.Add(tc.window))
				}
			}
		})
	}
}

func TestScheduleValidateRejectsUnknownTimezone(t *testing.T) {
	s := Schedule{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "Mars/Olympus_Mons", WindowMinutes: 60}
	if err := s.Validate(); err == nil {
		t.Fatal("an unknown timezone validated")
	}
	s.Timezone = "America/New_York"
	if err := s.Validate(); err != nil {
		t.Fatalf("a valid schedule was refused: %v", err)
	}
	for _, bad := range []Schedule{
		{Weekdays: nil, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60},
		{Weekdays: []int{7}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60},
		{Weekdays: []int{1}, OpenTime: "25:00", Timezone: "UTC", WindowMinutes: 60},
		{Weekdays: []int{1}, OpenTime: "9am", Timezone: "UTC", WindowMinutes: 60},
		{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 0},
		{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 1441},
		{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "", WindowMinutes: 60},
		// "Local" is accepted by time.LoadLocation and means the server's zone,
		// which is not something a team chose.
		{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "Local", WindowMinutes: 60},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("validated %+v", bad)
		}
	}
}

// Spring forward: on 2026-03-08 New York skips 02:00-03:00 EST, so a 02:30
// open does not exist; it opens at 03:30 EDT (07:30 UTC). A 09:00 open is
// 09:00 EDT, 13:00 UTC — an hour earlier in UTC than the day before.
func TestSlotAcrossSpringForwardInNewYork(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	s := Schedule{Weekdays: []int{0, 6}, OpenTime: "09:00", Timezone: "America/New_York", WindowMinutes: 90}

	date, openAt, ok := s.slotAt(time.Date(2026, 3, 7, 14, 0, 0, 0, time.UTC), ny)
	if !ok || date != "2026-03-07" || !openAt.Equal(time.Date(2026, 3, 7, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("saturday: %v %v %v", date, openAt, ok)
	}
	date, openAt, ok = s.slotAt(time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC), ny)
	if !ok || date != "2026-03-08" || !openAt.Equal(time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC)) {
		t.Fatalf("sunday: %v %v %v", date, openAt, ok)
	}
	if _, _, ok := s.slotAt(time.Date(2026, 3, 8, 12, 59, 0, 0, time.UTC), ny); ok {
		t.Fatal("sunday slot opened before 09:00 EDT")
	}

	gap := Schedule{Weekdays: []int{0}, OpenTime: "02:30", Timezone: "America/New_York", WindowMinutes: 30}
	if _, _, ok := gap.slotAt(time.Date(2026, 3, 8, 7, 29, 0, 0, time.UTC), ny); ok {
		t.Fatal("a 02:30 open in the skipped hour opened before 03:30 EDT")
	}
	if _, openAt, ok := gap.slotAt(time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), ny); !ok || !openAt.Equal(time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC)) {
		t.Fatalf("skipped-hour open: %v %v", openAt, ok)
	}
}

// Fall back: on 2026-11-01 New York repeats 01:00-02:00. A 09:00 open is
// 09:00 EST, 14:00 UTC — an hour later in UTC than the day before — and the
// local date is still decided in New York, not UTC.
func TestSlotAcrossFallBackInNewYork(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	s := Schedule{Weekdays: []int{6, 0}, OpenTime: "09:00", Timezone: "America/New_York", WindowMinutes: 60}

	if _, openAt, ok := s.slotAt(time.Date(2026, 10, 31, 13, 0, 0, 0, time.UTC), ny); !ok || !openAt.Equal(time.Date(2026, 10, 31, 13, 0, 0, 0, time.UTC)) {
		t.Fatalf("saturday: %v %v", openAt, ok)
	}
	if _, _, ok := s.slotAt(time.Date(2026, 11, 1, 13, 30, 0, 0, time.UTC), ny); ok {
		t.Fatal("sunday slot opened at 08:30 EST")
	}
	date, openAt, ok := s.slotAt(time.Date(2026, 11, 1, 14, 0, 0, 0, time.UTC), ny)
	if !ok || date != "2026-11-01" || !openAt.Equal(time.Date(2026, 11, 1, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("sunday: %v %v %v", date, openAt, ok)
	}
	// 03:00 UTC on Monday is still Sunday 22:00 in New York: Sunday's slot,
	// not a Monday one.
	if date, _, ok := s.slotAt(time.Date(2026, 11, 2, 3, 0, 0, 0, time.UTC), ny); !ok || date != "2026-11-01" {
		t.Fatalf("late sunday evening: %v %v", date, ok)
	}
}

func TestSlotSkipsDaysNotOnTheSchedule(t *testing.T) {
	s := Schedule{Weekdays: []int{1}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60}
	// 2026-09-22 is a Tuesday.
	if _, _, ok := s.slotAt(time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC), time.UTC); ok {
		t.Fatal("a tuesday opened on a monday-only schedule")
	}
}

func seedSchedule(t *testing.T, pool *pgxpool.Pool, s Schedule) (spaceID, ownerID string) {
	t.Helper()
	sess, ids := seed(t, pool, `{}`, "Owner")
	// seed inserts a member. A scheduled slot is facilitated by an owner, so
	// the saver has to be one or every tick in this file would skip the slot.
	if _, err := pool.Exec(context.Background(),
		"update members set role = 'owner' where space_id = $1 and user_id = $2", sess.SpaceID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := (&Schedules{Pool: pool}).Put(context.Background(), sess.SpaceID, ids[0], s); err != nil {
		t.Fatal(err)
	}
	return sess.SpaceID, ids[0]
}

func scheduledSessions(t *testing.T, pool *pgxpool.Pool, spaceID string) []struct {
	ID    string
	Ended bool
	Cfg   Config
} {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		select s.id::text, s.ended_at is not null, s.config
		from standup_schedule_slots sl join sessions s on s.id = sl.session_id
		join standup_schedules sc on sc.id = sl.schedule_id
		where sc.space_id = $1 order by sl.slot_date`, spaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []struct {
		ID    string
		Ended bool
		Cfg   Config
	}
	for rows.Next() {
		var r struct {
			ID    string
			Ended bool
			Cfg   Config
		}
		var raw []byte
		if err := rows.Scan(&r.ID, &r.Ended, &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &r.Cfg); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func TestConcurrentTicksOpenExactlyOneSessionPerSlot(t *testing.T) {
	pool := testPool(t)
	spaceID, _ := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 120, Enabled: true})
	now := time.Date(2026, 9, 22, 9, 5, 0, 0, time.UTC)

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := Tick(context.Background(), pool, now, 500)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	got := scheduledSessions(t, pool, spaceID)
	if len(got) != 1 {
		t.Fatalf("got %d scheduled sessions, want 1", len(got))
	}
	var n int
	pool.QueryRow(context.Background(), "select count(*) from sessions where space_id = $1", spaceID).Scan(&n)
	if n != 2 { // the seeded one and the slot's
		t.Fatalf("space has %d sessions, want 2", n)
	}
	if got[0].Cfg.Mode != "async" || got[0].Cfg.ClosesAt == nil ||
		!got[0].Cfg.ClosesAt.Equal(time.Date(2026, 9, 22, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("slot config = %+v", got[0].Cfg)
	}
}

func TestNextSlotEndsThePreviousOne(t *testing.T) {
	pool := testPool(t)
	spaceID, _ := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	ctx := context.Background()

	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	// Past the cutoff but before tomorrow's open: closing is not ending.
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 8, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	if got := scheduledSessions(t, pool, spaceID); len(got) != 1 || got[0].Ended {
		t.Fatalf("before the next open: %+v", got)
	}
	touched, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 1, 0, 0, time.UTC), 500)
	if err != nil {
		t.Fatal(err)
	}
	got := scheduledSessions(t, pool, spaceID)
	if len(got) != 2 || !got[0].Ended || got[1].Ended {
		t.Fatalf("after the next open: %+v", got)
	}
	if len(touched) != 2 {
		t.Fatalf("tick reported %v, want the ended and the opened session", touched)
	}
}

func TestMissedSlotOpensLateThatDayAndIsSkippedAfter(t *testing.T) {
	pool := testPool(t)
	spaceID, _ := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	ctx := context.Background()

	// No ticker ran on the 22nd at all; the 23rd opens late at 20:00.
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	var dates []string
	rows, _ := pool.Query(ctx, `select sl.slot_date::text from standup_schedule_slots sl
		join standup_schedules sc on sc.id = sl.schedule_id where sc.space_id = $1 order by 1`, spaceID)
	for rows.Next() {
		var d string
		rows.Scan(&d)
		dates = append(dates, d)
	}
	rows.Close()
	if len(dates) != 1 || dates[0] != "2026-09-23" {
		t.Fatalf("slots = %v, want only the late same-day one", dates)
	}
}

func TestDisabledScheduleOpensNothingAndLeavesTheOpenSessionAlone(t *testing.T) {
	pool := testPool(t)
	s := Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true}
	spaceID, owner := seedSchedule(t, pool, s)
	ctx := context.Background()
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	s.Enabled = false
	s.WindowMinutes = 5
	if err := (&Schedules{Pool: pool}).Put(ctx, spaceID, owner, s); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	got := scheduledSessions(t, pool, spaceID)
	if len(got) != 1 || got[0].Ended || !got[0].Cfg.ClosesAt.Equal(time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("after disabling: %+v", got)
	}
}

func TestSlotRespectsTheSessionQuota(t *testing.T) {
	pool := testPool(t)
	spaceID, _ := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	if _, err := Tick(context.Background(), pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 1); err != nil {
		t.Fatal(err)
	}
	if got := scheduledSessions(t, pool, spaceID); len(got) != 0 {
		t.Fatalf("a full space got a scheduled session: %+v", got)
	}
}

// A space already at its session limit must not consume the day's slot or end
// the standup that is running. The claim and the previous session's ended_at
// live in the same transaction, so skipping has to roll both back; a later
// tick opens the slot once a session has been freed.
func TestQuotaSkipLeavesTheRunningStandupAndRetriesWhenRoomFrees(t *testing.T) {
	pool := testPool(t)
	spaceID, _ := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	ctx := context.Background()

	// The seeded session plus this slot fill a limit of 2.
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 2); err != nil {
		t.Fatal(err)
	}
	if got := scheduledSessions(t, pool, spaceID); len(got) != 1 || got[0].Ended {
		t.Fatalf("first slot: %+v", got)
	}

	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC), 2); err != nil {
		t.Fatal(err)
	}
	if got := scheduledSessions(t, pool, spaceID); len(got) != 1 || got[0].Ended {
		t.Fatalf("after a quota skip: %+v, want the running standup still open", got)
	}
	var slots int
	if err := pool.QueryRow(ctx, `
		select count(*) from standup_schedule_slots sl
		join standup_schedules sc on sc.id = sl.schedule_id
		where sc.space_id = $1 and sl.slot_date = '2026-09-23'`, spaceID).Scan(&slots); err != nil {
		t.Fatal(err)
	}
	if slots != 0 {
		t.Fatalf("quota skip left %d slot rows, want none", slots)
	}

	// Free the seeded session. Ending it would not: the quota counts every row.
	if _, err := pool.Exec(ctx, `
		delete from sessions where space_id = $1 and id not in (
			select session_id from standup_schedule_slots where session_id is not null)`, spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 5, 0, 0, time.UTC), 2); err != nil {
		t.Fatal(err)
	}
	got := scheduledSessions(t, pool, spaceID)
	if len(got) != 2 || !got[0].Ended || got[1].Ended {
		t.Fatalf("after room freed: %+v, want the next slot open and the previous one ended", got)
	}
}

func slotFacilitators(t *testing.T, pool *pgxpool.Pool, spaceID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		select s.facilitator_id::text
		from standup_schedule_slots sl
		join sessions s on s.id = sl.session_id
		join standup_schedules sc on sc.id = sl.schedule_id
		where sc.space_id = $1
		order by sl.slot_date`, spaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

// The saver facilitates a slot only while they are still an owner. After they
// leave, the next slot is facilitated by the most recently active remaining
// owner — a more recently seen non-owner is not seated, and neither is the
// person who was removed.
func TestRemovedSaverDoesNotFacilitateTheNextSlot(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	spaceID, saver := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	if _, err := pool.Exec(ctx, "update members set role = 'owner' where space_id = $1 and user_id = $2", spaceID, saver); err != nil {
		t.Fatal(err)
	}

	var activeOwner, recentMember string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Active Owner') returning id::text").Scan(&activeOwner); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Recent Member') returning id::text").Scan(&recentMember); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into members (space_id, user_id, role, last_seen_at) values
			($1, $2, 'owner', now() - interval '1 hour'),
			($1, $3, 'member', now())`, spaceID, activeOwner, recentMember); err != nil {
		t.Fatal(err)
	}

	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	if got := slotFacilitators(t, pool, spaceID); len(got) != 1 || got[0] != saver {
		t.Fatalf("first slot facilitators = %v, want the saver", got)
	}

	if err := (&store.Spaces{Pool: pool}).RemoveMember(ctx, spaceID, saver); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	got := slotFacilitators(t, pool, spaceID)
	if len(got) != 2 || got[1] != activeOwner {
		t.Fatalf("next slot facilitators = %v, want the most recently active owner %s", got, activeOwner)
	}
}

// No current owner means there is nobody who may be seated as facilitator.
// The slot is not claimed and the running standup stays open.
func TestSlotSkipsWhenTheSpaceHasNoOwner(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	spaceID, saver := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	if _, err := pool.Exec(ctx, "update members set role = 'owner' where space_id = $1 and user_id = $2", spaceID, saver); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "delete from members where space_id = $1", spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	if got := scheduledSessions(t, pool, spaceID); len(got) != 1 || got[0].Ended {
		t.Fatalf("after an ownerless skip: %+v, want the running standup still open", got)
	}
	var slots int
	if err := pool.QueryRow(ctx, `
		select count(*) from standup_schedule_slots sl
		join standup_schedules sc on sc.id = sl.schedule_id
		where sc.space_id = $1 and sl.slot_date = '2026-09-23'`, spaceID).Scan(&slots); err != nil {
		t.Fatal(err)
	}
	if slots != 0 {
		t.Fatalf("ownerless skip left %d slot rows, want none", slots)
	}
}

// Deleting the user who last saved the schedule must not take the schedule
// with them. updated_by becomes null and the next slot is facilitated by a
// current owner.
func TestDeletingTheSaverKeepsTheSchedule(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	spaceID, saver := seedSchedule(t, pool, Schedule{Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	var other string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Remaining Owner') returning id::text").Scan(&other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, other); err != nil {
		t.Fatal(err)
	}
	// sessions.facilitator_id has no ON DELETE clause, so the seeded room
	// would block the user delete for a reason this test is not about.
	if _, err := pool.Exec(ctx, "update sessions set facilitator_id = $2 where space_id = $1", spaceID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "delete from users where id = $1", saver); err != nil {
		t.Fatal(err)
	}

	var updatedBy *string
	err := pool.QueryRow(ctx, "select updated_by::text from standup_schedules where space_id = $1", spaceID).Scan(&updatedBy)
	if err != nil {
		t.Fatalf("schedule after deleting the saver: %v", err)
	}
	if updatedBy != nil {
		t.Fatalf("updated_by = %s, want null", *updatedBy)
	}

	if _, err := Tick(ctx, pool, time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC), 500); err != nil {
		t.Fatal(err)
	}
	if got := slotFacilitators(t, pool, spaceID); len(got) != 1 || got[0] != other {
		t.Fatalf("facilitators = %v, want the remaining owner %s", got, other)
	}
}
