package hub

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
