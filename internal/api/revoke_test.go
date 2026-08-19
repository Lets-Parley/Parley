package api

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// revokeAssertWindow is deliberately far shorter than the hub's revalidation
// interval. Every test here asserts a socket closes inside it, so none of them
// can be satisfied by the revalidate backstop instead of the fanout under test.
//
// The interval cannot be raised past hub's maxRevalidate (revalidate clamps
// anything longer back down to it), so the guarantee is bought the other way
// round: leave the interval at its 30s default and assert inside 8s. The
// assertion below also fails if the close arrives late, so a future change to
// either constant that removes the gap breaks the test rather than quietly
// letting revalidate cover for a broken fanout.
const revokeAssertWindow = 8 * time.Second

func init() {
	// A compile-time-ish guard: if the two ever converge, these tests stop
	// proving anything and should fail loudly at startup instead.
	if revokeAssertWindow >= 30*time.Second {
		panic("revokeAssertWindow must stay well under the hub revalidation interval")
	}
}

// awaitRevoked asserts the socket is closed by a revocation — with the policy
// close code the hub uses for it — and that it happened inside the window.
func awaitRevoked(t *testing.T, ws *websocket.Conn, where string) {
	t.Helper()
	start := time.Now()
	// Read rather than wait: state frames may still be in flight, and the close
	// is the next thing after them. One deadline covers the whole window — a
	// gorilla read deadline is permanent once it fires, so it is set once here
	// and never re-armed mid-loop.
	ws.SetReadDeadline(start.Add(revokeAssertWindow))
	for {
		_, _, err := ws.ReadMessage()
		if err == nil {
			continue
		}
		elapsed := time.Since(start)
		var closeErr *websocket.CloseError
		if !errors.As(err, &closeErr) {
			t.Fatalf("%s: the socket was still open %s after the session was ended (read: %v). "+
				"Revalidate would eventually close it, but not inside this window — the revocation did not fan out",
				where, elapsed, err)
		}
		if closeErr.Code != websocket.ClosePolicyViolation {
			t.Fatalf("%s: socket closed with %d, want %d (the revocation close code)",
				where, closeErr.Code, websocket.ClosePolicyViolation)
		}
		if elapsed >= revokeAssertWindow {
			t.Fatalf("%s: socket took %s to close — that is revalidate territory, not fanout", where, elapsed)
		}
		return
	}
}

// The security property this whole change exists for. Ending a session deletes
// the token row on the replica that served the request, but the WebSocket it
// authenticated may be held by any other replica — each has its own in-process
// hub, and DisconnectToken only reaches the sockets of the process it runs in.
//
// Without a cross-replica revocation the socket on B stays authenticated until
// its revalidate goroutine next polls, up to 30 seconds later. Asserting inside
// revokeAssertWindow is what separates "revocation fanned out" from "revalidate
// eventually noticed".
func TestRevokeDisconnectsAClientOnAnotherReplica(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	_, member, id := setupSession(t, srvA, "Revoke Space")

	// B must be listening, or the notification is sent into a void and the test
	// would be measuring the reconnect path rather than the fanout.
	waitReady(t, srvB, true, 10*time.Second)

	wsB, _, err := dialWS(t, srvB, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()
	consumePresenceFrames(t, wsB)

	// The member logs out through A. A's hub holds none of their sockets.
	if resp, _ := doJSON(t, srvA, "DELETE", "/api/me", "", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete session on A: %d", resp.StatusCode)
	}

	awaitRevoked(t, wsB, "a session ended on instance A never closed the socket held by instance B")
}

// The local path must keep working unchanged: the replica that serves the
// logout still disconnects its own sockets directly, without waiting for the
// notification to come back around.
func TestRevokeDisconnectsAClientOnTheSameReplica(t *testing.T) {
	srvA := testServer(t)
	_ = secondInstance(t)

	_, member, id := setupSession(t, srvA, "Revoke Local Space")

	wsA, _, err := dialWS(t, srvA, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsA.Close()
	consumePresenceFrames(t, wsA)

	if resp, _ := doJSON(t, srvA, "DELETE", "/api/me", "", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete session on A: %d", resp.StatusCode)
	}

	awaitRevoked(t, wsA, "the replica that served the logout did not close its own socket")
}

// The originating replica hears the echo of its own revocation. It has to skip
// it: a second DisconnectToken for a token whose connections are already gone
// must not panic, and above all must not touch anybody else's sockets.
func TestRevokeIgnoresItsOwnEcho(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)
	waitReady(t, srvB, true, 10*time.Second)

	fac, member, id := setupSession(t, srvA, "Revoke Echo Space")

	// Both sockets on A, so the echo arrives at a replica that still holds a
	// live connection for a different principal.
	wsMember, _, err := dialWS(t, srvA, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsMember.Close()
	consumePresenceFrames(t, wsMember)

	wsFac, _, err := dialWS(t, srvA, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()

	if resp, _ := doJSON(t, srvA, "DELETE", "/api/me", "", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete session on A: %d", resp.StatusCode)
	}

	awaitRevoked(t, wsMember, "the revoked socket on the originating replica")

	// Well past the round trip the echo takes. The facilitator's socket must
	// still be usable: a listener that disconnects on its own echo, or one that
	// misparses the payload into some other token, shows up here as a closed or
	// erroring connection rather than as a passing test.
	time.Sleep(time.Second)
	if err := wsFac.WriteMessage(websocket.PingMessage, nil); err != nil {
		t.Fatalf("the facilitator's socket died while the revocation echoed: %v", err)
	}
	wsFac.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := wsFac.ReadMessage(); err != nil {
		var closeErr *websocket.CloseError
		if errors.As(err, &closeErr) {
			t.Fatalf("the facilitator's socket was closed (code %d) by somebody else's revocation", closeErr.Code)
		}
		// A read timeout is the expected quiet: nothing more to say on this
		// socket. Anything else would have been a close above.
	}
}
