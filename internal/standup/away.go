package standup

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The limits on a self-set away range. The length also stands as a check
// constraint in 0042_standup_away.sql. A range set on a past day is kept, and
// shown back to its owner, but changes no trend day: a day counts only the
// ranges created before it was over, and is frozen once it is.
const (
	MaxAwayDays       = 90
	AwayLookbackDays  = 30
	AwayLookaheadDays = 365
	// MaxAwayRanges bounds how many ranges one person keeps at once.
	MaxAwayRanges = 20
)

// ErrTooManyAway is returned by AwayStore.Add when the person already holds
// MaxAwayRanges ranges.
var ErrTooManyAway = errors.New("too many away ranges")

// AwayRange is one inclusive run of calendar dates, as YYYY-MM-DD.
type AwayRange struct {
	ID       string `json:"id"`
	StartsOn string `json:"startsOn"`
	EndsOn   string `json:"endsOn"`
}

// ValidateAway parses and checks a range against today's UTC date: the end
// is not before the start, it spans at most MaxAwayDays days, it starts no
// more than AwayLookbackDays ago and no more than AwayLookaheadDays ahead.
// The returned errors are written for the person setting the range.
func ValidateAway(startsOn, endsOn string, today time.Time) (time.Time, time.Time, error) {
	start, err1 := time.Parse(time.DateOnly, startsOn)
	end, err2 := time.Parse(time.DateOnly, endsOn)
	if err1 != nil || err2 != nil {
		return time.Time{}, time.Time{}, errors.New("startsOn and endsOn must be dates written YYYY-MM-DD")
	}
	y, m, d := today.UTC().Date()
	day := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	switch {
	case end.Before(start):
		return time.Time{}, time.Time{}, errors.New("the last away day cannot be before the first")
	case end.Sub(start) >= MaxAwayDays*24*time.Hour:
		return time.Time{}, time.Time{}, errors.New("an away range can be at most 90 days long")
	case start.Before(day.AddDate(0, 0, -AwayLookbackDays)):
		return time.Time{}, time.Time{}, errors.New("an away range can start at most 30 days ago")
	case start.After(day.AddDate(0, 0, AwayLookaheadDays)):
		return time.Time{}, time.Time{}, errors.New("an away range can start at most a year ahead")
	}
	return start, end, nil
}

// AwayStore reads and writes one person's own away ranges. Every method takes
// the caller's user id and filters by it, so one person's id in another's
// request is simply not found.
type AwayStore struct{ Pool *pgxpool.Pool }

// List returns the caller's ranges, earliest first.
func (s *AwayStore) List(ctx context.Context, userID string) ([]AwayRange, error) {
	rows, err := s.Pool.Query(ctx, `
		select id::text, starts_on::text, ends_on::text from standup_away
		where user_id = $1 order by starts_on, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AwayRange{}
	for rows.Next() {
		var r AwayRange
		if err := rows.Scan(&r.ID, &r.StartsOn, &r.EndsOn); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Add stores a range already checked by ValidateAway. The cap is read in the
// same statement as the insert; two simultaneous adds may land one past it,
// which bounds nothing that matters.
func (s *AwayStore) Add(ctx context.Context, userID string, start, end time.Time) (AwayRange, error) {
	var r AwayRange
	err := s.Pool.QueryRow(ctx, `
		insert into standup_away (user_id, starts_on, ends_on)
		select $1, $2::date, $3::date
		where (select count(*) from standup_away where user_id = $1) < $4
		returning id::text, starts_on::text, ends_on::text`,
		userID, start.Format(time.DateOnly), end.Format(time.DateOnly), MaxAwayRanges,
	).Scan(&r.ID, &r.StartsOn, &r.EndsOn)
	if errors.Is(err, pgx.ErrNoRows) {
		return AwayRange{}, ErrTooManyAway
	}
	return r, err
}

// Delete removes one of the caller's ranges and reports whether it existed.
// The id is compared as text so a malformed one is "not found", not a 500.
func (s *AwayStore) Delete(ctx context.Context, userID, id string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		"delete from standup_away where user_id = $1 and id::text = lower($2)", userID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// sessionDay is the calendar date a standup session is for: its schedule
// slot's local date when a schedule opened it, otherwise the UTC date it was
// created. sessionToday is today's date in that same zone: the schedule's
// timezone, otherwise UTC. s is the sessions table alias.
const (
	sessionDay = `coalesce(
	(select min(sl.slot_date) from standup_schedule_slots sl where sl.session_id = s.id),
	(s.created_at at time zone 'UTC')::date)`
	sessionToday = `coalesce(
	(select (now() at time zone sc.timezone)::date
	 from standup_schedule_slots sl join standup_schedules sc on sc.id = sl.schedule_id
	 where sl.session_id = s.id limit 1),
	(now() at time zone 'UTC')::date)`
)

// awayMembers is the ids of this session's space members who are away on the
// session's day, served only while that day is today. A facilitator can reopen
// a standup from any earlier day, and the list must not follow it there: it
// is a live fact about today's room, never a record of who was away when.
// Only members, never link guests: a guest has no account to set a range on.
// $1 is the session.
const awayMembers = `
	select m.user_id::text
	from sessions s
	join members m on m.space_id = s.space_id
	join users u on u.id = m.user_id and u.link_id is null
	where s.id = $1 and ` + sessionDay + ` = ` + sessionToday + `
	  and exists (
		select 1 from standup_away a
		where a.user_id = m.user_id and ` + sessionDay + ` between a.starts_on and a.ends_on)
	order by m.user_id`
