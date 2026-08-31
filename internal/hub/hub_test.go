package hub

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

func attachTestConn(t *testing.T, h *Hub, sessionID string) *websocket.Conn {
	return attachAuthenticatedTestConn(t, h, sessionID, SessionAuth{})
}

func attachAuthenticatedTestConn(t *testing.T, h *Hub, sessionID string, auth SessionAuth) *websocket.Conn {
	t.Helper()
	attached := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, sessionID, "user", nil, auth)
		close(attached)
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("server did not attach websocket")
	}
	return ws
}

func TestUnregisterAndBroadcastRemainRaceFree(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)

	for i := 0; i < 100; i++ {
		ws := attachTestConn(t, h, "room")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			ws.Close()
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				h.Broadcast("room", []byte("state"))
			}
		}()
		wg.Wait()
	}

	// The race must not poison the owner loop: later connections still register
	// and receive ordinary broadcasts.
	ws := attachTestConn(t, h, "after-race")
	defer ws.Close()
	h.Broadcast("after-race", []byte("still-live"))
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read after unregister/broadcast race: %v", err)
	}
	if string(got) != "still-live" {
		t.Fatalf("broadcast after race = %q, want still-live", got)
	}
}

func TestBlockedWriterDoesNotStallOwnerLoop(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachTestConn(t, h, "blocked-room")
	defer ws.Close()

	var conn *Conn
	for c := range h.rooms["blocked-room"] {
		conn = c
	}
	if conn == nil {
		t.Fatal("attached connection not found")
	}
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	originalWrite := conn.writeMessage
	conn.writeMessage = func(messageType int, data []byte) error {
		if messageType == websocket.TextMessage {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
		}
		return originalWrite(messageType, data)
	}

	h.Broadcast("blocked-room", []byte("in-flight"))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("writer did not begin the blocked write")
	}
	for i := 0; i < sendBuffer; i++ {
		h.Broadcast("blocked-room", []byte("queued"))
	}

	overflowDone := make(chan struct{})
	go func() {
		h.Broadcast("blocked-room", []byte("overflow"))
		close(overflowDone)
	}()
	snapshotDone := make(chan struct{})
	go func() {
		h.Connected("another-room")
		close(snapshotDone)
	}()

	select {
	case <-snapshotDone:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("blocked writer stalled an unrelated owner-loop snapshot")
	}
	select {
	case <-overflowDone:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("overflow removal waited for blocked socket I/O")
	}
}

func TestShutdownAndBroadcastRemainRaceFree(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachTestConn(t, h, "room")
	defer ws.Close()

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 100; j++ {
				h.Broadcast("room", []byte("state"))
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		h.Shutdown()
	}()
	close(start)
	wg.Wait()

	// Public operations after shutdown remain safe and return promptly.
	h.Broadcast("room", []byte("after-shutdown"))
	if got := h.Connected("room"); len(got) != 0 {
		t.Fatalf("connected after shutdown = %v, want none", got)
	}
}

func TestDisconnectTokenClosesOnlyMatchingConnections(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	wsRevoked := attachAuthenticatedTestConn(t, h, "room", SessionAuth{TokenID: "revoked"})
	defer wsRevoked.Close()
	wsOther := attachAuthenticatedTestConn(t, h, "room", SessionAuth{TokenID: "other"})
	defer wsOther.Close()

	h.DisconnectToken("revoked")

	wsRevoked.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := wsRevoked.ReadMessage(); err == nil {
		t.Fatal("revoked token websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("revoked token close = %v, want policy violation", err)
	}

	h.Broadcast("room", []byte("still-connected"))
	wsOther.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := wsOther.ReadMessage()
	if err != nil {
		t.Fatalf("unrelated token websocket closed: %v", err)
	}
	if string(got) != "still-connected" {
		t.Fatalf("unrelated token broadcast = %q, want still-connected", got)
	}
}

func TestBlockingConnectCallbackCannotDeadlockDisconnect(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	callbackStarted := make(chan struct{})
	releaseCallback := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseCallback) }) }
	defer release()
	h.OnFacilitatorSeen = func(string, string) {
		close(callbackStarted)
		<-releaseCallback
	}
	attachReturned := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, "room", "user", nil, SessionAuth{TokenID: "callback-token"})
		close(attachReturned)
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	select {
	case <-callbackStarted:
	case <-time.After(time.Second):
		t.Fatal("connect callback did not start")
	}

	disconnected := make(chan struct{})
	go func() {
		h.DisconnectToken("callback-token")
		close(disconnected)
	}()
	select {
	case <-disconnected:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("disconnect waited for a writer that had not been started")
	}

	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("disconnected websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("disconnected websocket close = %v, want policy violation", err)
	}
	release()
	select {
	case <-attachReturned:
	case <-time.After(time.Second):
		t.Fatal("attach did not return after callback release")
	}
}

func TestDisconnectDropsQueuedFramesAndWaitsForWriterClose(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{TokenID: "revoked-with-queue"})
	defer ws.Close()

	var conn *Conn
	for c := range h.rooms["room"] {
		conn = c
	}
	if conn == nil {
		t.Fatal("attached connection not found")
	}

	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	originalWrite := conn.writeMessage
	conn.writeMessage = func(messageType int, data []byte) error {
		if messageType == websocket.TextMessage {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
		}
		return originalWrite(messageType, data)
	}
	h.Broadcast("room", []byte("in-flight"))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("writer did not begin the in-flight frame")
	}
	deadline := time.Now().Add(time.Second)
	h.Broadcast("room", []byte("queued"))

	disconnected := make(chan struct{})
	go func() {
		h.DisconnectToken("revoked-with-queue")
		close(disconnected)
	}()
	for !conn.removed.Load() && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	if !conn.removed.Load() {
		t.Fatal("disconnect did not begin removal")
	}
	unblock()

	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("DisconnectToken returned before writer shutdown completed")
	}
	select {
	case <-conn.writerDone:
	default:
		t.Fatal("DisconnectToken returned before writer completion")
	}

	ws.SetReadDeadline(time.Now().Add(time.Second))
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
				t.Fatalf("revoked token close = %v, want policy violation", err)
			}
			break
		}
		if string(msg) == "queued" {
			t.Fatal("queued application frame was written after revocation")
		}
	}
}

func TestAttachAfterDisconnectUsesDatabaseAuthority(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	validated := make(chan struct{})
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		select {
		case <-validated:
		default:
			close(validated)
		}
		return time.Time{}, errors.New("revoked in shared store")
	}
	h.DisconnectToken("already-revoked")

	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "already-revoked", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	select {
	case <-validated:
	case <-time.After(time.Second):
		t.Fatal("post-disconnect attach relied on a local tombstone instead of shared-store validation")
	}
	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("database-revoked token websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("database-revoked token close = %v, want policy violation", err)
	}
}

func TestPendingValidationCancelsWhenPeerDisconnects(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	validationStarted := make(chan struct{})
	validationCanceled := make(chan struct{})
	h.ValidateSession = func(ctx context.Context, _ string) (time.Time, error) {
		close(validationStarted)
		<-ctx.Done()
		close(validationCanceled)
		return time.Time{}, ctx.Err()
	}
	attachReturned := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, "room", "user", nil, SessionAuth{TokenID: "pending-peer"})
		close(attachReturned)
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-validationStarted:
	case <-time.After(time.Second):
		t.Fatal("validation did not start")
	}
	ws.Close()

	select {
	case <-validationCanceled:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("peer disconnect did not cancel pending validation")
	}
	select {
	case <-attachReturned:
	case <-time.After(time.Second):
		t.Fatal("attach remained blocked after pending peer disconnected")
	}
}

func TestFacilitatorPongCallbackRequiresAcceptedConnection(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	validationStarted := make(chan struct{})
	validationCanceled := make(chan struct{})
	h.ValidateSession = func(ctx context.Context, tokenID string) (time.Time, error) {
		if tokenID == "accepted-pong" {
			return time.Now().Add(time.Hour), nil
		}
		close(validationStarted)
		<-ctx.Done()
		close(validationCanceled)
		return time.Time{}, ctx.Err()
	}
	seen := make(chan struct{}, 2)
	h.OnFacilitatorSeen = func(string, string) {
		seen <- struct{}{}
	}
	attachReturned := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, "room", "user", nil, SessionAuth{TokenID: "pending-pong"})
		close(attachReturned)
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-validationStarted:
	case <-time.After(time.Second):
		t.Fatal("validation did not start")
	}
	if err := ws.WriteControl(websocket.PongMessage, []byte("pending"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	ws.Close()
	select {
	case <-validationCanceled:
	case <-time.After(time.Second):
		t.Fatal("peer disconnect did not cancel pending validation")
	}
	select {
	case <-attachReturned:
	case <-time.After(time.Second):
		t.Fatal("pending attach did not return")
	}
	select {
	case <-seen:
		t.Fatal("pending websocket published facilitator liveness from Pong")
	default:
	}

	accepted := attachAuthenticatedTestConn(t, h, "room", SessionAuth{TokenID: "accepted-pong"})
	defer accepted.Close()
	select {
	case <-seen:
	case <-time.After(time.Second):
		t.Fatal("accepted websocket did not publish initial facilitator liveness")
	}
	if err := accepted.WriteControl(websocket.PongMessage, []byte("accepted"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-seen:
	case <-time.After(time.Second):
		t.Fatal("accepted websocket Pong did not publish facilitator liveness")
	}
}

func TestPendingValidationTimesOut(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.ValidationTimeout = 20 * time.Millisecond
	validationErr := make(chan error, 1)
	h.ValidateSession = func(ctx context.Context, _ string) (time.Time, error) {
		<-ctx.Done()
		validationErr <- ctx.Err()
		return time.Time{}, ctx.Err()
	}
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "stalled-validation", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	select {
	case err := <-validationErr:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("validation ended with %v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled validation did not time out")
	}
	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("timed-out validation left websocket open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("timed-out validation close = %v, want policy violation", err)
	}
}

func TestExpiredTokenClosesAfterDatabaseRejectsIt(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	soon := time.Now().Add(20 * time.Millisecond)
	var calls atomic.Int32
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		if calls.Add(1) == 1 {
			return soon, nil
		}
		return time.Time{}, errors.New("expired")
	}
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "expiring", ExpiresAt: soon,
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("expired token websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expired token close = %v, want policy violation", err)
	}
}

func TestStaleSuccessfulValidationDoesNotEvictRefreshedToken(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	soon := time.Now().Add(40 * time.Millisecond)
	refreshed := make(chan struct{})
	var calls atomic.Int32
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		switch calls.Add(1) {
		case 1, 2:
			return soon, nil
		default:
			select {
			case <-refreshed:
			default:
				close(refreshed)
			}
			return time.Now().Add(time.Hour), nil
		}
	}
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "refreshed", ExpiresAt: soon,
	})
	defer ws.Close()

	select {
	case <-refreshed:
	case <-time.After(time.Second):
		t.Fatal("hub did not recheck a successful validation whose observed expiry became stale")
	}
	h.Broadcast("room", []byte("still-valid"))
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("refreshed token websocket closed: %v", err)
	}
	if string(got) != "still-valid" {
		t.Fatalf("broadcast after refresh = %q, want still-valid", got)
	}
}

func TestLocallyExpiredTokenWaitsForDatabaseValidation(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	validated := make(chan struct{})
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		select {
		case <-validated:
		default:
			close(validated)
		}
		return time.Now().Add(time.Hour), nil
	}
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "locally-stale", ExpiresAt: time.Now().Add(-time.Second),
	})
	defer ws.Close()

	select {
	case <-validated:
	case <-time.After(time.Second):
		t.Fatal("locally expired token was not checked against the database")
	}
	h.Broadcast("room", []byte("database-valid"))
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("database-valid websocket closed from local expiry: %v", err)
	}
	if string(got) != "database-valid" {
		t.Fatalf("broadcast after database validation = %q, want database-valid", got)
	}
}

func TestSessionRevalidationClosesDatabaseRevokedToken(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.RevalidationInterval = 20 * time.Millisecond
	var calls atomic.Int32
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		if calls.Add(1) == 1 {
			return time.Now().Add(time.Hour), nil
		}
		return time.Time{}, errors.New("no session for token")
	}
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "externally-revoked", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("database-revoked token websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("database-revoked token close = %v, want policy violation", err)
	}
}

func TestSessionsListsEveryRoomHeld(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	if got := h.Sessions(); len(got) != 0 {
		t.Fatalf("a new hub holds no rooms, got %v", got)
	}

	c1 := attachTestConn(t, h, "room-1")
	defer c1.Close()
	c2 := attachTestConn(t, h, "room-2")
	defer c2.Close()

	got := h.Sessions()
	sort.Strings(got)
	if len(got) != 2 || got[0] != "room-1" || got[1] != "room-2" {
		t.Fatalf("Sessions() = %v, want both rooms — the notification listener resyncs from this, so a room missing here is a room that never catches up after a reconnect", got)
	}

	c1.Close()
	// Sessions() runs on the owner loop, so it observes the unregister once the
	// server side has processed the peer going away.
	deadline := time.Now().Add(2 * time.Second)
	for {
		got = h.Sessions()
		if len(got) == 1 && got[0] == "room-2" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Sessions() = %v after the last connection to room-1 closed, want only room-2", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// attachMemberTestConn is attachAuthenticatedTestConn with a caller-chosen
// user id, which membership-scoped disconnects need in order to tell two
// connections in the same room apart.
func attachMemberTestConn(t *testing.T, h *Hub, sessionID, userID string, auth SessionAuth) *websocket.Conn {
	t.Helper()
	attached := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, sessionID, userID, nil, auth)
		close(attached)
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("server did not attach websocket")
	}
	return ws
}

func TestDisconnectSpaceMemberClosesOnlyThatMembersSockets(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	removed := attachMemberTestConn(t, h, "room", "bob", SessionAuth{TokenID: "bob-token", SpaceID: "space-1"})
	defer removed.Close()
	stays := attachMemberTestConn(t, h, "room", "ada", SessionAuth{TokenID: "ada-token", SpaceID: "space-1"})
	defer stays.Close()
	elsewhere := attachMemberTestConn(t, h, "other-room", "bob", SessionAuth{TokenID: "bob-token", SpaceID: "space-2"})
	defer elsewhere.Close()

	h.DisconnectSpaceMember("space-1", "bob")

	removed.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := removed.ReadMessage(); err == nil {
		t.Fatal("the removed member's websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("removed member close = %v, want policy violation", err)
	}

	// The same person in a different space, and a different person in the
	// same space, are both untouched.
	h.Broadcast("room", []byte("still-connected"))
	stays.SetReadDeadline(time.Now().Add(time.Second))
	if _, got, err := stays.ReadMessage(); err != nil {
		t.Fatalf("another member of the space was disconnected: %v", err)
	} else if string(got) != "still-connected" {
		t.Fatalf("broadcast to the remaining member = %q, want still-connected", got)
	}
	h.Broadcast("other-room", []byte("other-space"))
	elsewhere.SetReadDeadline(time.Now().Add(time.Second))
	if _, got, err := elsewhere.ReadMessage(); err != nil {
		t.Fatalf("the same user was disconnected from an unrelated space: %v", err)
	} else if string(got) != "other-space" {
		t.Fatalf("broadcast to the unrelated space = %q, want other-space", got)
	}
}

// TestSessionRevalidationClosesARemovedMember is the multi-process half:
// DisconnectSpaceMember only reaches sockets held by the process that served
// the removal, so every other replica has to notice at its next tick.
func TestSessionRevalidationClosesARemovedMember(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.RevalidationInterval = 20 * time.Millisecond
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		return time.Now().Add(time.Hour), nil
	}
	var calls atomic.Int32
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return calls.Add(1) == 1, nil
	}
	ws := attachMemberTestConn(t, h, "room", "bob", SessionAuth{
		TokenID: "live-token", SpaceID: "space-1", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("a member removed on another process kept their websocket")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("revalidated-away member close = %v, want policy violation", err)
	}
}

// attachMemberTestConnWithState is attachMemberTestConn for a connection that
// is owed an initial room snapshot, which is what the mid-handshake removal
// race is about.
func attachMemberTestConnWithState(t *testing.T, h *Hub, sessionID, userID string, initial []byte, auth SessionAuth) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, sessionID, userID, initial, auth)
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

// TestMembershipRevalidationKeepsAMemberConnected is the positive half of the
// membership guard. Its companion, TestSessionRevalidationClosesARemovedMember,
// still passes if the guard's polarity is inverted — an inverted guard rejects
// the handshake, which also ends in a policy-violation close — so only this
// test tells the two apart.
func TestMembershipRevalidationKeepsAMemberConnected(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.RevalidationInterval = 20 * time.Millisecond
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		return time.Now().Add(time.Hour), nil
	}
	var calls atomic.Int32
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		calls.Add(1)
		return true, nil
	}
	ws := attachMemberTestConn(t, h, "room", "ada", SessionAuth{
		TokenID: "live-token", SpaceID: "space-1", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	// Several revalidation ticks must pass without the socket being touched.
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if calls.Load() >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := calls.Load(); got < 3 {
		t.Fatalf("membership was revalidated %d times, want at least 3", got)
	}

	h.Broadcast("room", []byte("still-a-member"))
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("a still-valid member lost their websocket: %v", err)
	}
	if string(got) != "still-a-member" {
		t.Fatalf("broadcast to a still-valid member = %q, want still-a-member", got)
	}
}

// TestRemovalDuringHandshakeShipsNoRoomState covers the mid-upgrade window: the
// membership read that authorized the handshake can be a hair older than the
// removal that commits during it. The connection must be re-checked once it is
// registered, so the removed user never receives the room snapshot.
func TestRemovalDuringHandshakeShipsNoRoomState(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		return time.Now().Add(time.Hour), nil
	}
	// True for the handshake read, false afterwards: the removal landed
	// between the two.
	var calls atomic.Int32
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return calls.Add(1) == 1, nil
	}

	ws := attachMemberTestConnWithState(t, h, "room", "bob", []byte(`{"deck":[1,2,3]}`), SessionAuth{
		TokenID: "live-token", SpaceID: "space-1", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err == nil {
		t.Fatalf("a member removed mid-handshake received room state: %q", msg)
	}
	closeErr, ok := err.(*websocket.CloseError)
	if !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("mid-handshake removal close = %v, want policy violation", err)
	}
	if calls.Load() < 2 {
		t.Fatalf("membership was read %d times, want a re-check after registration", calls.Load())
	}
}

// TestConfirmedMembershipStillDeliversRoomState is the control for the
// re-check: the ordinary connect path must still get its snapshot.
func TestConfirmedMembershipStillDeliversRoomState(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
		return time.Now().Add(time.Hour), nil
	}
	h.ValidateMembership = func(context.Context, string, string, string) (bool, error) {
		return true, nil
	}
	ws := attachMemberTestConnWithState(t, h, "room", "ada", []byte(`{"deck":[1,2,3]}`), SessionAuth{
		TokenID: "live-token", SpaceID: "space-1", ExpiresAt: time.Now().Add(time.Hour),
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("a confirmed member never received the room snapshot: %v", err)
	}
	if string(msg) != `{"deck":[1,2,3]}` {
		t.Fatalf("initial frame = %q, want the room snapshot", msg)
	}
}

// A deleted room has no membership row whose absence the revalidation tick
// could notice, so DisconnectSession is the only thing that closes its
// sockets — and it must close exactly its own.
func TestDisconnectSessionClosesOnlyThatRoom(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	wsGone := attachAuthenticatedTestConn(t, h, "deleted", SessionAuth{TokenID: "a"})
	defer wsGone.Close()
	wsOther := attachAuthenticatedTestConn(t, h, "kept", SessionAuth{TokenID: "b"})
	defer wsOther.Close()

	h.DisconnectSession("deleted")

	wsGone.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := wsGone.ReadMessage(); err == nil {
		t.Fatal("the deleted room's websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.CloseGoingAway {
		t.Fatalf("close = %v, want going away", err)
	}

	h.Broadcast("kept", []byte("still-connected"))
	wsOther.SetReadDeadline(time.Now().Add(time.Second))
	_, got, err := wsOther.ReadMessage()
	if err != nil {
		t.Fatalf("an unrelated room's websocket closed: %v", err)
	}
	if string(got) != "still-connected" {
		t.Fatalf("unrelated broadcast = %q, want still-connected", got)
	}
}

// attachTestConnAs is attachAuthenticatedTestConn with the user id spelled out.
// The removal tests turn on who holds a socket, not just which room it is in.
func attachTestConnAs(t *testing.T, h *Hub, sessionID, userID string) *websocket.Conn {
	t.Helper()
	attached := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.AttachAuthenticated(ws, sessionID, userID, nil, SessionAuth{})
		close(attached)
	}))
	t.Cleanup(srv.Close)

	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("server did not attach websocket")
	}
	return ws
}

// expectRemoved asserts a socket was closed by a facilitator removal, carrying
// the application close code and the message intact.
func expectRemoved(t *testing.T, ws *websocket.Conn, label, reason string) {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := ws.ReadMessage()
	closeErr, ok := err.(*websocket.CloseError)
	if !ok {
		t.Fatalf("%s: close = %v, want a close frame", label, err)
	}
	if closeErr.Code != CloseRemovedFromSession {
		t.Fatalf("%s: close code = %d, want %d", label, closeErr.Code, CloseRemovedFromSession)
	}
	if closeErr.Text != reason {
		t.Fatalf("%s: close reason = %q, want %q", label, closeErr.Text, reason)
	}
}

func TestDisconnectSessionMemberClosesOnlyThatUsersSocketsInThatRoom(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)

	// Two tabs, same person, same room. Both have to go.
	tabA := attachTestConnAs(t, h, "room", "kicked")
	defer tabA.Close()
	tabB := attachTestConnAs(t, h, "room", "kicked")
	defer tabB.Close()
	// The same person, a different room — untouched.
	elsewhere := attachTestConnAs(t, h, "other-room", "kicked")
	defer elsewhere.Close()
	// Somebody else in the same room — untouched.
	bystander := attachTestConnAs(t, h, "room", "stayer")
	defer bystander.Close()

	const reason = "please rejoin after the demo"
	h.DisconnectSessionMember("room", "kicked", reason)

	expectRemoved(t, tabA, "first tab", reason)
	expectRemoved(t, tabB, "second tab", reason)

	h.Broadcast("room", []byte("still-here"))
	h.Broadcast("other-room", []byte("still-here"))
	for label, ws := range map[string]*websocket.Conn{"bystander": bystander, "other room": elsewhere} {
		ws.SetReadDeadline(time.Now().Add(time.Second))
		_, got, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("%s socket closed: %v", label, err)
		}
		if string(got) != "still-here" {
			t.Fatalf("%s frame = %q, want still-here", label, got)
		}
	}
}

func TestDisconnectSessionMemberRequiresBothIds(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachTestConnAs(t, h, "room", "user")
	defer ws.Close()

	h.DisconnectSessionMember("", "user", "")
	h.DisconnectSessionMember("room", "", "")

	h.Broadcast("room", []byte("still-here"))
	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, got, err := ws.ReadMessage(); err != nil || string(got) != "still-here" {
		t.Fatalf("a wildcard removal closed a socket: %q %v", got, err)
	}
}

func TestCloseReasonIsTruncatedOnARuneBoundary(t *testing.T) {
	// Three-byte runes, so a naive byte slice at 123 lands mid-character.
	long := strings.Repeat("あ", 60)
	got := TruncateCloseReason(long)
	if len(got) > 123 {
		t.Fatalf("truncated reason is %d bytes, want at most 123", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatalf("truncated reason is not valid UTF-8: %q", got)
	}
	if want := strings.Repeat("あ", 41); got != want {
		t.Fatalf("truncated reason = %q, want %q", got, want)
	}
	if short := "short enough"; TruncateCloseReason(short) != short {
		t.Fatal("a reason within the limit was altered")
	}
}

func TestDisconnectSessionMemberTruncatesTheReason(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachTestConnAs(t, h, "room", "kicked")
	defer ws.Close()

	long := strings.Repeat("あ", 60)
	h.DisconnectSessionMember("room", "kicked", long)
	// gorilla rejects a control frame over 125 bytes outright, so an
	// untruncated reason would arrive as no close frame at all.
	expectRemoved(t, ws, "over-long reason", strings.Repeat("あ", 41))
}
