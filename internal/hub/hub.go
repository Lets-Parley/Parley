package hub

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	sendBuffer       = 16
	writeDeadline    = 5 * time.Second
	pingInterval     = 25 * time.Second
	pongDeadline     = 50 * time.Second
	presenceDebounce = 1500 * time.Millisecond
)

type Conn struct {
	UserID    string
	SessionID string
	ws        *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
}

// Send queues a frame; a full buffer means the reader is wedged, so the
// connection is dropped rather than blocking the room.
func (c *Conn) Send(msg []byte) {
	select {
	case c.send <- msg:
	default:
		c.Close()
	}
}

func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.send)
	})
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[*Conn]struct{}

	// OnPresenceChange fires (debounced) after connects/disconnects settle.
	OnPresenceChange func(sessionID string)
	// OnFacilitatorSeen fires on connect and each pong so liveness reaches the DB.
	OnFacilitatorSeen func(sessionID, userID string)

	timersMu sync.Mutex
	timers   map[string]*time.Timer
}

func New() *Hub {
	return &Hub{
		rooms:  make(map[string]map[*Conn]struct{}),
		timers: make(map[string]*time.Timer),
	}
}

// Attach registers the websocket and starts its reader/writer goroutines.
// It returns after starting them; the caller is done with the connection.
func (h *Hub) Attach(ws *websocket.Conn, sessionID, userID string, initial []byte) {
	c := &Conn{UserID: userID, SessionID: sessionID, ws: ws, send: make(chan []byte, sendBuffer)}

	h.mu.Lock()
	room := h.rooms[sessionID]
	if room == nil {
		room = make(map[*Conn]struct{})
		h.rooms[sessionID] = room
	}
	room[c] = struct{}{}
	h.mu.Unlock()

	if initial != nil {
		c.Send(initial)
	}
	if h.OnFacilitatorSeen != nil {
		h.OnFacilitatorSeen(sessionID, userID)
	}
	h.schedulePresence(sessionID)

	go h.writer(c)
	go h.reader(c)
}

func (h *Hub) detach(c *Conn) {
	h.mu.Lock()
	if room, ok := h.rooms[c.SessionID]; ok {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, c.SessionID)
		}
	}
	h.mu.Unlock()
	c.Close()
	c.ws.Close()
	h.schedulePresence(c.SessionID)
}

func (h *Hub) writer(c *Conn) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
				c.ws.WriteMessage(websocket.CloseMessage, nil)
				c.ws.Close()
				return
			}
			c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				h.detach(c)
				return
			}
		case <-ticker.C:
			c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				h.detach(c)
				return
			}
		}
	}
}

func (h *Hub) reader(c *Conn) {
	defer h.detach(c)
	c.ws.SetReadLimit(4096)
	c.ws.SetReadDeadline(time.Now().Add(pongDeadline))
	c.ws.SetPongHandler(func(string) error {
		c.ws.SetReadDeadline(time.Now().Add(pongDeadline))
		if h.OnFacilitatorSeen != nil {
			h.OnFacilitatorSeen(c.SessionID, c.UserID)
		}
		return nil
	})
	for {
		// Clients mutate over REST; inbound messages are ignored, but the read
		// loop drives pong handling and disconnect detection.
		if _, _, err := c.ws.ReadMessage(); err != nil {
			return
		}
	}
}

// Broadcast delivers a frame to every connection in the room. The conn list is
// snapshotted under the mutex and writes happen outside it.
func (h *Hub) Broadcast(sessionID string, msg []byte) {
	h.mu.Lock()
	conns := make([]*Conn, 0, len(h.rooms[sessionID]))
	for c := range h.rooms[sessionID] {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.Send(msg)
	}
}

// Connected returns the distinct user ids with a live connection to the session.
func (h *Hub) Connected(sessionID string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	seen := map[string]struct{}{}
	out := []string{}
	for c := range h.rooms[sessionID] {
		if _, dup := seen[c.UserID]; !dup {
			seen[c.UserID] = struct{}{}
			out = append(out, c.UserID)
		}
	}
	return out
}

func (h *Hub) schedulePresence(sessionID string) {
	if h.OnPresenceChange == nil {
		return
	}
	h.timersMu.Lock()
	defer h.timersMu.Unlock()
	if t, ok := h.timers[sessionID]; ok {
		t.Reset(presenceDebounce)
		return
	}
	h.timers[sessionID] = time.AfterFunc(presenceDebounce, func() {
		h.timersMu.Lock()
		delete(h.timers, sessionID)
		h.timersMu.Unlock()
		h.OnPresenceChange(sessionID)
	})
}
