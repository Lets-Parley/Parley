package plugin

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidCron is returned when a guest asks to schedule work with an
// expression the host will not turn into run_at. The alternative is storing
// the row and never firing it.
var ErrInvalidCron = errors.New("the cron expression is not a valid five-field schedule")

type cronSchedule struct {
	min, hour, dom, month, dow [64]bool
	domStar, dowStar           bool
}

func parseCron(expr string) (cronSchedule, error) {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 5 {
		return cronSchedule{}, fmt.Errorf("%w: want five fields (minute hour day-of-month month day-of-week), got %d", ErrInvalidCron, len(fields))
	}
	for _, f := range fields {
		for _, r := range f {
			if r == '@' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
				return cronSchedule{}, fmt.Errorf("%w: %q uses names or macros; use numbers", ErrInvalidCron, expr)
			}
		}
	}
	var s cronSchedule
	var err error
	if s.min, err = parseCronField(fields[0], 0, 59); err != nil {
		return cronSchedule{}, fmt.Errorf("%w: minute: %v", ErrInvalidCron, err)
	}
	if s.hour, err = parseCronField(fields[1], 0, 23); err != nil {
		return cronSchedule{}, fmt.Errorf("%w: hour: %v", ErrInvalidCron, err)
	}
	if s.dom, err = parseCronField(fields[2], 1, 31); err != nil {
		return cronSchedule{}, fmt.Errorf("%w: day-of-month: %v", ErrInvalidCron, err)
	}
	if s.month, err = parseCronField(fields[3], 1, 12); err != nil {
		return cronSchedule{}, fmt.Errorf("%w: month: %v", ErrInvalidCron, err)
	}
	if s.dow, err = parseCronField(fields[4], 0, 7); err != nil {
		return cronSchedule{}, fmt.Errorf("%w: day-of-week: %v", ErrInvalidCron, err)
	}
	if s.dow[7] {
		s.dow[0] = true
	}
	s.domStar = fields[2] == "*"
	s.dowStar = fields[4] == "*"
	return s, nil
}

func parseCronField(s string, min, max int) ([64]bool, error) {
	var out [64]bool
	for _, part := range strings.Split(s, ",") {
		if part == "" {
			return out, fmt.Errorf("empty list item")
		}
		rangePart, step := part, 1
		if i := strings.Index(part, "/"); i >= 0 {
			rangePart = part[:i]
			n, err := strconv.Atoi(part[i+1:])
			if err != nil || n < 1 {
				return out, fmt.Errorf("step %q", part[i+1:])
			}
			step = n
		}
		var lo, hi int
		switch {
		case rangePart == "*":
			lo, hi = min, max
		case strings.Contains(rangePart, "-"):
			a, b, ok := strings.Cut(rangePart, "-")
			if !ok {
				return out, fmt.Errorf("range %q", rangePart)
			}
			var err error
			lo, err = strconv.Atoi(a)
			if err != nil {
				return out, err
			}
			hi, err = strconv.Atoi(b)
			if err != nil {
				return out, err
			}
		default:
			n, err := strconv.Atoi(rangePart)
			if err != nil {
				return out, err
			}
			lo = n
			if step > 1 {
				hi = max
			} else {
				hi = n
			}
		}
		if lo < min || hi > max || lo > hi {
			return out, fmt.Errorf("%d-%d is outside %d-%d", lo, hi, min, max)
		}
		for v := lo; v <= hi; v += step {
			out[v] = true
		}
	}
	return out, nil
}

func (s cronSchedule) matches(t time.Time) bool {
	t = t.UTC()
	if !s.min[t.Minute()] || !s.hour[t.Hour()] || !s.month[int(t.Month())] {
		return false
	}
	domOK := s.dom[t.Day()]
	dowOK := s.dow[int(t.Weekday())]
	if s.domStar || s.dowStar {
		return (s.domStar || domOK) && (s.dowStar || dowOK)
	}
	return domOK || dowOK
}

func nextCron(expr string, from time.Time) (time.Time, error) {
	s, err := parseCron(expr)
	if err != nil {
		return time.Time{}, fmt.Errorf("%q: %w", expr, err)
	}
	t := from.UTC().Truncate(time.Minute).Add(time.Minute)
	limit := t.AddDate(5, 0, 0)
	for !t.After(limit) {
		if s.matches(t) {
			return t, nil
		}
		t = t.Add(time.Minute)
	}
	return time.Time{}, fmt.Errorf("%q: %w: no occurrence in the next five years", expr, ErrInvalidCron)
}
