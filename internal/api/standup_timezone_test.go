package api

import (
	"context"
	"net/http"
	"testing"
)

// Go loads these names and Postgres does not. A schedule is refused unless
// both of them can read its zone.
func TestStandupScheduleRefusesZonesPostgresCannotRead(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	for _, zone := range []string{"localtime", "posix/America/New_York", "right/UTC"} {
		body := `{"weekdays":[1],"openTime":"09:30","timezone":"` + zone + `","windowMinutes":60,"enabled":true}`
		resp, got := doJSON(t, srv, http.MethodPut, scheduleURL(slug), body, owner)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("timezone %q: got %d %v, want 400", zone, resp.StatusCode, got)
			continue
		}
		if msg, _ := got["error"].(string); msg == "" {
			t.Errorf("timezone %q: no error message in %v", zone, got)
		}
	}
	if resp, got := doJSON(t, srv, http.MethodPut, scheduleURL(slug), validSchedule, owner); resp.StatusCode != http.StatusOK {
		t.Fatalf("America/New_York: got %d %v, want 200", resp.StatusCode, got)
	}
}

// A schedule row an older binary saved with a zone Postgres cannot read,
// written straight in because the API now refuses it. Its open room and its
// trend must still answer.
func TestAStoredZonePostgresCannotReadLeavesTheRoomAndTrendReadable(t *testing.T) {
	srv, pool := trendServer(t)
	owner, slug, spaceID, ids := trendSpace(t, srv, pool, 4)
	ctx := context.Background()

	scheduledStandupOn(t, pool, spaceID, ids[0], lastWeek, ids[0], ids[1])
	awayOn(t, pool, ids[2], lastWeek.Format("2006-01-02"), lastWeek.Format("2006-01-02"))
	if _, err := pool.Exec(ctx, "update standup_schedules set timezone = 'localtime' where space_id = $1", spaceID); err != nil {
		t.Fatal(err)
	}
	// Today's slot, still open.
	var open string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2) returning id::text`, spaceID, ids[0]).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into standup_schedule_slots (schedule_id, slot_date, session_id)
		select id, current_date, $2 from standup_schedules where space_id = $1`, spaceID, open); err != nil {
		t.Fatal(err)
	}

	if status, body := getRaw(t, srv, "/api/sessions/"+open, owner); status != http.StatusOK {
		t.Fatalf("room: got %d %s, want 200", status, body)
	}
	if status, body := getRaw(t, srv, trendURL(slug), owner); status != http.StatusOK {
		t.Fatalf("trend: got %d %s, want 200", status, body)
	}
}
