package standup

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// Go loads these and Postgres does not, so a schedule saved with one opens in
// Go and then fails every query that asks Postgres for the time there.
func TestScheduleValidateRefusesZonesPostgresCannotRead(t *testing.T) {
	for _, zone := range []string{"localtime", "posix/America/New_York", "right/UTC", "right/America/New_York"} {
		s := Schedule{Weekdays: []int{1}, OpenTime: "09:00", Timezone: zone, WindowMinutes: 60}
		if err := s.Validate(); err == nil {
			t.Errorf("timezone %q validated", zone)
		}
	}
}

func TestZoneReadableAsksPostgres(t *testing.T) {
	pool := testPool(t)
	st := &Schedules{Pool: pool}
	for zone, want := range map[string]bool{
		"America/New_York":  true,
		"UTC":               true,
		"localtime":         false,
		"Mars/Olympus_Mons": false,
	} {
		got, err := st.ZoneReadable(context.Background(), zone)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("ZoneReadable(%q) = %v, want %v", zone, got, want)
		}
	}
}

// otherScheduledSpace writes a second space with its own owner and saves s
// for it, after whatever seedSchedule wrote. It returns the space id.
func otherScheduledSpace(t *testing.T, pool *pgxpool.Pool, slug string, s Schedule) string {
	t.Helper()
	ctx := context.Background()
	var spaceID, ownerID string
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ($1, $1) returning id::text", slug).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Other Owner') returning id::text").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err := (&Schedules{Pool: pool}).Put(ctx, spaceID, ownerID, s); err != nil {
		t.Fatal(err)
	}
	return spaceID
}

// A schedule saved before its zone was checked against Postgres must not
// break its own room, its own trend, or any other space's schedule.
func TestAScheduleInAZonePostgresCannotReadStopsNothing(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	every := []int{0, 1, 2, 3, 4, 5, 6}
	// Put does not validate: this is the row an older binary could have saved.
	bad, badOwner := seedSchedule(t, pool, Schedule{Weekdays: every, OpenTime: "00:00", Timezone: "localtime", WindowMinutes: 60, Enabled: true})
	var member string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Member') returning id::text").Scan(&member); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", bad, member); err != nil {
		t.Fatal(err)
	}
	healthy := otherScheduledSpace(t, pool, "healthy-team", Schedule{Weekdays: every, OpenTime: "00:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})

	day1 := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	if _, err := Tick(ctx, pool, day1, 500); err != nil {
		t.Fatalf("day 1 tick: %v", err)
	}
	badSlots := scheduledSessions(t, pool, bad)
	if len(badSlots) != 1 {
		t.Fatalf("bad schedule opened %d slots on day 1, want 1", len(badSlots))
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, badSlots[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildState(ctx, pool, sess); err != nil {
		t.Fatalf("the bad schedule's open room: %v", err)
	}

	// An away range on the day that is about to end makes the freeze read
	// the zone's midnight, which is where the tick used to stop.
	if _, err := pool.Exec(ctx,
		"insert into standup_away (user_id, starts_on, ends_on, created_at) values ($1, $2::date, $2::date, '2026-01-01T00:00:00Z')",
		member, day1.In(mustLoc(t, "localtime")).Format(time.DateOnly)); err != nil {
		t.Fatal(err)
	}
	if _, err := Tick(ctx, pool, day1.AddDate(0, 0, 1), 500); err != nil {
		t.Fatalf("day 2 tick: %v", err)
	}
	if got := len(scheduledSessions(t, pool, healthy)); got != 2 {
		t.Fatalf("healthy schedule has %d slots after day 2, want 2", got)
	}
	var frozen int
	if err := pool.QueryRow(ctx, "select count(*) from standup_trend_days where space_id = $1", bad).Scan(&frozen); err != nil {
		t.Fatal(err)
	}
	if frozen != 1 {
		t.Fatalf("bad schedule's ended day froze %d rows, want 1", frozen)
	}

	badSlots = scheduledSessions(t, pool, bad)
	if len(badSlots) != 2 {
		t.Fatalf("bad schedule opened %d slots by day 2, want 2", len(badSlots))
	}
	if err := (&store.Sessions{Pool: pool}).SetEnded(ctx, badSlots[1].ID, badOwner, true); err != nil {
		t.Fatalf("ending the bad schedule's room: %v", err)
	}
	if _, err := Trend(ctx, pool, bad, day1.AddDate(0, 0, 10)); err != nil {
		t.Fatalf("the bad schedule's trend: %v", err)
	}
}

// One schedule failing to open must not keep the next one shut. The failing
// schedule is saved first, so a pass that stops at it never reaches the other.
func TestOneFailingScheduleDoesNotStopTheRest(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	every := []int{0, 1, 2, 3, 4, 5, 6}
	broken, _ := seedSchedule(t, pool, Schedule{Weekdays: every, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	healthy := otherScheduledSpace(t, pool, "healthy-team", Schedule{Weekdays: every, OpenTime: "09:00", Timezone: "UTC", WindowMinutes: 60, Enabled: true})
	if _, err := pool.Exec(ctx, `
		create function refuse_broken_space() returns trigger language plpgsql as $$
		begin
			if new.space_id = '`+broken+`'::uuid then raise exception 'refused for the test'; end if;
			return new;
		end $$;
		create trigger refuse_broken_space before insert on sessions
		for each row execute function refuse_broken_space()`); err != nil {
		t.Fatal(err)
	}

	_, err := Tick(ctx, pool, time.Date(2026, 10, 1, 9, 5, 0, 0, time.UTC), 500)
	if err == nil {
		t.Fatal("a pass with a failing schedule reported no error")
	}
	if got := len(scheduledSessions(t, pool, healthy)); got != 1 {
		t.Fatalf("healthy schedule opened %d slots, want 1", got)
	}
	if got := len(scheduledSessions(t, pool, broken)); got != 0 {
		t.Fatalf("broken schedule opened %d slots, want 0", got)
	}
}
