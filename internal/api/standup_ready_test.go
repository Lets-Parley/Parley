package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// entries reads the standup entries as userID -> the whole wire entry.
func entriesByUser(t *testing.T, srv *httptest.Server, id string, as *http.Cookie) map[string]map[string]any {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", as)
	out := map[string]map[string]any{}
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		out[entry["userId"].(string)] = entry
	}
	return out
}

func setReadyAs(t *testing.T, srv *httptest.Server, id string, as *http.Cookie, ready bool) *http.Response {
	t.Helper()
	body := `{"ready":false}`
	if ready {
		body = `{"ready":true}`
	}
	resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/ready", body, as)
	return resp
}

// The whole point of the careful conflict clause: marking ready must not touch
// a single character of what the person has already typed. A conflict clause
// that wrote excluded.yesterday/today/blockers would silently wipe an
// autosaved update and broadcast the loss to the room.
func TestReadyDoesNotClobberAnExistingEntry(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Ready Clobber Space")
	_, me := doJSON(t, srv, "GET", "/api/me", "", m1)
	uid := me["id"].(string)

	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"shipped the importer","today":"review queue","blockers":"waiting on staging"}`,
		m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("entry: %d", resp.StatusCode)
	}
	if resp := setReadyAs(t, srv, id, m1, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("ready: %d", resp.StatusCode)
	}

	e := entriesByUser(t, srv, id, m1)[uid]
	if e == nil {
		t.Fatal("the entry disappeared entirely")
	}
	if e["yesterday"] != "shipped the importer" || e["today"] != "review queue" || e["blockers"] != "waiting on staging" {
		t.Fatalf("marking ready overwrote the update: %v", e)
	}
	if e["ready"] != true {
		t.Fatalf("ready = %v, want true", e["ready"])
	}
}

// start() prefills "yesterday" from the previous standup with `on conflict do
// nothing`, so a row that already exists is skipped. A ready click before the
// round starts must not be what destroys that carry-forward — it is now a
// one-click, zero-typing way to create the row.
func TestReadyBeforeStartPreservesTheCarryForward(t *testing.T) {
	srv := testServer(t)
	cookies, ids, firstID := standupSpace(t, srv, "Ready Carry Space", "Amy Stone", "Ben Ito")
	fac, ben := cookies[0], cookies[1]

	// Yesterday's standup: Ben said what he was doing today.
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+firstID+"/actions/standup",
		`{"today":"the migration"}`, ben); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first standup entry: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+firstID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close first session: %d", resp.StatusCode)
	}

	_, firstEnv := doJSON(t, srv, "GET", "/api/sessions/"+firstID, "", fac)
	_, sess := createSession(t, srv, firstEnv["spaceSlug"].(string), "standup", "Daily", fac)
	id := sess["id"].(string)

	// Ben has nothing to type today; he just says he is ready.
	if resp := setReadyAs(t, srv, id, ben, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("ready: %d", resp.StatusCode)
	}
	conns := connectAll(t, srv, id, fac, ben)
	defer closeAll(conns)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	if got := entriesByUser(t, srv, id, fac)[ids[1]]["yesterday"]; got != "the migration" {
		t.Fatalf("yesterday = %q, want the carried-forward %q", got, "the migration")
	}
}

// Readiness is per-person. Whatever shape the SQL takes, a session-wide UPDATE
// would light everybody up at once.
func TestReadyOnlyMarksTheCaller(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Ready Scope Space", "Amy Stone", "Ben Ito", "Cal Ray")

	// Everybody has a row before anybody signals: without them, a session-wide
	// UPDATE would touch exactly one row and look correct.
	for _, c := range cookies {
		if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
			`{"today":"something"}`, c); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("entry: %d", resp.StatusCode)
		}
	}

	if resp := setReadyAs(t, srv, id, cookies[1], true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("ready: %d", resp.StatusCode)
	}
	got := entriesByUser(t, srv, id, cookies[0])
	if got[ids[1]] == nil || got[ids[1]]["ready"] != true {
		t.Fatalf("the caller is not marked ready: %v", got[ids[1]])
	}
	for _, other := range []int{0, 2} {
		if e := got[ids[other]]; e != nil && e["ready"] == true {
			t.Errorf("user %d was marked ready by somebody else's click: %v", other, e)
		}
	}
}

// Readiness is a member signal, not a facilitator one — FacilitatorOnly here
// would leave nobody able to say they are ready.
func TestReadyIsNotFacilitatorOnly(t *testing.T) {
	srv := testServer(t)
	_, m1, _, id, _ := standupSetup(t, srv, "Ready Authz Space")
	if resp := setReadyAs(t, srv, id, m1, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("non-facilitator ready: got %d, want 204", resp.StatusCode)
	}
	// And it is idempotent rather than a blind toggle: sending true twice
	// leaves it true.
	if resp := setReadyAs(t, srv, id, m1, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("repeat ready: %d", resp.StatusCode)
	}
	_, me := doJSON(t, srv, "GET", "/api/me", "", m1)
	if entriesByUser(t, srv, id, m1)[me["id"].(string)]["ready"] != true {
		t.Fatal("a repeated ready:true flipped back to false")
	}
	if resp := setReadyAs(t, srv, id, m1, false); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("unready: %d", resp.StatusCode)
	}
	if entriesByUser(t, srv, id, m1)[me["id"].(string)]["ready"] != false {
		t.Fatal("ready:false did not clear the signal")
	}
}

// Spectators are excluded from the round by start(); a ready upsert that
// ignored the spectator flag would hand one an entry row, a seat in the rail
// and a blank line in the CSV.
func TestReadyGivesASpectatorNoEntryRow(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Ready Spectator Space", "Amy Stone", "Ben Ito")
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, cookies[1]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}
	if resp := setReadyAs(t, srv, id, cookies[1], true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator ready: %d", resp.StatusCode)
	}
	if e := entriesByUser(t, srv, id, cookies[0])[ids[1]]; e != nil {
		t.Fatalf("the spectator gained an entry row: %v", e)
	}
}

// position decides who holds the mic. A row created mid-round sorts after the
// current speaker, and advance() picks the next position up — so a latecomer
// clicking ready would be handed the turn.
func TestReadyDuringSpeakingDoesNotHandTheCallerTheMic(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Ready Mic Space", "Amy Stone", "Ben Ito", "Cal Ray")
	fac, cal := cookies[0], cookies[2]

	// Only Amy and Ben are connected when the round starts, so Cal is not in it.
	conns := connectAll(t, srv, id, fac, cookies[1])
	defer closeAll(conns)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	if resp := setReadyAs(t, srv, id, cal, true); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("late ready: %d", resp.StatusCode)
	}
	if e := entriesByUser(t, srv, id, fac)[ids[2]]; e != nil {
		t.Fatalf("a ready click mid-round inserted a non-participant into the roster: %v", e)
	}

	// Walk the round out: the mic must never reach Cal.
	for i := 0; i < 3; i++ {
		resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/next", "", fac)
		if resp.StatusCode == http.StatusConflict {
			break
		}
		_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
		if standupState(env)["currentSpeakerId"] == ids[2] {
			t.Fatal("the late ready click handed Cal the mic")
		}
	}
}
