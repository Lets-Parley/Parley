package api

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func scheduleURL(slug string) string {
	return "/api/orgs/default/spaces/" + slug + "/standup-schedule"
}

const validSchedule = `{"weekdays":[1,2,3,4,5],"openTime":"09:30","timezone":"America/New_York","windowMinutes":120,"enabled":true}`

func TestOwnerSetsAndReadsTheStandupSchedule(t *testing.T) {
	srv := testServer(t)
	owner, member, slug := deckSpace(t, srv)

	if resp, body := doJSON(t, srv, http.MethodGet, scheduleURL(slug), "", member); resp.StatusCode != http.StatusOK || body["schedule"] != nil {
		t.Fatalf("empty schedule: got %d %v", resp.StatusCode, body)
	}
	if resp, body := doJSON(t, srv, http.MethodPut, scheduleURL(slug), validSchedule, owner); resp.StatusCode != http.StatusOK {
		t.Fatalf("owner put: got %d %v", resp.StatusCode, body)
	}
	resp, body := doJSON(t, srv, http.MethodGet, scheduleURL(slug), "", member)
	sched, _ := body["schedule"].(map[string]any)
	if resp.StatusCode != http.StatusOK || sched["openTime"] != "09:30" || sched["timezone"] != "America/New_York" || sched["enabled"] != true {
		t.Fatalf("member read: got %d %v", resp.StatusCode, body)
	}
}

func TestOnlyTheSpaceOwnerEditsTheStandupSchedule(t *testing.T) {
	srv := testServer(t)
	_, member, slug := deckSpace(t, srv)
	if resp, body := doJSON(t, srv, http.MethodPut, scheduleURL(slug), validSchedule, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member put: got %d %v, want 403", resp.StatusCode, body)
	}
	outsider := signup(t, srv, "Outsider")
	if resp, _ := doJSON(t, srv, http.MethodGet, scheduleURL(slug), "", outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider get: got %d, want 404", resp.StatusCode)
	}
}

func TestStandupScheduleRefusesAnInvalidTimezone(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	resp, body := doJSON(t, srv, http.MethodPut, scheduleURL(slug),
		`{"weekdays":[1],"openTime":"09:30","timezone":"Mars/Olympus_Mons","windowMinutes":60,"enabled":true}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid timezone: got %d %v, want 400", resp.StatusCode, body)
	}
	// A valid schedule plus one field the handler does not know. An invalid
	// body would be refused by Validate and would not show that unknown
	// fields are rejected.
	unknown := `{"weekdays":[1,2,3,4,5],"openTime":"09:30","timezone":"America/New_York","windowMinutes":120,"enabled":true,"bogus":1}`
	if resp, body := doJSON(t, srv, http.MethodPut, scheduleURL(slug), unknown, owner); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field: got %d %v, want 400", resp.StatusCode, body)
	}
}

// The ticker runs from Router when the interval is set, and Shutdown waits
// for it: a pass still in flight when the pool closes would log closed-pool
// errors into whichever test runs next.
func TestRouterRunsTheStandupSchedulerAndStopsItOnShutdown(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test", StandupScheduleInterval: 20 * time.Millisecond})
	owner, _, slug := deckSpace(t, srv)
	always := `{"weekdays":[0,1,2,3,4,5,6],"openTime":"00:00","timezone":"UTC","windowMinutes":60,"enabled":true}`
	if resp, body := doJSON(t, srv, http.MethodPut, scheduleURL(slug), always, owner); resp.StatusCode != http.StatusOK {
		t.Fatalf("put: got %d %v", resp.StatusCode, body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(context.Background(), "select count(*) from standup_schedule_slots where session_id is not null").Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the scheduler never opened today's slot")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
