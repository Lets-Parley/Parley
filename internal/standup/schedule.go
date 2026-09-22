package standup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/recovery"
)

// Schedule is a space's recurring async standup: on each listed weekday, at
// OpenTime in Timezone, a new async session opens with a cutoff WindowMinutes
// later, and the previous slot's session ends.
type Schedule struct {
	// Weekdays uses time.Weekday numbering: 0 is Sunday.
	Weekdays      []int  `json:"weekdays"`
	OpenTime      string `json:"openTime"` // "HH:MM", local to Timezone
	Timezone      string `json:"timezone"` // IANA name
	WindowMinutes int    `json:"windowMinutes"`
	Enabled       bool   `json:"enabled"`
}

func (s Schedule) Validate() error {
	if len(s.Weekdays) == 0 {
		return errors.New("choose at least one weekday")
	}
	for _, d := range s.Weekdays {
		if d < 0 || d > 6 {
			return errors.New("weekdays run from 0 (sunday) to 6 (saturday)")
		}
	}
	if _, _, ok := parseClock(s.OpenTime); !ok {
		return errors.New(`openTime must be "HH:MM" on a 24-hour clock`)
	}
	if s.Timezone == "" || s.Timezone == "Local" {
		return errors.New("timezone must be an IANA name such as America/New_York")
	}
	if _, err := time.LoadLocation(s.Timezone); err != nil {
		return errors.New("timezone must be an IANA name such as America/New_York")
	}
	if s.WindowMinutes < 1 || s.WindowMinutes > 1440 {
		return errors.New("windowMinutes must be between 1 and 1440")
	}
	return nil
}

func parseClock(v string) (hour, minute int, ok bool) {
	t, err := time.Parse("15:04", v)
	if err != nil || len(v) != 5 {
		return 0, 0, false
	}
	return t.Hour(), t.Minute(), true
}

// slotAt reports the slot open at now, if any: the schedule's local date,
// and the instant it opened. Only today's local date is ever considered, so
// a slot no ticker reached opens late the same day and is skipped after that.
// An open time inside a spring-forward gap moves forward by the gap, and an
// ambiguous fall-back time resolves as time.Date resolves it.
func (s Schedule) slotAt(now time.Time, loc *time.Location) (date string, openAt time.Time, ok bool) {
	local := now.In(loc)
	openAt, ok = s.openInstant(local, loc)
	if !ok || now.Before(openAt) {
		return "", time.Time{}, false
	}
	return local.Format(time.DateOnly), openAt, true
}

// openInstant is when the slot on local's calendar date opens. ok is false
// when that weekday is not scheduled or the clock does not parse. A time that
// falls in a spring-forward gap moves forward by the gap: 02:30 becomes 03:30.
func (s Schedule) openInstant(local time.Time, loc *time.Location) (time.Time, bool) {
	onDay := false
	for _, d := range s.Weekdays {
		if time.Weekday(d) == local.Weekday() {
			onDay = true
		}
	}
	h, m, valid := parseClock(s.OpenTime)
	if !onDay || !valid {
		return time.Time{}, false
	}
	openAt := time.Date(local.Year(), local.Month(), local.Day(), h, m, 0, 0, loc)
	if openAt.Hour() != h || openAt.Minute() != m {
		// time.Date does not promise which side of a gap it lands on. Read it
		// with the offset in force before the gap, which puts it just after.
		_, before := openAt.Add(-12 * time.Hour).Zone()
		openAt = time.Date(local.Year(), local.Month(), local.Day(), h, m, 0, 0, time.FixedZone("", before)).In(loc)
	}
	return openAt, true
}

// feedHorizon is how far ahead a personal calendar lists scheduled slots.
const feedHorizon = 14 * 24 * time.Hour

type feedWindow struct {
	Date        string // YYYYMMDD in the schedule's zone
	Open, Close time.Time
}

// upcoming returns slots whose window is still open and whose open time is
// within feedHorizon. It uses openInstant, so a spring-forward gap is the
// same instant slotAt would have opened.
func (s Schedule) upcoming(now time.Time) ([]feedWindow, error) {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return nil, err
	}
	until := now.Add(feedHorizon)
	// Walk civil dates, not instants. A window is at most a day long, so one
	// that is still open started no earlier than yesterday in this zone; the
	// walk ends on until's local date, whatever hour until falls at. Each day
	// is built at noon, which exists in every zone: local midnight does not
	// on a day whose clocks jump at 00:00 (Santiago, Havana), and time.Date
	// would move it onto the neighbouring date. Candidates are still filtered
	// below by their real open instant, not by this anchor.
	ny, nm, nd := now.In(loc).Date()
	ly, lm, ld := until.In(loc).Date()
	var out []feedWindow
	for i := -1; ; i++ {
		d := time.Date(ny, nm, nd+i, 12, 0, 0, 0, loc)
		if openAt, ok := s.openInstant(d, loc); ok {
			closeAt := openAt.Add(time.Duration(s.WindowMinutes) * time.Minute)
			if closeAt.After(now) && !openAt.After(until) {
				out = append(out, feedWindow{Date: openAt.In(loc).Format("20060102"), Open: openAt, Close: closeAt})
			}
		}
		if dy, dm, dd := d.Date(); dy == ly && dm == lm && dd == ld {
			break
		}
	}
	return out, nil
}

type Schedules struct {
	Pool *pgxpool.Pool
}

// Get returns the space's schedule, or ok false when it has none.
func (st *Schedules) Get(ctx context.Context, spaceID string) (Schedule, bool, error) {
	var s Schedule
	var days []int16
	err := st.Pool.QueryRow(ctx,
		"select weekdays, to_char(open_time, 'HH24:MI'), timezone, window_minutes, enabled "+
			"from standup_schedules where space_id = $1", spaceID,
	).Scan(&days, &s.OpenTime, &s.Timezone, &s.WindowMinutes, &s.Enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, false, nil
	}
	if err != nil {
		return Schedule{}, false, fmt.Errorf("reading standup schedule: %w", err)
	}
	for _, d := range days {
		s.Weekdays = append(s.Weekdays, int(d))
	}
	return s, true, nil
}

// Put creates or replaces the space's schedule. It touches no session: a slot
// already open keeps the config it opened with.
func (st *Schedules) Put(ctx context.Context, spaceID, userID string, s Schedule) error {
	days := make([]int16, len(s.Weekdays))
	for i, d := range s.Weekdays {
		days[i] = int16(d)
	}
	_, err := st.Pool.Exec(ctx, `
		insert into standup_schedules (space_id, weekdays, open_time, timezone, window_minutes, enabled, updated_by)
		values ($1, $2, $3::time, $4, $5, $6, $7)
		on conflict (space_id) do update set
			weekdays = excluded.weekdays, open_time = excluded.open_time,
			timezone = excluded.timezone, window_minutes = excluded.window_minutes,
			enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
		spaceID, days, s.OpenTime, s.Timezone, s.WindowMinutes, s.Enabled, userID)
	if err != nil {
		return fmt.Errorf("saving standup schedule: %w", err)
	}
	return nil
}

type dueSchedule struct {
	id, spaceID, facilitator string
	Schedule
}

// Tick opens every enabled schedule's current slot that has not opened yet,
// ending the schedule's earlier slots as it does, and returns the ids of the
// sessions it changed so the caller can broadcast them. It is safe to run on
// every replica at once: the slot's primary key admits exactly one insert,
// and the losers block on it and then do nothing.
func Tick(ctx context.Context, pool *pgxpool.Pool, now time.Time, sessionLimit int) ([]string, error) {
	rows, err := pool.Query(ctx,
		"select id::text, space_id::text, updated_by::text, weekdays, to_char(open_time, 'HH24:MI'), timezone, window_minutes "+
			"from standup_schedules where enabled")
	if err != nil {
		return nil, fmt.Errorf("listing standup schedules: %w", err)
	}
	var due []dueSchedule
	for rows.Next() {
		var d dueSchedule
		var days []int16
		// updated_by is nullable: deleting the saver clears it and leaves the
		// schedule, and a null here falls through to a current owner at open.
		var updatedBy *string
		if err := rows.Scan(&d.id, &d.spaceID, &updatedBy, &days, &d.OpenTime, &d.Timezone, &d.WindowMinutes); err != nil {
			rows.Close()
			return nil, fmt.Errorf("reading standup schedule: %w", err)
		}
		if updatedBy != nil {
			d.facilitator = *updatedBy
		}
		for _, day := range days {
			d.Weekdays = append(d.Weekdays, int(day))
		}
		due = append(due, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing standup schedules: %w", err)
	}

	var touched []string
	for _, d := range due {
		loc, err := time.LoadLocation(d.Timezone)
		if err != nil {
			slog.Error("standup schedule has an unusable timezone", "schedule", d.id, "timezone", d.Timezone, "error", err)
			continue
		}
		date, openAt, ok := d.slotAt(now, loc)
		if !ok {
			continue
		}
		ids, err := openSlot(ctx, pool, d, date, openAt, sessionLimit)
		if err != nil {
			return touched, err
		}
		touched = append(touched, ids...)
	}
	return touched, nil
}

func openSlot(ctx context.Context, pool *pgxpool.Pool, d dueSchedule, date string, openAt time.Time, limit int) ([]string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		"insert into standup_schedule_slots (schedule_id, slot_date) values ($1, $2::date) on conflict do nothing",
		d.id, date)
	if err != nil {
		return nil, fmt.Errorf("claiming standup slot: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}

	var touched []string
	rows, err := tx.Query(ctx, `
		update sessions set ended_at = now(), version = version + 1
		where id in (select session_id from standup_schedule_slots where schedule_id = $1 and slot_date < $2::date)
		  and ended_at is null
		returning id::text`, d.id, date)
	if err != nil {
		return nil, fmt.Errorf("ending previous standup slot: %w", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		touched = append(touched, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ending previous standup slot: %w", err)
	}

	// The same space lock and quota store.Sessions.Create applies, so a
	// schedule cannot grow a space past the limit a person is held to.
	if _, err := tx.Exec(ctx, "select id from spaces where id = $1 for update", d.spaceID); err != nil {
		return nil, err
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from sessions where space_id = $1", d.spaceID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= limit {
		// Roll the whole transaction back. Committing here would end the
		// running standup and keep the slot row, so the day could never open
		// once a session was freed. A later tick retries.
		slog.Warn("standup schedule skipped a slot: the space is at its session limit", "schedule", d.id, "slot", date)
		return nil, nil
	}

	// updated_by facilitates only while they are still an owner of this space.
	// Otherwise the most recently active current owner does, the same ordering
	// migration 0015 uses to promote a last owner. Nobody left: roll back, so
	// the running standup stays open and a later tick can retry.
	facilitator, err := slotFacilitator(ctx, tx, d.spaceID, d.facilitator)
	if err != nil {
		return nil, err
	}
	if facilitator == "" {
		slog.Warn("standup schedule skipped a slot: the space has no owner to facilitate it", "schedule", d.id, "slot", date)
		return nil, nil
	}

	closes := openAt.Add(time.Duration(d.WindowMinutes) * time.Minute).UTC()
	cfg, err := json.Marshal(Config{Mode: "async", ClosesAt: &closes})
	if err != nil {
		return nil, err
	}
	var id string
	if err := tx.QueryRow(ctx,
		"insert into sessions (space_id, kind, title, config, facilitator_id) values ($1, 'standup', $2, $3, $4) returning id::text",
		d.spaceID, "Standup "+date, cfg, facilitator).Scan(&id); err != nil {
		return nil, fmt.Errorf("opening standup slot: %w", err)
	}
	if _, err := tx.Exec(ctx,
		"update standup_schedule_slots set session_id = $3 where schedule_id = $1 and slot_date = $2::date",
		d.id, date, id); err != nil {
		return nil, fmt.Errorf("recording standup slot: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return append(touched, id), nil
}

// slotFacilitator returns who should facilitate the slot being opened.
// updatedBy is used only when that user is still an owner. Otherwise the
// current owner with the latest last_seen_at wins, and user_id breaks a tie
// the way migration 0015 does. An empty string means the space has no owner.
func slotFacilitator(ctx context.Context, tx pgx.Tx, spaceID, updatedBy string) (string, error) {
	if updatedBy != "" {
		var stillOwner bool
		if err := tx.QueryRow(ctx,
			`select exists (
				select 1 from members
				where space_id = $1 and user_id = $2 and role = 'owner')`,
			spaceID, updatedBy,
		).Scan(&stillOwner); err != nil {
			return "", fmt.Errorf("checking the standup facilitator: %w", err)
		}
		if stillOwner {
			return updatedBy, nil
		}
	}
	var id string
	err := tx.QueryRow(ctx, `
		select user_id::text from members
		where space_id = $1 and role = 'owner'
		order by last_seen_at desc, user_id
		limit 1`, spaceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("choosing a standup facilitator: %w", err)
	}
	return id, nil
}

// RunScheduler ticks every interval until ctx is done, handing each changed
// session to broadcast. The caller owns the goroutine and waits for it on
// shutdown, before the pool closes.
func RunScheduler(ctx context.Context, pool *pgxpool.Pool, every time.Duration, sessionLimit int, broadcast func(context.Context, string)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		schedulerPass(ctx, pool, sessionLimit, broadcast)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func schedulerPass(ctx context.Context, pool *pgxpool.Pool, sessionLimit int, broadcast func(context.Context, string)) {
	defer recovery.Handle("standup scheduler")
	ids, err := Tick(ctx, pool, time.Now(), sessionLimit)
	if err != nil && ctx.Err() == nil {
		slog.Error("standup scheduler pass failed", "error", err)
	}
	for _, id := range ids {
		broadcast(ctx, id)
	}
}
