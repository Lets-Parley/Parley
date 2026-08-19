package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/store"
)

// presenceFrom asks one replica who it thinks is in the room.
func presenceFrom(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) map[string]bool {
	t.Helper()
	resp, body := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get session: %d", resp.StatusCode)
	}
	out := map[string]bool{}
	raw, _ := body["presence"].([]any)
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out[s] = true
		}
	}
	return out
}

func spaceSlugOf(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) string {
	t.Helper()
	_, body := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", cookie)
	slug, _ := body["spaceSlug"].(string)
	if slug == "" {
		t.Fatal("could not read spaceSlug from the session envelope")
	}
	return slug
}

func facilitatorConnectedFrom(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) bool {
	t.Helper()
	_, body := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", cookie)
	got, _ := body["facilitatorConnected"].(bool)
	return got
}

// eventually retries until the condition holds, so a test does not depend on
// how quickly a presence write lands.
func eventually(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for: %s", within, what)
}

// Presence must be the same answer whichever replica is asked. Held in each
// process's hub it is not: a member connected to one pod is invisible to the
// other, so half the room sees a different set of faces than the other half.
func TestPresenceIsSharedAcrossReplicas(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	fac, member, id := setupSession(t, srvA, "Presence Space")
	facID := userID(t, srvA, fac)
	memID := userID(t, srvA, member)

	// The facilitator sits on A, the member on B.
	wsFac, _, err := dialWS(t, srvA, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()
	wsMem, _, err := dialWS(t, srvB, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsMem.Close()

	for _, tc := range []struct {
		name   string
		srv    *httptest.Server
		cookie *http.Cookie
	}{
		{"replica A", srvA, fac},
		{"replica B", srvB, member},
	} {
		eventually(t, 5*time.Second, tc.name+" sees both people in the room", func() bool {
			p := presenceFrom(t, tc.srv, id, tc.cookie)
			return p[facID] && p[memID]
		})
	}
}

// The facilitator holding a socket on another replica must not read as offline.
// This is the visible half of the bug: the client shows a "facilitator has left"
// banner to everyone who did not happen to land on the same pod.
func TestFacilitatorConnectedIsSeenFromAnotherReplica(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	fac, member, id := setupSession(t, srvA, "Facilitator Space")

	wsFac, _, err := dialWS(t, srvA, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()

	eventually(t, 5*time.Second, "replica B reports the facilitator connected", func() bool {
		return facilitatorConnectedFrom(t, srvB, id, member)
	})
}

// A replica that dies without closing its sockets leaves rows behind. They must
// age out, or the room shows ghosts forever.
func TestStalePresenceRowsAreIgnoredAndSwept(t *testing.T) {
	srv := testServer(t)
	pool := testDBPool(t)

	fac, member, id := setupSession(t, srv, "Ghost Space")
	memID := userID(t, srv, member)

	wsFac, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()

	// A row from a replica that is no longer running, last seen well outside
	// the window.
	if _, err := pool.Exec(context.Background(),
		`insert into session_presence (session_id, user_id, replica_id, seen_at)
		 values ($1, $2, 'dead-replica', now() - interval '10 minutes')`,
		id, memID); err != nil {
		t.Fatal(err)
	}

	if p := presenceFrom(t, srv, id, fac); p[memID] {
		t.Fatal("a presence row older than the window still counted as present")
	}

	// The filter above keeps ghosts out of the room; the sweep is what stops the
	// table growing forever. Driven directly rather than waiting on the ticker,
	// so this asserts the query and not the clock.
	sweeper := &store.Presence{Pool: pool, ReplicaID: "test", Window: 2 * hub.PongDeadline}
	if err := sweeper.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	var stale int
	if err := pool.QueryRow(context.Background(),
		`select count(*) from session_presence where replica_id = 'dead-replica'`).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 0 {
		t.Fatalf("the sweep left %d stale row(s) behind", stale)
	}

	// And it must not take the live ones with it.
	var live int
	if err := pool.QueryRow(context.Background(),
		`select count(*) from session_presence where replica_id <> 'dead-replica'`).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live == 0 {
		t.Fatal("the sweep deleted the rows of connected people")
	}
}

// Presence is per session. A row for one room must never leak into another.
func TestPresenceIsScopedToItsSession(t *testing.T) {
	srv := testServer(t)
	fac, member, idA := setupSession(t, srv, "Room A")
	memID := userID(t, srv, member)

	_, sessB := createSession(t, srv, spaceSlugOf(t, srv, idA, fac), "poker", "Room B", fac)
	idB := sessB["id"].(string)

	ws, _, err := dialWS(t, srv, idA, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	eventually(t, 5*time.Second, "the member shows up in room A", func() bool {
		return presenceFrom(t, srv, idA, fac)[memID]
	})
	if presenceFrom(t, srv, idB, fac)[memID] {
		t.Fatal("a member connected to room A appears in room B's presence")
	}
}

// Leaving has to take effect now, not when the row ages out. Relying on the
// window would leave someone in the room for the better part of two minutes
// after they closed the tab.
func TestPresenceClearsWhenAClientDisconnects(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Leaving Space")
	memID := userID(t, srv, member)

	wsFac, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()

	wsMem, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, 5*time.Second, "the member is in the room", func() bool {
		return presenceFrom(t, srv, id, fac)[memID]
	})

	wsMem.Close()

	// Well inside the freshness window: if this only passes after ~100s, the
	// disconnect path is doing nothing and the row is merely expiring.
	eventually(t, 10*time.Second, "the member leaves the room on disconnect", func() bool {
		return !presenceFrom(t, srv, id, fac)[memID]
	})
}

// Two tabs is one person. Closing one must not remove them from the room while
// the other is still open.
func TestPresenceSurvivesClosingOneOfTwoConnections(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Two Tabs Space")
	memID := userID(t, srv, member)

	first, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	eventually(t, 5*time.Second, "the member is in the room", func() bool {
		return presenceFrom(t, srv, id, fac)[memID]
	})

	second.Close()

	// Give the disconnect path time to do the wrong thing before asserting it
	// did not.
	time.Sleep(2 * time.Second)
	if !presenceFrom(t, srv, id, fac)[memID] {
		t.Fatal("closing one of two connections removed the member from the room")
	}
}

// Auto-reveal fires when everyone connected has voted. Counting only the
// clients on one replica shrinks the denominator, so a round would open while
// the rest of the table still had votes to cast — the one thing hidden votes
// must never do.
func TestAutoRevealCountsVotersOnEveryReplica(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	fac, member, id := setupSession(t, srvA, "Auto Reveal Space")

	// Both people are in the room, but on different replicas.
	wsFac, _, err := dialWS(t, srvA, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()
	wsMem, _, err := dialWS(t, srvB, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsMem.Close()

	facID := userID(t, srvA, fac)
	memID := userID(t, srvA, member)
	eventually(t, 5*time.Second, "both are in the room", func() bool {
		p := presenceFrom(t, srvA, id, fac)
		return p[facID] && p[memID]
	})

	storyID := addStory(t, srvA, id, "Rework the login screen", fac)
	selectStory(t, srvA, id, storyID, fac)

	// Only the facilitator votes. The member, on the other replica, has not.
	vote(t, srvA, storyID, "5", fac)

	// Give auto-reveal every chance to fire wrongly before asserting it did not.
	time.Sleep(1500 * time.Millisecond)
	_, body := doJSON(t, srvA, "GET", "/api/sessions/"+id, "", fac)
	if revealed, _ := body["revealed"].(bool); revealed {
		t.Fatal("the round revealed with one of two voters in — the denominator only counted this replica's clients")
	}
}
