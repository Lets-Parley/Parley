package api

import (
	"net/http"
	"net/http/httptest"
	"sort"
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
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
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
		if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/next", "", fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("next: %d", resp.StatusCode)
		}
	}
	t.Fatal("the standup never reached done")
	return nil
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

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	pos := positions(t, srv, id, cookies[0])
	assertDistinctPositions(t, pos)

	zara, dana, marcus := ids[0], ids[1], ids[2]
	if !(pos[dana] < pos[marcus] && pos[marcus] < pos[zara]) {
		t.Fatalf("positions are not in name order: Dana=%v Marcus=%v Zara=%v",
			pos[dana], pos[marcus], pos[zara])
	}
	if got := speakingOrder(t, srv, id, cookies[0]); len(got) != 3 ||
		got[0] != dana || got[1] != marcus || got[2] != zara {
		t.Fatalf("speaking order = %v, want Dana, Marcus, Zara", got)
	}
}

// TestStandupLateJoinerGetsItsOwnSlot covers restarting a standup after
// somebody else connects. The second start recomputes row_number over the
// larger connected set while the already-present rows keep their original
// positions, so a naive numbering hands the newcomer a slot somebody already
// holds — and the loser of that tie never speaks.
func TestStandupLateJoinerGetsItsOwnSlot(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Late Space", "Amy Stone", "Zoe Vance", "Bob Ito")
	amy, zoe, bob := ids[0], ids[1], ids[2]

	first := connectAll(t, srv, id, cookies[0], cookies[1])
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first start: %d", resp.StatusCode)
	}
	before := positions(t, srv, id, cookies[0])
	assertDistinctPositions(t, before)

	// Bob sorts between Amy and Zoe, so a restart renumbers him onto Zoe's slot.
	late := connectAll(t, srv, id, cookies[2])
	defer closeAll(first, late)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second start: %d", resp.StatusCode)
	}

	after := positions(t, srv, id, cookies[0])
	if len(after) != 3 {
		t.Fatalf("entries after the restart: %d, want 3", len(after))
	}
	assertDistinctPositions(t, after)
	// The people already in the round keep the slot they were given: a restart
	// must not reshuffle anybody who has possibly already spoken.
	for _, u := range []string{amy, zoe} {
		if after[u] != before[u] {
			t.Errorf("position for %s moved from %v to %v on restart", u, before[u], after[u])
		}
	}
	if after[bob] <= after[zoe] {
		t.Errorf("the late joiner landed at %v, want a slot after the existing %v", after[bob], after[zoe])
	}

	order := speakingOrder(t, srv, id, cookies[0])
	if len(order) != 3 {
		t.Fatalf("speaking order = %v, want all three to get a turn", order)
	}
	sorted := append([]string{}, order...)
	sort.Strings(sorted)
	want := []string{amy, zoe, bob}
	sort.Strings(want)
	for i := range want {
		if sorted[i] != want[i] {
			t.Fatalf("speaking order = %v, want everyone exactly once", order)
		}
	}
}

// TestStandupStartAfterAnEarlyEntry covers the other way a position is taken
// before start runs: writing an update early inserts the row at max+1, and
// start must number the rest around it rather than on top of it.
func TestStandupStartAfterAnEarlyEntry(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Early Space", "Amy Stone", "Zoe Vance", "Bob Ito")

	// Zoe fills her update in before the facilitator starts.
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup",
		`{"yesterday":"","today":"finish the migration","blockers":""}`, cookies[1]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("early entry: %d", resp.StatusCode)
	}

	conns := connectAll(t, srv, id, cookies[0], cookies[1], cookies[2])
	defer closeAll(conns)()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", cookies[0]); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	pos := positions(t, srv, id, cookies[0])
	if len(pos) != 3 {
		t.Fatalf("entries: %d, want 3", len(pos))
	}
	assertDistinctPositions(t, pos)
	if order := speakingOrder(t, srv, id, cookies[0]); len(order) != 3 {
		t.Fatalf("speaking order = %v, want all three to get a turn", order)
	}
	// The early update survives the start that follows it.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", cookies[1])
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		if entry["userId"] == ids[1] && entry["today"] != "finish the migration" {
			t.Fatalf("the early entry was overwritten by start: %v", entry)
		}
	}
}
