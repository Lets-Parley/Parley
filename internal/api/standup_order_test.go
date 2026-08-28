package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// standupSpace builds a standup session in its own space with the named
// members, returning each one's cookie in the order given. The first name is
// the facilitator.
func standupSpace(t *testing.T, srv *httptest.Server, spaceName string, names ...string) (cookies []*http.Cookie, ids []string, sessionID string) {
	t.Helper()
	for _, n := range names {
		cookies = append(cookies, signup(t, srv, n))
	}
	_, sp := createSpace(t, srv, spaceName, cookies[0])
	slug := sp["slug"].(string)
	code, _ := sp["passcode"].(string)
	for _, c := range cookies[1:] {
		if resp := joinSpace(t, srv, slug, c, code); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join: %d", resp.StatusCode)
		}
	}
	for _, c := range cookies {
		_, me := doJSON(t, srv, "GET", "/api/me", "", c)
		ids = append(ids, me["id"].(string))
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/orgs/default/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"standup","title":"Daily"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookies[0])
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var sess map[string]any
	jsonDecode(t, resp, &sess)
	return cookies, ids, sess["id"].(string)
}

// positions reads the standup entries as a userID -> position map.
func positions(t *testing.T, srv *httptest.Server, id string, as *http.Cookie) map[string]float64 {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", as)
	out := map[string]float64{}
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		out[entry["userId"].(string)] = entry["position"].(float64)
	}
	return out
}

// assertDistinctPositions fails when two people share a slot. A tie makes the
// "next entry after the current position" query in advance pick one of them
// arbitrarily and silently drop the other from the round.
func assertDistinctPositions(t *testing.T, got map[string]float64) {
	t.Helper()
	seen := map[float64]string{}
	for user, pos := range got {
		if other, dup := seen[pos]; dup {
			t.Errorf("users %s and %s share position %v", other, user, pos)
		}
		seen[pos] = user
	}
}

// speakingOrder walks the whole round with next, returning every user who got
// a turn, in order.
func speakingOrder(t *testing.T, srv *httptest.Server, id string, fac *http.Cookie) []string {
	t.Helper()
	var order []string
	for i := 0; i < 20; i++ {
		_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
		speaker := standupState(env)["currentSpeakerId"]
		if speaker == nil {
			return order
		}
		order = append(order, speaker.(string))
		if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/next", "", fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("next: %d", resp.StatusCode)
		}
	}
	t.Fatal("the standup never reached done")
	return nil
}

// assertRosterOrder fails unless the round is exactly the given users in the
// given order — both the stored positions and the turns actually taken.
func assertRosterOrder(t *testing.T, srv *httptest.Server, id string, fac *http.Cookie, want ...string) {
	t.Helper()
	pos := positions(t, srv, id, fac)
	assertDistinctPositions(t, pos)
	for i := 1; i < len(want); i++ {
		if pos[want[i-1]] >= pos[want[i]] {
			t.Errorf("position %v for user %d is not before %v for user %d",
				pos[want[i-1]], i-1, pos[want[i]], i)
		}
	}
	got := speakingOrder(t, srv, id, fac)
	if len(got) != len(want) {
		t.Fatalf("speaking order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("speaking order = %v, want %v", got, want)
		}
	}
}

func closeAll(conns ...[]*websocket.Conn) func() {
	return func() {
		for _, group := range conns {
			for _, c := range group {
				c.Close()
			}
		}
	}
}

// TestStandupStartOrdersByName pins the documented order: the roster's
// alphabetical order, not the order people joined the space or connected.
func TestStandupStartOrdersByName(t *testing.T) {
	srv := testServer(t)
	// Deliberately created, joined and connected out of alphabetical order.
	cookies, ids, id := standupSpace(t, srv, "Order Space", "Zara Quinn", "Dana Whitfield", "Marcus Okonjo")
	conns := connectAll(t, srv, id, cookies[2], cookies[0], cookies[1])
	defer closeAll(conns)()

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	zara, dana, marcus := ids[0], ids[1], ids[2]
	assertRosterOrder(t, srv, id, cookies[0], dana, marcus, zara)
}

// TestStandupLateJoinerGetsItsOwnSlot covers restarting a standup once somebody
// else has connected. The newcomer has to be folded into the roster order
// without landing on a slot an existing entry already holds — a tie drops one
// of the pair from the round, because advance walks to the next position after
// the current one.
func TestStandupLateJoinerGetsItsOwnSlot(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Late Space", "Amy Stone", "Zoe Vance", "Bob Ito")
	amy, zoe, bob := ids[0], ids[1], ids[2]

	first := connectAll(t, srv, id, cookies[0], cookies[1])
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first start: %d", resp.StatusCode)
	}
	before := positions(t, srv, id, cookies[0])
	assertDistinctPositions(t, before)
	if before[amy] >= before[zoe] {
		t.Fatalf("first start is not in name order: Amy=%v Zoe=%v", before[amy], before[zoe])
	}

	// Bob sorts between Amy and Zoe, so he belongs in the middle of the round
	// rather than appended to the end of it.
	late := connectAll(t, srv, id, cookies[2])
	defer closeAll(first, late)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second start: %d", resp.StatusCode)
	}
	if got := len(positions(t, srv, id, cookies[0])); got != 3 {
		t.Fatalf("entries after the restart: %d, want 3", got)
	}
	assertRosterOrder(t, srv, id, cookies[0], amy, bob, zoe)
}

// TestStandupStartAfterAnEarlyEntry covers the other way a position is taken
// before start runs: writing an update early inserts the row at max+1, which
// must not leave the early writer sitting in front of the roster order.
func TestStandupStartAfterAnEarlyEntry(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Early Space", "Amy Stone", "Zoe Vance", "Bob Ito")
	amy, zoe, bob := ids[0], ids[1], ids[2]

	// Zoe fills her update in before the facilitator starts. She sorts last,
	// and typing first must not change that.
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"","today":"finish the migration","blockers":""}`, cookies[1]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("early entry: %d", resp.StatusCode)
	}

	conns := connectAll(t, srv, id, cookies[0], cookies[1], cookies[2])
	defer closeAll(conns)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	// The early update survives the renumbering that start performs.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", cookies[1])
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		if entry["userId"] == zoe && entry["today"] != "finish the migration" {
			t.Fatalf("the early entry was overwritten by start: %v", entry)
		}
	}
	assertRosterOrder(t, srv, id, cookies[0], amy, bob, zoe)
}

// TestStandupSpectatorNeverSpeaks covers a spectator who wrote an update
// anyway. Spectators are excluded from the round: they must not take a slot,
// and above all must not be handed the first turn because their row was
// created before anybody else's.
func TestStandupSpectatorNeverSpeaks(t *testing.T) {
	srv := testServer(t)
	// The spectator sorts first by name, so a renumbering that ignores the
	// spectator flag would put her at the head of the round.
	cookies, ids, id := standupSpace(t, srv, "Spectator Space", "Bea Stone", "Ada Nowak", "Cal Ito")
	bea, ada, cal := ids[0], ids[1], ids[2]

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, cookies[1]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"today":"just watching"}`, cookies[1]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator entry: %d", resp.StatusCode)
	}

	conns := connectAll(t, srv, id, cookies[0], cookies[1], cookies[2])
	defer closeAll(conns)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	pos := positions(t, srv, id, cookies[0])
	assertDistinctPositions(t, pos)
	if pos[ada] < pos[bea] || pos[ada] < pos[cal] {
		t.Errorf("the spectator holds position %v, ahead of Bea=%v or Cal=%v", pos[ada], pos[bea], pos[cal])
	}
	assertRosterOrder(t, srv, id, cookies[0], bea, cal)
}
