package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// spaceSessionRows reads the session list off the space payload, keyed by id,
// so a test can ask what one row says without indexing into a slice whose
// order is the server's business.
func spaceSessionRows(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) map[string]map[string]any {
	t.Helper()
	resp, body := doJSON(t, srv, "GET", "/api/orgs/default/spaces/"+slug, "", cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get space: %d", resp.StatusCode)
	}
	out := map[string]map[string]any{}
	raw, _ := body["sessions"].([]any)
	for _, v := range raw {
		row, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("session row is not an object: %v", v)
		}
		id, _ := row["id"].(string)
		out[id] = row
	}
	return out
}

// hereIn reads one row's count. A missing "here" is a failure, not a zero:
// the whole point is that the field is there.
func hereIn(t *testing.T, srv *httptest.Server, slug, sessionID string, cookie *http.Cookie) int {
	t.Helper()
	row, ok := spaceSessionRows(t, srv, slug, cookie)[sessionID]
	if !ok {
		t.Fatalf("session %s missing from the space payload", sessionID)
	}
	n, ok := row["here"].(float64)
	if !ok {
		t.Fatalf("session %s has no numeric \"here\": %v", sessionID, row)
	}
	return int(n)
}

// The badge has to count the people actually connected to *that* session, not
// report on whether anyone ever ended it.
func TestSpaceSessionsCountWhoIsHere(t *testing.T) {
	srv := testServer(t)
	fac, member, first := setupSession(t, srv, "Here Count Space")
	slug := spaceSlugOf(t, srv, first, fac)
	_, second := createSession(t, srv, slug, "poker", "Nobody home", fac)
	secondID := second["id"].(string)

	wsFac, _, err := dialWS(t, srv, first, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()
	wsMem, _, err := dialWS(t, srv, first, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsMem.Close()

	eventually(t, 10*time.Second, "the busy session to report two people here", func() bool {
		return hereIn(t, srv, slug, first, fac) == 2
	})
	// Positive control above: presence has demonstrably landed, so a zero on
	// the other session is a real zero and not "the write hasn't arrived yet".
	if got := hereIn(t, srv, slug, secondID, fac); got != 0 {
		t.Fatalf("empty session: here = %d, want 0", got)
	}
}

// Two tabs are one person. Presence is stored per replica — the primary key
// carries replica_id — so the same member on two pods is two rows, and a
// count that does not de-duplicate says 2. That makes the badge lie about how
// many people are in the room.
func TestSpaceSessionCountsOnePersonOnce(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)
	fac, _, id := setupSession(t, srvA, "Two Sockets Space")
	slug := spaceSlugOf(t, srvA, id, fac)

	for _, srv := range []*httptest.Server{srvA, srvB} {
		ws, _, err := dialWS(t, srv, id, fac, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
	}

	// Positive control first, and it has to wait for BOTH replicas' rows, not
	// just for presence to exist. Waiting on `here >= 1` would let the equality
	// below fire before the second row lands — the count would read 1 because
	// only one row was written yet, not because it de-duplicated, and a missing
	// `distinct` would pass. Presence writes are debounced 1500ms, so the row
	// count is the only honest signal that both replicas have reported.
	pool := testDBPool(t)
	eventually(t, 10*time.Second, "both replicas to record a presence row", func() bool {
		// Only this one person is connected, so every row for the session is
		// theirs — one per replica.
		var rows int
		if err := pool.QueryRow(context.Background(),
			`select count(*) from session_presence where session_id::text = $1`, id).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows == 2
	})
	if got := hereIn(t, srvA, slug, id, fac); got != 1 {
		t.Fatalf("one person on two replicas: here = %d, want 1", got)
	}
}

// An ended session is over. Whatever presence rows are still lying around for
// it, the row must read zero — "ended" is the badge, not "3 here".
func TestEndedSessionReportsNobodyHere(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Ended Count Space")
	slug := spaceSlugOf(t, srv, id, fac)

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	// Positive control: the session counts someone while it is open, so the
	// zero after closing is caused by the close and not by a late write.
	eventually(t, 10*time.Second, "the open session to count its connected member", func() bool {
		return hereIn(t, srv, slug, id, fac) == 1
	})

	closeSession(t, srv, id, fac)
	if got := hereIn(t, srv, slug, id, fac); got != 0 {
		t.Fatalf("ended session: here = %d, want 0", got)
	}
}

// The count is an addition. Everything the page already read off a session row
// has to arrive unchanged.
func TestSpaceSessionRowKeepsItsFields(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Field Shape Space")
	slug := spaceSlugOf(t, srv, id, fac)

	row := spaceSessionRows(t, srv, slug, fac)[id]
	if row == nil {
		t.Fatal("session missing from the space payload")
	}
	if got, _ := row["kind"].(string); got != "poker" {
		t.Fatalf("kind = %q, want %q", got, "poker")
	}
	if got, _ := row["title"].(string); got != "Sprint 12" {
		t.Fatalf("title = %q, want %q", got, "Sprint 12")
	}
	if got, _ := row["createdAt"].(string); got == "" {
		t.Fatalf("createdAt missing: %v", row)
	}
	if _, ok := row["endedAt"]; !ok {
		t.Fatalf("endedAt missing: %v", row)
	}
	if _, ok := row["here"]; !ok {
		t.Fatalf("here missing: %v", row)
	}
}

// Who is in a room is members-only. A stranger's payload must not carry the
// session list at all, let alone a headcount for it.
func TestNonMemberSeesNoSessionCounts(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Stranger Space")
	slug := spaceSlugOf(t, srv, id, fac)

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	// Positive control: a member really can see a non-zero count right now,
	// so the stranger's empty payload is a permission boundary and not an
	// empty room.
	eventually(t, 10*time.Second, "a member to see the connected facilitator", func() bool {
		return hereIn(t, srv, slug, id, fac) == 1
	})

	outsider := signup(t, srv, "Nosy")
	resp, body := doJSON(t, srv, "GET", "/api/orgs/default/spaces/"+slug, "", outsider)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stranger get space: %d", resp.StatusCode)
	}
	if _, ok := body["sessions"]; ok {
		t.Fatalf("stranger payload carries sessions: %v", body)
	}
	if _, ok := body["members"]; ok {
		t.Fatalf("stranger payload carries the roster: %v", body)
	}
}

// A member holds one seat in the roster but can be counted in every session
// they have open. The two answers are deliberately different: "at" is where to
// find you, "here" is how many people are in a room.
func TestMemberCountsInEverySessionTheyHaveOpen(t *testing.T) {
	srv := testServer(t)
	fac, _, first := setupSession(t, srv, "Two Rooms Space")
	slug := spaceSlugOf(t, srv, first, fac)
	_, second := createSession(t, srv, slug, "standup", "Second room", fac)
	secondID := second["id"].(string)

	for _, id := range []string{first, secondID} {
		ws, _, err := dialWS(t, srv, id, fac, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
	}

	// Both counts must come off the SAME payload. Reading them with two
	// requests lets a count that moves a person from one room to the other
	// satisfy the check non-atomically — first reads 1 on one request, second
	// reads 1 on the next, and nothing was ever true at once.
	eventually(t, 10*time.Second, "one payload where both rooms count the same person", func() bool {
		rows := spaceSessionRows(t, srv, slug, fac)
		one, _ := rows[first]["here"].(float64)
		two, _ := rows[secondID]["here"].(float64)
		return one == 1 && two == 1
	})

	// ...while the roster still puts them in exactly one place.
	_, body := doJSON(t, srv, "GET", "/api/orgs/default/spaces/"+slug, "", fac)
	members, _ := body["members"].([]any)
	seated := 0
	for _, m := range members {
		row, _ := m.(map[string]any)
		if row["at"] != nil {
			seated++
		}
	}
	if seated != 1 {
		t.Fatalf("members holding a seat = %d, want 1", seated)
	}
}
