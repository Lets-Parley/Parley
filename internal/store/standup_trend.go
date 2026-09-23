package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// beginner is a pool, which Begin gives a transaction, or a transaction,
// which Begin gives a savepoint. Either way a failed attempt rolls back
// without aborting whatever the caller holds.
type beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// IsUnknownTimeZone reports whether err is Postgres refusing a time zone
// name. A schedule saved before its zone was checked against Postgres can
// hold a name Go reads and Postgres does not, such as "localtime".
func IsUnknownTimeZone(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22023" && strings.Contains(pgErr.Message, "time zone")
}

// freezeTrendDays writes one standup_trend_days row for each scheduled async
// standup the filter selects, counting its day once:
//
//   - eligible is a member of the space who is not a spectator (members.spectator
//     at the moment of freezing, the flag the room's spectator toggle sets and
//     the async digest reads), is not a link guest (users.link_id is null) and
//     is not away on the slot's date by a range created before the day was over;
//   - answered is those eligible people with a non-blank entry in the session.
//
// The day is over at the earlier of the session's end and local midnight after
// the slot date in the schedule's timezone. A standup no schedule opened has no
// slot row and is never frozen. on conflict do nothing makes the first freeze
// the only one: a reopen, a late answer or a membership change never rewrites
// a day. %[1]s is the filter and %[2]s the zone, sc.timezone or 'UTC'; s is
// the session, de.day_end the local midnight.
const freezeTrendDays = `
	insert into standup_trend_days (session_id, space_id, day, eligible, answered)
	select s.id, s.space_id, sl.slot_date,
	       count(m.user_id),
	       count(m.user_id) filter (where exists (
	           select 1 from standup_entries e
	           where e.session_id = s.id and e.user_id = m.user_id
	             and (btrim(e.yesterday, E' \t\r\n') <> '' or btrim(e.today, E' \t\r\n') <> ''
	                  or btrim(e.blockers, E' \t\r\n') <> '')))
	from sessions s
	join standup_schedule_slots sl on sl.session_id = s.id
	join standup_schedules sc on sc.id = sl.schedule_id
	cross join lateral (
	    select ((sl.slot_date + 1)::timestamp at time zone %[2]s) as day_end) de
	left join members m on m.space_id = s.space_id and not m.spectator
	    and exists (select 1 from users u where u.id = m.user_id and u.link_id is null)
	    and not exists (
	        select 1 from standup_away a
	        where a.user_id = m.user_id
	          and sl.slot_date between a.starts_on and a.ends_on
	          and a.created_at < least(coalesce(s.ended_at, de.day_end), de.day_end))
	where s.kind = 'standup' and s.config->>'mode' = 'async'
	  and not exists (select 1 from standup_trend_days t where t.session_id = s.id)
	  and %[1]s
	group by s.id, s.space_id, sl.slot_date
	on conflict (session_id) do nothing`

// freeze runs freezeTrendDays with filter. A zone Postgres cannot read is
// counted in UTC instead: every caller's filter reaches one schedule's slots,
// so the fallback moves only that schedule's day boundary, by at most a day's
// offset, and never fails the tick, the close or the trend that asked.
func freeze(ctx context.Context, b beginner, filter string, args ...any) error {
	err := freezeIn(ctx, b, "sc.timezone", filter, args...)
	if IsUnknownTimeZone(err) {
		slog.Warn("a standup schedule's timezone is not one Postgres knows; counting its trend days in UTC", "error", err)
		err = freezeIn(ctx, b, "'UTC'", filter, args...)
	}
	return err
}

func freezeIn(ctx context.Context, b beginner, zone, filter string, args ...any) error {
	tx, err := b.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, fmt.Sprintf(freezeTrendDays, filter, zone), args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// FreezeEndedTrendDays freezes the trend day of each of these sessions that
// has ended and a schedule opened. Call it in the transaction that ends them,
// so no standup is ever ended without its day counted. Ids of other sessions
// are ignored.
func FreezeEndedTrendDays(ctx context.Context, tx pgx.Tx, sessionIDs []string) error {
	if len(sessionIDs) == 0 {
		return nil
	}
	if err := freeze(ctx, tx, "s.id = any($1::uuid[]) and s.ended_at is not null", sessionIDs); err != nil {
		return fmt.Errorf("freezing standup trend days: %w", err)
	}
	return nil
}

// FreezePastTrendDays freezes, once, every scheduled standup in the space
// whose day is over by now and that has no frozen day yet: one ended by a
// path that does not freeze, or one still open after its local date has
// passed. The trend calls it before reading, so it never reads a past day
// from live membership.
func FreezePastTrendDays(ctx context.Context, b beginner, spaceID string, now time.Time) error {
	if err := freeze(ctx, b, "s.space_id = $1 and (s.ended_at is not null or de.day_end <= $2)", spaceID, now); err != nil {
		return fmt.Errorf("freezing past standup trend days: %w", err)
	}
	return nil
}
