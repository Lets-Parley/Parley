package plugin

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseCronRefusesGarbageRatherThanStoringASilentNoOp(t *testing.T) {
	for _, expr := range []string{
		"",
		"not a cron",
		"* * * *",
		"* * * * * *",
		"60 * * * *",
		"0 24 * * *",
		"0 0 0 1 *",
		"0 0 1 13 *",
		"0 0 * * 8",
		"1-10/0 * * * *",
		"@hourly",
		"0 9 * * MON",
	} {
		if _, err := parseCron(expr); err == nil {
			t.Errorf("parseCron(%q) accepted; want a refusal so a bad schedule cannot sit as a silent no-op", expr)
			continue
		} else if !errors.Is(err, ErrInvalidCron) {
			t.Errorf("parseCron(%q) returned %v; want ErrInvalidCron", expr, err)
		}
	}
}

func TestNextCronTurnsAFiveFieldExpressionIntoTheFollowingInstant(t *testing.T) {
	from := time.Date(2026, 9, 4, 16, 34, 12, 0, time.UTC) // Friday

	cases := []struct {
		expr string
		want time.Time
	}{
		{"* * * * *", time.Date(2026, 9, 4, 16, 35, 0, 0, time.UTC)},
		{"0 9 * * *", time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)},
		{"30 16 * * *", time.Date(2026, 9, 5, 16, 30, 0, 0, time.UTC)},
		{"0 0 1 1 *", time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)},
		{"0 9 * * 1-5", time.Date(2026, 9, 7, 9, 0, 0, 0, time.UTC)}, // Monday
		{"*/15 * * * *", time.Date(2026, 9, 4, 16, 45, 0, 0, time.UTC)},
	}
	for _, tc := range cases {
		got, err := nextCron(tc.expr, from)
		if err != nil {
			t.Errorf("nextCron(%q): %v", tc.expr, err)
			continue
		}
		if !got.Equal(tc.want) {
			t.Errorf("nextCron(%q) = %s, want %s", tc.expr, got.UTC(), tc.want)
		}
	}
}

func TestNextCronErrorNamesTheExpression(t *testing.T) {
	_, err := nextCron("bogus", time.Now())
	if err == nil {
		t.Fatal("nextCron accepted garbage")
	}
	if !strings.Contains(err.Error(), "bogus") && !strings.Contains(strings.ToLower(err.Error()), "cron") {
		t.Fatalf("the refusal reads %q; it should name the cron so an operator can fix it", err)
	}
}
