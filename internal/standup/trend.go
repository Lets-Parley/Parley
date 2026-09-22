package standup

import (
	"context"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

const (
	// TrendWeeks is how many completed weeks the team trend reports. Fixed,
	// and not a parameter: a window the caller could move would let two
	// overlapping answers be differenced into one small one.
	TrendWeeks = 12
	// TrendMinEligible is the smallest number of eligible people a frozen
	// standup day needs before it counts toward the trend at all.
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

// trendQuery sums, per week, the frozen trend days of the space: one row per
// scheduled standup, counted once when its day was over (who is eligible
// is defined beside freezeTrendDays in internal/store/standup_trend.go). It never reads members,
// spectator flags or away ranges, so nothing that changes after a day is over
// can move it. A day on which fewer than TrendMinEligible were eligible is
// dropped before it is summed, so no single thin day can be read out of a
// week that is shown. Weeks bucket by the slot's local date, not by UTC.
// $1 space, $2 first week start, $3 the running week's start, $4 minimum.
const trendQuery = `
	select date_trunc('week', day::timestamp)::date::text, sum(answered)::float8, sum(eligible)::float8
	from standup_trend_days
	where space_id = $1 and day >= $2::date and day < $3::date and eligible >= $4
	group by 1`

// trendLag holds a week back until it is over in every timezone a schedule
// can use: a slot's date is local, and UTC-12 reaches Monday twelve hours
// after UTC does. Until then its last day may not be frozen yet, and a week
// shown before its last day was counted would change when it was.
const trendLag = 12 * time.Hour

// Trend reports the space's last TrendWeeks completed weeks, Monday first,
// oldest first. The running week is never included: reported day by day, it
// would let each new day's answers be read off the change. Ratios are rounded
// to one decimal place, so a ratio does not pin down the counts behind it.
func Trend(ctx context.Context, pool *pgxpool.Pool, spaceID string, now time.Time) ([]TrendWeek, error) {
	if err := store.FreezePastTrendDays(ctx, pool, spaceID, now); err != nil {
		return nil, err
	}
	y, m, d := now.Add(-trendLag).UTC().Date()
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
		ratios[week] = math.Round(answered/eligible*10) / 10
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
