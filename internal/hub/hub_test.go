package hub

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

func TestExpiredTokenClosesConnectionWithPolicyViolation(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	ws := attachAuthenticatedTestConn(t, h, "room", SessionAuth{
		TokenID: "expiring", ExpiresAt: time.Now().Add(20 * time.Millisecond),
	})
	defer ws.Close()

	ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("expired token websocket remained open")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expired token close = %v, want policy violation", err)
	}
}

func TestSessionRevalidationClosesDatabaseRevokedToken(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.RevalidationInterval = 20 * time.Millisecond
	h.ValidateSession = func(context.Context, string) (time.Time, error) {
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
