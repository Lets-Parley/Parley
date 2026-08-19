package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// secondInstance stands up another Router against the SAME database, the way a
// second pod would. testPool drops the schema, so it must not be used here —
// testDBPool connects to the migrated database the first instance left behind.
func secondInstance(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Router(testDBPool(t), Options{
		AllowedOrigin: testOrigin,
		Context:       testContext(t),
	}))
	t.Cleanup(srv.Close)
	return srv
}

// letPresenceSettle waits out the debounced presence broadcast without reading.
//
// Attaching a connection schedules a presence broadcast, and that broadcast
// rebuilds the envelope from the database — so a test that mutates before it
// fires sees the new state arrive on any instance, fanout or not, and passes
// for a reason unrelated to what it claims to test. The frame it produces stays
// buffered in the socket for the reader below to skip.
//
// This sleeps rather than draining because a gorilla read timeout is permanent:
// draining until quiet would leave the connection unusable for the assertion.
func letPresenceSettle() {
	time.Sleep(2 * time.Second) // presenceDebounce is 1.5s
}

// awaitEnded reads frames until one shows the session closed, and reports how
// many closed-state frames arrived in total. Frames from the presence broadcast
// carry endedAt == nil and are skipped, so no read ever has to time out before
// the interesting one arrives.
func awaitEnded(t *testing.T, ws *websocket.Conn, within time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(within)
	seen := 0
	for time.Now().Before(deadline) {
		env, ok := readEnvelope(t, ws, time.Until(deadline))
		if !ok {
			break
		}
		if env["endedAt"] != nil {
			seen++
		}
	}
	return seen
}

// The whole point of the HA work: a mutation on one replica has to reach a
// client holding a WebSocket on a different replica. Each process has its own
// in-process hub, so nothing but the database connects them.
//
// This also pins two properties that make multi-replica possible at all: the
// session cookie is a DB-backed token, so it authenticates against an instance
// that never issued it; and BuildEnvelope re-reads from Postgres, so the second
// instance can build the frame without being told its contents.
func TestFanoutReachesAClientOnAnotherReplica(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	fac, member, id := setupSession(t, srvA, "Fanout Space")

	// The member's socket lives on B. Nothing it does will touch A's hub.
	wsB, _, err := dialWS(t, srvB, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()
	letPresenceSettle()

	// The facilitator mutates through A.
	if resp, _ := doJSON(t, srvA, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close session on A: %d", resp.StatusCode)
	}

	if awaitEnded(t, wsB, 5*time.Second) == 0 {
		t.Fatal("a mutation on instance A never reached the client connected to instance B")
	}
}

// The instance that handled the mutation broadcasts locally and then hears its
// own notification. It must not send the same state twice.
func TestFanoutDoesNotDuplicateOnTheOriginatingReplica(t *testing.T) {
	srvA := testServer(t)
	_ = secondInstance(t)

	fac, _, id := setupSession(t, srvA, "Duplicate Space")

	wsA, _, err := dialWS(t, srvA, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsA.Close()
	letPresenceSettle()

	if resp, _ := doJSON(t, srvA, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close: %d", resp.StatusCode)
	}

	switch n := awaitEnded(t, wsA, 3*time.Second); {
	case n == 0:
		t.Fatal("the originating replica sent nothing")
	case n > 1:
		t.Fatalf("the originating replica sent the closed state %d times — it broadcasts locally and then again on its own notification", n)
	}
}

// The listener is the single point of failure for cross-replica delivery, and
// it fails silently: the pool stays healthy, the replica keeps serving, and
// clients simply stop hearing about anything that happens elsewhere. A database
// failover drops it, so it has to come back on its own — and /readyz has to say
// so while it is gone.
func TestListenerRecoversAfterItsConnectionIsKilled(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)
	pool := testDBPool(t)

	fac, member, id := setupSession(t, srvA, "Recovery Space")

	// B must be listening before we can meaningfully kill its listener.
	waitReady(t, srvB, true, 10*time.Second)

	// Kill every LISTEN backend. This is what a failover looks like from the
	// application's side.
	if _, err := pool.Exec(context.Background(),
		`select pg_terminate_backend(pid) from pg_stat_activity
		 where query like 'listen %' and pid <> pg_backend_pid()`); err != nil {
		t.Fatal(err)
	}

	// It must come back without anyone restarting the process...
	waitReady(t, srvB, true, 30*time.Second)

	// ...and still deliver, which is the part a health check cannot prove.
	wsB, _, err := dialWS(t, srvB, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()
	letPresenceSettle()

	if resp, _ := doJSON(t, srvA, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close on A: %d", resp.StatusCode)
	}
	if awaitEnded(t, wsB, 10*time.Second) == 0 {
		t.Fatal("fanout did not resume after the listener reconnected")
	}
}

// waitReady polls /readyz until it reports what the caller expects.
func waitReady(t *testing.T, srv *httptest.Server, want bool, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	var last int
	for time.Now().Before(deadline) {
		resp, err := srv.Client().Get(srv.URL + "/readyz")
		if err == nil {
			last = resp.StatusCode
			resp.Body.Close()
			if (last == http.StatusOK) == want {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("/readyz never reported ready=%v within %s (last status %d)", want, within, last)
}
