package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Setting or removing your away days has to reach the open async standup on
// the same screen. The room socket replaces its state only when the version
// moves, so an away write that bumped nothing left you under "Not yet" until
// some other action or a reload.

// awayRefreshServer runs on the real clock: the rooms these tests open are
// "today" by Postgres's now(), and the handler has to agree.
func awayRefreshServer(t *testing.T) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return testServerWith(t, pool, Options{AllowedOrigin: testOrigin}), pool
}

// dbTodayUTC is today's UTC date as the database reads it, so a test run
// just before midnight cannot disagree with the statement it is checking.
func dbTodayUTC(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var d string
	if err := pool.QueryRow(context.Background(),
		"select ((now() at time zone 'UTC')::date)::text").Scan(&d); err != nil {
		t.Fatal(err)
	}
	return d
}

// openStandup writes a standup in the space. config is its config document,
// createdAgo how long before now it was created, and ended whether it is
// closed.
func openStandup(t *testing.T, pool *pgxpool.Pool, spaceID, facilitator, config string, createdAgo time.Duration, ended bool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		insert into sessions (space_id, kind, title, config, facilitator_id, created_at, ended_at)
		values ($1, 'standup', 'Daily', $2::jsonb, $3, now() - $4::interval,
		        case when $5 then now() else null end)
		returning id::text`, spaceID, config, facilitator, createdAgo.String(), ended).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func sessionVersion(t *testing.T, pool *pgxpool.Pool, id string) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(), "select version from sessions where id = $1", id).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func spaceIDOf(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), "select id::text from spaces where slug = $1", slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func frameAway(env map[string]any) []string {
	st, _ := env["state"].(map[string]any)
	raw, _ := st["away"].([]any)
	out := []string{}
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// awaitAway reads frames until one's away list matches want, or the deadline.
func awaitAway(t *testing.T, ws *websocket.Conn, within time.Duration, want func([]string) bool) bool {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		env, ok := readEnvelope(t, ws, time.Until(deadline))
		if !ok {
			return false
		}
		if want(frameAway(env)) {
			return true
		}
	}
	return false
}

func TestSettingAwayRefreshesTodaysOpenAsyncStandup(t *testing.T) {
	srv, pool := awayRefreshServer(t)
	ada := signup(t, srv, "Ada")
	adaID := userIDOf(t, srv, ada)
	_, sp := createSpace(t, srv, "Away Refresh", ada)
	spaceID := spaceIDOf(t, pool, sp["slug"].(string))
	room := openStandup(t, pool, spaceID, adaID, `{"mode":"async"}`, time.Minute, false)

	ws, _, err := dialWS(t, srv, room, ada, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	consumePresenceFrames(t, ws)

	before := sessionVersion(t, pool, room)
	today := dbTodayUTC(t, pool)
	resp, body := doJSON(t, srv, http.MethodPost, "/api/me/away", `{"startsOn":"`+today+`","endsOn":"`+today+`"}`, ada)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add: got %d %v", resp.StatusCode, body)
	}
	if after := sessionVersion(t, pool, room); after <= before {
		t.Fatalf("setting away left the open standup at version %d, was %d", after, before)
	}
	if !awayAway(t, ws, adaID, true) {
		t.Fatal("no frame listed Ada as away after she set today away")
	}

	before = sessionVersion(t, pool, room)
	id, _ := body["id"].(string)
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/away/"+id, "", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: got %d", resp.StatusCode)
	}
	if after := sessionVersion(t, pool, room); after <= before {
		t.Fatalf("removing away left the open standup at version %d, was %d", after, before)
	}
	if !awayAway(t, ws, adaID, false) {
		t.Fatal("no frame dropped Ada from away after she removed the range")
	}
}

func awayAway(t *testing.T, ws *websocket.Conn, userID string, want bool) bool {
	t.Helper()
	return awaitAway(t, ws, 5*time.Second, func(away []string) bool {
		return slices.Contains(away, userID) == want
	})
}

func TestSettingAwayLeavesOtherStandupsAlone(t *testing.T) {
	srv, pool := awayRefreshServer(t)
	ada := signup(t, srv, "Ada")
	adaID := userIDOf(t, srv, ada)
	_, sp := createSpace(t, srv, "Ada Space", ada)
	spaceID := spaceIDOf(t, pool, sp["slug"].(string))

	// Bea's space holds an open async standup today, and Ada is not in it.
	bea := signup(t, srv, "Bea")
	beaID := userIDOf(t, srv, bea)
	_, beaSp := createSpace(t, srv, "Bea Space", bea)
	beaSpace := spaceIDOf(t, pool, beaSp["slug"].(string))

	rooms := map[string]string{
		"ended async today":  openStandup(t, pool, spaceID, adaID, `{"mode":"async"}`, time.Minute, true),
		"open sync today":    openStandup(t, pool, spaceID, adaID, `{}`, time.Minute, false),
		"open async earlier": openStandup(t, pool, spaceID, adaID, `{"mode":"async"}`, 72*time.Hour, false),
		"not ada's space":    openStandup(t, pool, beaSpace, beaID, `{"mode":"async"}`, time.Minute, false),
	}
	before := map[string]int64{}
	for what, id := range rooms {
		before[what] = sessionVersion(t, pool, id)
	}

	today := dbTodayUTC(t, pool)
	resp, body := doJSON(t, srv, http.MethodPost, "/api/me/away", `{"startsOn":"`+today+`","endsOn":"`+today+`"}`, ada)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add: got %d %v", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/away/"+id, "", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: got %d", resp.StatusCode)
	}
	for what, id := range rooms {
		if got := sessionVersion(t, pool, id); got != before[what] {
			t.Errorf("%s: version %d, want it left at %d", what, got, before[what])
		}
	}
}
