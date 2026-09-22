package standup

import (
	"context"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// TrendWeeks is how many completed weeks the team trend reports. Fixed,
	// and not a parameter: a window the caller could move would let two
	// overlapping answers be differenced into one small one.
	TrendWeeks = 12
	// TrendMinEligible is the smallest number of eligible people a standup
	// day needs before it counts toward the trend at all.
	TrendMinEligible = 4
)

// TrendWeek is one week of the team trend. It is a ratio for the team and
// nothing else: no counts, no names, no ids. A week with no standup day that
// had TrendMinEligible eligible people is Suppressed and carries no Ratio.
type TrendWeek struct {
	WeekStart  string   `json:"weekStart"`
	Ratio      *float64 `json:"ratio,omitempty"`
	Suppressed bool     `json:"suppressed,omitempty"`
}

// trendQuery sums, per week, how many eligible people answered and how many
// were eligible, over the space's async standups. Eligible on a standup's day
// is a space member who is not a link guest and not away that day. A day on
// which fewer than TrendMinEligible were eligible is dropped before it is
// summed, so no single thin day can be read out of a week that is shown.
// $1 space, $2 first week start, $3 the running week's start, $4 minimum.
const trendQuery = `
	with days as (
		select s.id, ` + sessionDay + ` as day
		from sessions s
		where s.space_id = $1 and s.kind = 'standup' and s.config->>'mode' = 'async'
	), per_day as (
		select d.day,
		       count(*) as eligible,
		       count(*) filter (where exists (
		           select 1 from standup_entries e
		           where e.session_id = d.id and e.user_id = m.user_id
		             and (btrim(e.yesterday, E' \t\r\n') <> '' or btrim(e.today, E' \t\r\n') <> ''
		                  or btrim(e.blockers, E' \t\r\n') <> ''))) as answered
		from days d
		join members m on m.space_id = $1
		join users u on u.id = m.user_id and u.link_id is null
		where d.day >= $2::date and d.day < $3::date
		  and not exists (
		      select 1 from standup_away a
		      where a.user_id = m.user_id and d.day between a.starts_on and a.ends_on)
		group by d.id, d.day
	)
	select date_trunc('week', day::timestamp)::date::text, sum(answered)::float8, sum(eligible)::float8
	from per_day
	where eligible >= $4
	group by 1`

// Trend reports the space's last TrendWeeks completed weeks, Monday first,
// oldest first. The running week is never included: reported day by day, it
// would let each new day's answers be read off the change.
func Trend(ctx context.Context, pool *pgxpool.Pool, spaceID string, now time.Time) ([]TrendWeek, error) {
	y, m, d := now.UTC().Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	current := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	first := current.AddDate(0, 0, -7*TrendWeeks)

	rows, err := pool.Query(ctx, trendQuery, spaceID,
		first.Format(time.DateOnly), current.Format(time.DateOnly), TrendMinEligible)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ratios := map[string]float64{}
	for rows.Next() {
		var week string
		var answered, eligible float64
		if err := rows.Scan(&week, &answered, &eligible); err != nil {
			return nil, err
		}
		ratios[week] = math.Round(answered/eligible*100) / 100
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]TrendWeek, 0, TrendWeeks)
	for i := 0; i < TrendWeeks; i++ {
		w := TrendWeek{WeekStart: first.AddDate(0, 0, 7*i).Format(time.DateOnly)}
		if r, ok := ratios[w.WeekStart]; ok {
			w.Ratio = &r
		} else {
			w.Suppressed = true
		}
		out = append(out, w)
	}
	return out, nil
}
