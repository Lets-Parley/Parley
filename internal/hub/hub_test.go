package hub

import (
	"sync"
	"testing"
)

// newConn builds a connection with no websocket behind it. Send, Close and
// Broadcast never touch c.ws, so the crash path is reachable without one.
func newConn(userID string) *Conn {
	return &Conn{UserID: userID, SessionID: "sess-1", send: make(chan []byte, sendBuffer)}
}

func (h *Hub) seat(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[c.SessionID]
	if room == nil {
		room = make(map[*Conn]struct{})
		h.rooms[c.SessionID] = room
	}
	room[c] = struct{}{}
}

// drain keeps the buffer from filling, so Send's `default:` arm never fires
// and the only way to reach a closed channel is the race under test.
func drain(c *Conn) *sync.WaitGroup {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range c.send {
		}
	}()
	return &wg
}

// Broadcast snapshots the room under the mutex and then writes without it, so
// a connection can be closed in the window between the two. Sending on a
// closed channel panics, and the presence path runs Broadcast inside a
// time.AfterFunc goroutine, where nothing recovers it — so this crash takes
// the whole process down, not just one request.
func TestBroadcastToAConnectionClosedMidFlightDoesNotPanic(t *testing.T) {
	h := New()
	c := newConn("dana")
	h.seat(c)
	wg := drain(c)

	c.Close() // the reader's detach wins the race

	h.Broadcast("sess-1", []byte(`{"version":2}`)) // must not panic
	wg.Wait()
}

func TestSendAfterCloseIsADroppedFrameNotACrash(t *testing.T) {
	c := newConn("dana")
	wg := drain(c)
	c.Close()
	for i := 0; i < 10; i++ {
		c.Send([]byte("frame"))
	}
	wg.Wait()
}

// The room must survive one connection dying: everybody else still gets the
// frame. A panic here would take the sender down mid-loop and silently strand
// every conn after it.
func TestBroadcastReachesLiveConnectionsWhenOneIsClosed(t *testing.T) {
	h := New()
	dead, live := newConn("dana"), newConn("marcus")
	h.seat(dead)
	h.seat(live)
	wgDead := drain(dead)
	dead.Close()

	h.Broadcast("sess-1", []byte("frame"))

	select {
	case got := <-live.send:
		if string(got) != "frame" {
			t.Fatalf("live connection got %q, want %q", got, "frame")
		}
	default:
		t.Fatal("live connection received nothing; the closed one broke the loop")
	}
	wgDead.Wait()
}

// The race as it actually happens: a broadcast in flight while connections
// disconnect. Run under -race. A panic in either goroutine fails the binary.
func TestBroadcastRacingDisconnects(t *testing.T) {
	for round := 0; round < 200; round++ {
		h := New()
		conns := make([]*Conn, 64)
		var drains []*sync.WaitGroup
		for i := range conns {
			conns[i] = newConn("u")
			h.seat(conns[i])
			drains = append(drains, drain(conns[i]))
		}

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.Broadcast("sess-1", []byte("frame"))
		}()
		go func() {
			defer wg.Done()
			for _, c := range conns {
				c.Close()
			}
		}()
		wg.Wait()
		for _, d := range drains {
			d.Wait()
		}
	}
}

// Closing twice is what happens when the writer and the reader both give up on
// the same connection.
func TestCloseIsIdempotent(t *testing.T) {
	c := newConn("dana")
	wg := drain(c)
	c.Close()
	c.Close()
	c.Close()
	wg.Wait()
}

// The wedged-consumer rule: a reader that has stopped draining must be dropped
// rather than allowed to block the room. Nothing drains this connection, so
// the buffer fills and the next Send closes it.
func TestAFullBufferDropsTheConnection(t *testing.T) {
	c := newConn("wedged")
	for i := 0; i < sendBuffer; i++ {
		c.Send([]byte("frame"))
	}
	c.Send([]byte("one too many"))

	drained := 0
	for range c.send {
		drained++
	}
	if drained != sendBuffer {
		t.Fatalf("drained %d frames, want %d buffered before the drop", drained, sendBuffer)
	}
}

func TestBroadcastToAnEmptyRoomIsHarmless(t *testing.T) {
	New().Broadcast("nobody-here", []byte("frame"))
}
