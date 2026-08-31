package hub

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// attachWithInitial attaches one connection carrying an initial frame and
// returns the client end plus a channel closed once AttachAuthenticated has
// returned.
func attachWithInitial(t *testing.T, h *Hub, initial []byte, auth SessionAuth) (*websocket.Conn, <-chan struct{}) {
	t.Helper()
	attached := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, "room", "user", initial, auth)
		close(attached)
	}))
	t.Cleanup(srv.Close)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws, attached
}

// TestPresenceIsRecordedBeforeTheInitialFrame pins the ordering the roster
// tests depend on: a client holding its first state frame is entitled to
// assume its own presence row already exists. Releasing the snapshot
// concurrently with the presence write makes every "what does this guest see"
// assertion a coin flip.
func TestPresenceIsRecordedBeforeTheInitialFrame(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var seen atomic.Bool
	h.OnFacilitatorSeen = func(string, string) {
		// Stand in for the database round trip the API does here.
		time.Sleep(50 * time.Millisecond)
		seen.Store(true)
	}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}

	ws, _ := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, msg, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	} else if string(msg) != "snapshot" {
		t.Fatalf("initial frame = %q, want snapshot", msg)
	}
	if !seen.Load() {
		t.Fatal("the initial frame was delivered before presence was recorded: a client that has its first frame must already be in the roster")
	}
}

// TestShutdownWaitsForCallbacksTouchingTheDatabase pins the other half: every
// callback the hub launches writes to a pool the caller closes right after
// Shutdown returns, so a callback still in flight at that point is a write
// against a torn-down pool.
func TestShutdownWaitsForCallbacksTouchingTheDatabase(t *testing.T) {
	h := New()
	var running atomic.Int32
	slow := func() {
		running.Add(1)
		defer running.Add(-1)
		time.Sleep(100 * time.Millisecond)
	}
	h.OnDisconnect = func(string, string) { slow() }
	h.OnPresenceChange = func(string) { slow() }
	h.OnFacilitatorSeen = func(string, string) { slow() }

	ws := attachTestConn(t, h, "room")
	t.Cleanup(func() { ws.Close() })
	// Let the debounced presence timer fire so its callback is in flight too.
	time.Sleep(presenceDebounce + 200*time.Millisecond)

	h.Shutdown()
	if n := running.Load(); n != 0 {
		t.Fatalf("%d hub callbacks still running after Shutdown returned: each one is a write against a closed pool", n)
	}
}

// TestRejectedMembershipRecordsNoPresence pins the other end of that ordering:
// a connection the post-registration re-check rejects must never leave a
// presence row behind. Presence is what RedactForGuest filters the roster by,
// so a row written for a principal that is about to be torn down puts a
// non-member in the roster every other client sees.
func TestRejectedMembershipRecordsNoPresence(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var seen atomic.Bool
	h.OnFacilitatorSeen = func(string, string) { seen.Store(true) }
	// The handshake read said member; the re-check, after registration, sees
	// the removal that landed in between.
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return false, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, msg, err := ws.ReadMessage(); err == nil {
		t.Fatalf("a rejected connection received room state: %q", msg)
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("close = %v, want policy violation", err)
	}
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	if seen.Load() {
		t.Fatal("presence was recorded for a connection the membership re-check rejected: it can appear in another client's roster until OnDisconnect clears it")
	}
}

// TestJoinFiresOnAttachNotOnPong pins that session belonging is recorded once
// at attach when that write succeeds. The pong path still refreshes presence
// (OnFacilitatorSeen) but must not re-run the durable participant write after
// a successful attach.
func TestJoinFiresOnAttachNotOnPong(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins, seens atomic.Int32
	h.OnJoin = func(string, string) error { joins.Add(1); return nil }
	h.OnFacilitatorSeen = func(string, string) { seens.Add(1) }
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin fired %d time(s) on attach, want 1", n)
	}
	if n := seens.Load(); n != 1 {
		t.Fatalf("OnFacilitatorSeen fired %d time(s) on attach, want 1", n)
	}

	if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && seens.Load() < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if n := seens.Load(); n != 2 {
		t.Fatalf("OnFacilitatorSeen after pong = %d, want 2", n)
	}
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin fired on pong (%d total); belonging must stay attach-only after success", n)
	}
}

// TestJoinRetriesOnPongAfterAttachFailure: a failed attach must not leave the
// connection invisible to open-voting snapshots. Pong retries OnJoin until it
// succeeds, then stops probing.
func TestJoinRetriesOnPongAfterAttachFailure(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins atomic.Int32
	h.OnJoin = func(string, string) error {
		n := joins.Add(1)
		if n == 1 {
			return fmt.Errorf("transient")
		}
		return nil
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin on attach = %d, want 1", n)
	}

	if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && joins.Load() < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if n := joins.Load(); n != 2 {
		t.Fatalf("OnJoin after first pong = %d, want 2 (one retry)", n)
	}

	if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := joins.Load(); n != 2 {
		t.Fatalf("OnJoin after successful retry = %d, want 2 (no further probes)", n)
	}
}

// A persistent OnJoin failure must not reintroduce a durable write on every
// heartbeat forever. After the attempt bound the pong path stops calling
// OnJoin even though joined stays false.
func TestJoinRetryStopsAfterBound(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins atomic.Int32
	h.OnJoin = func(string, string) error {
		joins.Add(1)
		return fmt.Errorf("persistent")
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin on attach = %d, want 1", n)
	}

	for i := 0; i < maxJoinAttempts+2; i++ {
		if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) && joins.Load() < int32(i+2) && joins.Load() < int32(maxJoinAttempts) {
			time.Sleep(10 * time.Millisecond)
		}
		// Let a tracked retry finish even when it is the one that hits the bound.
		time.Sleep(50 * time.Millisecond)
	}
	if n := joins.Load(); n != int32(maxJoinAttempts) {
		t.Fatalf("OnJoin after persistent failure = %d, want exactly %d (bounded); further pongs must not keep probing", n, maxJoinAttempts)
	}
}

// A pong retry must not re-insert someone who lost membership after attach.
// membershipConfirmed stays true until revalidation closes the socket; without
// an eligibility re-check the retry would call OnJoin and resurrect them in
// session_participants.
func TestJoinRetrySkipsWhenNoLongerEligible(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins atomic.Int32
	var eligible atomic.Bool
	eligible.Store(true)
	h.OnJoin = func(string, string) error {
		joins.Add(1)
		return fmt.Errorf("transient")
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return eligible.Load(), nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin on attach = %d, want 1", n)
	}

	eligible.Store(false)
	if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin after removal = %d, want 1; pong must not retry Join for an ineligible user", n)
	}
}

// TestPongDuringMembershipConfirmationRecordsNoPresence pins the window
// between the auth-state flip and confirmMembership returning: authState is
// already authAccepted there, but the connection has not yet cleared the
// membership re-check. A pong landing in that window must not call
// OnFacilitatorSeen — that write would put a principal about to be rejected
// back into the roster, exactly what this PR's reordering is meant to
// prevent.
func TestPongDuringMembershipConfirmationRecordsNoPresence(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	confirmStarted := make(chan struct{})
	releaseConfirm := make(chan struct{})
	var seenCount atomic.Int32
	h.OnFacilitatorSeen = func(string, string) { seenCount.Add(1) }
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		close(confirmStarted)
		<-releaseConfirm
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-confirmStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("confirmMembership did not start")
	}

	if err := ws.WriteControl(websocket.PongMessage, []byte("mid-confirm"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// Give the reader goroutine a chance to run the pong handler while
	// confirmMembership is still blocked.
	time.Sleep(50 * time.Millisecond)
	if n := seenCount.Load(); n != 0 {
		t.Fatalf("OnFacilitatorSeen fired %d time(s) from a pong that landed before membership was confirmed", n)
	}

	close(releaseConfirm)
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, msg, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	} else if string(msg) != "snapshot" {
		t.Fatalf("initial frame = %q, want snapshot", msg)
	}
	if n := seenCount.Load(); n != 1 {
		t.Fatalf("OnFacilitatorSeen fired %d time(s), want exactly 1 (the attach-time call)", n)
	}
}

// TestRejectedMembershipWithNoSnapshotIsStillTornDown pins the case with no
// initial frame at all: the re-check runs whenever gatesInitialState holds,
// not only when the handshake built a snapshot to release. A non-member
// socket carrying no snapshot must still be torn down, not left open waiting
// for the next revalidation tick.
func TestRejectedMembershipWithNoSnapshotIsStillTornDown(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return false, nil
	}

	ws, attached := attachWithInitial(t, h, nil, SessionAuth{SpaceID: "space"})
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, msg, err := ws.ReadMessage(); err == nil {
		t.Fatalf("a rejected connection with no snapshot stayed open and received %q", msg)
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("close = %v, want policy violation", err)
	}
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
}

// TestBroadcastBeforeTheInitialFrameIsNotDelivered pins the window between
// registration and the presence write. The shared guest payload a broadcast
// carries is redacted with no self id, so a link guest served one before its
// presence row exists is told it is not in the room it is in. The seam is the
// presence callback itself, which fires inside the window: a broadcast made
// there must not reach a connection still waiting for its snapshot. Nothing is
// lost by dropping it — the initial frame is delivered afterwards and would
// have overwritten it anyway.
func TestBroadcastBeforeTheInitialFrameIsNotDelivered(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.OnFacilitatorSeen = func(sessionID, _ string) {
		h.BroadcastGuest(sessionID, []byte("full"), []byte("guest-without-self"))
	}

	ws, _ := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{Guest: true})
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("reading the first frame: %v", err)
	}
	if string(msg) != "snapshot" {
		t.Fatalf("first frame = %q, want snapshot: a guest was broadcast a roster built before its presence row existed, which omits its own seat", msg)
	}
}

// A transient eligibility-check failure must not strand a live connection. The
// bound still applies — an error consumes an attempt — but the connection stays
// retryable, so a database that recovers brings the participants row back
// instead of leaving a still-connected voter out of every later snapshot.
func TestJoinRetrySurvivesTransientEligibilityError(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins atomic.Int32
	var failing atomic.Bool
	h.OnJoin = func(string, string) error {
		if joins.Add(1) == 1 {
			return fmt.Errorf("attach blip")
		}
		return nil
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		if failing.Load() {
			return false, fmt.Errorf("database unreachable")
		}
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}

	// The database goes away after attach, so the pong-path eligibility re-check
	// errors. That pong must not call OnJoin and must not permanently abandon
	// the connection.
	failing.Store(true)
	pong(t, ws)
	time.Sleep(150 * time.Millisecond)
	if n := joins.Load(); n != 1 {
		t.Fatalf("OnJoin during eligibility error = %d, want 1 (attach only)", n)
	}

	// The database recovers. The next pong must retry and succeed.
	failing.Store(false)
	pong(t, ws)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && joins.Load() < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if n := joins.Load(); n != 2 {
		t.Fatalf("OnJoin after the eligibility check recovered = %d, want 2; a transient error must not strand the connection", n)
	}
}

// Attempts are bounded per window, not for the life of the connection. Once the
// window elapses a recovered database can bring the connection back; without
// this a brief blip leaves a still-connected member out of open-voting
// snapshots until they happen to reconnect.
func TestJoinRetryResumesAfterWindow(t *testing.T) {
	restore := joinRetryWindow
	joinRetryWindow = 2 * time.Second
	t.Cleanup(func() { joinRetryWindow = restore })

	h := New()
	t.Cleanup(h.Shutdown)
	var joins atomic.Int32
	h.OnJoin = func(string, string) error {
		joins.Add(1)
		return fmt.Errorf("persistent")
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}

	for i := 0; i < maxJoinAttempts+2; i++ {
		pong(t, ws)
		time.Sleep(20 * time.Millisecond)
	}
	if n := joins.Load(); n != int32(maxJoinAttempts) {
		t.Fatalf("OnJoin within one window = %d, want %d", n, maxJoinAttempts)
	}

	time.Sleep(joinRetryWindow + 200*time.Millisecond)
	pong(t, ws)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && joins.Load() <= int32(maxJoinAttempts) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := joins.Load(); n <= int32(maxJoinAttempts) {
		t.Fatalf("OnJoin after the retry window elapsed = %d, want more than %d; an exhausted connection must recover", n, maxJoinAttempts)
	}
}

func pong(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	if err := ws.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
}

// The attempt bound covers the eligibility re-check, not just the join write.
// That check is itself a database read, so a persistently failing connection
// that kept running it would still query on every heartbeat — the traffic the
// bound exists to stop.
func TestJoinRetryStopsCheckingEligibilityWhenExhausted(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	var joins, checks atomic.Int32
	h.OnJoin = func(string, string) error {
		joins.Add(1)
		return fmt.Errorf("persistent")
	}
	h.OnFacilitatorSeen = func(string, string) {}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		checks.Add(1)
		return true, nil
	}

	ws, attached := attachWithInitial(t, h, []byte("snapshot"), SessionAuth{SpaceID: "space"})
	select {
	case <-attached:
	case <-time.After(3 * time.Second):
		t.Fatal("AttachAuthenticated did not return")
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("reading the initial frame: %v", err)
	}

	for i := 0; i < maxJoinAttempts; i++ {
		pong(t, ws)
		time.Sleep(50 * time.Millisecond)
	}
	if n := joins.Load(); n != int32(maxJoinAttempts) {
		t.Fatalf("OnJoin = %d, want %d before the extra pongs", n, maxJoinAttempts)
	}
	settled := checks.Load()

	// Every further heartbeat must be free of database work.
	for i := 0; i < 3; i++ {
		pong(t, ws)
		time.Sleep(50 * time.Millisecond)
	}
	if n := checks.Load(); n != settled {
		t.Fatalf("ValidateMembership calls after the bound = %d, want %d; an exhausted connection must not read the database every heartbeat", n, settled)
	}
}
