package standup

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestValidateAwayRange(t *testing.T) {
	today := time.Date(2026, 9, 22, 15, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name       string
		start, end string
		ok         bool
	}{
		{"one day", "2026-09-22", "2026-09-22", true},
		{"a fortnight ahead", "2026-10-05", "2026-10-16", true},
		{"ninety days is the longest", "2026-10-01", "2026-12-29", true},
		{"ninety-one days is too long", "2026-10-01", "2026-12-30", false},
		{"the end before the start", "2026-09-25", "2026-09-24", false},
		{"thirty days back is allowed", "2026-08-23", "2026-08-25", true},
		{"thirty-one days back is too far", "2026-08-22", "2026-08-25", false},
		{"a year ahead is allowed", "2027-09-22", "2027-09-23", true},
		{"more than a year ahead is not", "2027-09-23", "2027-09-24", false},
		{"not a date", "next monday", "2026-09-24", false},
		{"a timestamp is not a date", "2026-09-22T00:00:00Z", "2026-09-24", false},
		{"missing", "", "", false},
	} {
		_, _, err := ValidateAway(tc.start, tc.end, today)
		if (err == nil) != tc.ok {
			t.Errorf("%s: ValidateAway(%q, %q) error = %v, want ok=%v", tc.name, tc.start, tc.end, err, tc.ok)
		}
	}
}

func addAway(t *testing.T, s *AwayStore, userID string, start, end time.Time) AwayRange {
	t.Helper()
	r, err := s.Add(context.Background(), userID, start, end)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func utcDay(offset int) time.Time {
	y, m, d := time.Now().UTC().Date()
	return time.Date(y, m, d+offset, 0, 0, 0, 0, time.UTC)
}

// A person reads and removes their own ranges only: another user's id is the
// same "not found" as an id that exists nowhere.
func TestAwayRangesBelongToTheirOwner(t *testing.T) {
	pool := testPool(t)
	_, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")
	s := &AwayStore{Pool: pool}
	r := addAway(t, s, ids[0], utcDay(1), utcDay(3))

	if got, _ := s.List(context.Background(), ids[1]); len(got) != 0 {
		t.Fatalf("ruth sees dana's ranges: %+v", got)
	}
	if ok, err := s.Delete(context.Background(), ids[1], r.ID); err != nil || ok {
		t.Fatalf("ruth deleted dana's range: ok=%v err=%v", ok, err)
	}
	got, err := s.List(context.Background(), ids[0])
	if err != nil || len(got) != 1 || got[0].StartsOn != utcDay(1).Format(time.DateOnly) || got[0].EndsOn != utcDay(3).Format(time.DateOnly) {
		t.Fatalf("dana's list: %+v %v", got, err)
	}
	if ok, err := s.Delete(context.Background(), ids[0], r.ID); err != nil || !ok {
		t.Fatalf("dana's own delete: ok=%v err=%v", ok, err)
	}
}

func TestAwayRangesAreCappedPerPerson(t *testing.T) {
	pool := testPool(t)
	_, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield")
	s := &AwayStore{Pool: pool}
	for i := 0; i < MaxAwayRanges; i++ {
		addAway(t, s, ids[0], utcDay(i), utcDay(i))
	}
	if _, err := s.Add(context.Background(), ids[0], utcDay(40), utcDay(40)); err != ErrTooManyAway {
		t.Fatalf("range past the cap: err = %v, want ErrTooManyAway", err)
	}
}

// The open digest names who is away today, so they are not read as owing an
// answer. Only space members are named, and only on a day their range covers.
func TestOpenAsyncStandupListsWhoIsAway(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor", "Priya Raman")
	s := &AwayStore{Pool: pool}
	addAway(t, s, ids[1], utcDay(-1), utcDay(1))
	addAway(t, s, ids[2], utcDay(2), utcDay(5)) // not today

	// Someone away today who is not in this space is never named here.
	var outsider string
	if err := pool.QueryRow(context.Background(),
		"insert into users (name) values ('Outsider') returning id::text").Scan(&outsider); err != nil {
		t.Fatal(err)
	}
	addAway(t, s, outsider, utcDay(-1), utcDay(1))

	st := buildStandupState(t, pool, sess)
	if !slices.Equal(st.Away, []string{ids[1]}) {
		t.Fatalf("away = %v, want only ruth %s", st.Away, ids[1])
	}
}

// An ended standup keeps its entries only (#388): no not-yet list, and no away
// list either, so neither can be rebuilt into a per-person history.
func TestEndedStandupServesNoAwayList(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")
	addAway(t, &AwayStore{Pool: pool}, ids[1], utcDay(-1), utcDay(1))
	if _, err := pool.Exec(context.Background(), "update sessions set ended_at = now() where id = $1", sess.ID); err != nil {
		t.Fatal(err)
	}
	ended := sess
	now := time.Now()
	ended.EndedAt = &now
	st := buildStandupState(t, pool, ended)
	if st.Away == nil || len(st.Away) != 0 {
		t.Fatalf("ended standup away = %#v, want an empty list", st.Away)
	}
}

// A sync standup is a live room: who is away is not its business.
func TestSyncStandupServesNoAwayList(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	addAway(t, &AwayStore{Pool: pool}, ids[1], utcDay(-1), utcDay(1))
	if st := buildStandupState(t, pool, sess); st.Away == nil || len(st.Away) != 0 {
		t.Fatalf("sync standup away = %#v, want an empty list", st.Away)
	}
}
