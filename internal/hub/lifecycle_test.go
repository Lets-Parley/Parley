package hub

import (
	"context"
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
