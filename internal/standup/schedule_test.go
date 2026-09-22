package standup

import (
	"context"
	"encoding/json"
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
