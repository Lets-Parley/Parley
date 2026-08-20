package hub

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// PongDeadline is how long a connection may go without answering a ping before
// it is considered gone. Exported because presence freshness is derived from
// it: a row has to outlive a client that is merely slow to answer.
const PongDeadline = 50 * time.Second

const (
	sendBuffer       = 16
	writeDeadline    = 5 * time.Second
	pingInterval     = 25 * time.Second
	pongDeadline     = PongDeadline
	presenceDebounce = 1500 * time.Millisecond
	maxRevalidate    = 30 * time.Second
	maxValidation    = 30 * time.Second
)

const (
	writeIdle uint32 = iota
	writeActive
	writeRemoved
	writeActiveRemoved
)

const (
	authPending uint32 = iota
	authAccepted
	authRemoved
)

type Conn struct {
	UserID       string
	SessionID    string
	SpaceID      string
	ws           *websocket.Conn
	send         chan []byte
	hub          *Hub
	tokenID      string
	expiresAt    time.Time
	closeCode    atomic.Int32
	ctx          context.Context
	cancel       context.CancelFunc
	expiry       *time.Timer
	writeState   atomic.Uint32
	authState    atomic.Uint32
	removed      atomic.Bool
	stop         chan struct{}
	writerDone   chan struct{}
	writeMessage func(messageType int, data []byte) error
}

func (c *Conn) Close() {
	c.hub.detach(c)
}

type Hub struct {
	events       chan any
	done         chan struct{}
	shutdownOnce sync.Once
	rooms        map[string]map[*Conn]struct{}
	pending      map[*Conn]registerEvent

	// OnPresenceChange fires (debounced) after connects/disconnects settle.
	OnPresenceChange func(sessionID string)
	// OnFacilitatorSeen fires on connect and each pong so liveness reaches the DB.
	OnFacilitatorSeen func(sessionID, userID string)
	// ValidateSession checks session validity through the shared store.
	ValidateSession func(ctx context.Context, tokenID string) (time.Time, error)
	// ValidateMembership re-checks that a connection's user still belongs to
	// the space its session lives in. Removing a member disconnects them
	// immediately on this process; this tick is what closes their sockets on
	// every other one, so the worst case is one revalidation interval.
	ValidateMembership   func(ctx context.Context, spaceID, userID string) (bool, error)
	RevalidationInterval time.Duration
	ValidationTimeout    time.Duration

	// OnDisconnect fires once a user has no connections left on this hub, so a
	// room stops showing them without waiting for their presence row to age out.
	OnDisconnect func(sessionID, userID string)

	timersMu sync.Mutex
	timers   map[string]*time.Timer
}

type registerEvent struct {
	conn     *Conn
	initial  []byte
	accepted chan bool
}

type unregisterEvent struct {
	conn *Conn
	done chan struct{}
}

type broadcastEvent struct {
	sessionID string
	msg       []byte
	done      chan struct{}
}

type connectedEvent struct {
	sessionID string
	result    chan []string
}

type sessionsEvent struct {
	result chan []string
}

type shutdownEvent struct {
	done chan []<-chan struct{}
}

type disconnectTokenEvent struct {
	tokenID string
	done    chan []<-chan struct{}
}

type disconnectMemberEvent struct {
	spaceID string
	userID  string
	done    chan []<-chan struct{}
}

type revalidationEvent struct {
	conn      *Conn
	expiresAt time.Time
	err       error
}

type expiryEvent struct {
	conn      *Conn
	expiresAt time.Time
}

// initialStateEvent carries the room snapshot that a freshly registered
// connection is owed, once its membership has been confirmed a second time —
// after registration, so a removal that lands mid-handshake is seen.
type initialStateEvent struct {
	conn    *Conn
	initial []byte
	err     error
}

// ErrNotMember reports a connection whose owner has lost membership of the
// space its session belongs to. It closes the socket the same way a revoked
// token does.
var ErrNotMember = errors.New("no longer a member of this space")

// SessionAuth identifies the session token that authenticated a WebSocket and
// the space whose membership keeps it alive.
type SessionAuth struct {
	TokenID   string
	SpaceID   string
	ExpiresAt time.Time
}

func New() *Hub {
	h := &Hub{
		events:  make(chan any),
		done:    make(chan struct{}),
		rooms:   make(map[string]map[*Conn]struct{}),
		pending: make(map[*Conn]registerEvent),
		timers:  make(map[string]*time.Timer),
	}
	go h.run()
	return h
}

func (h *Hub) run() {
	for event := range h.events {
		switch e := event.(type) {
		case registerEvent:
			if e.conn.tokenID != "" && h.ValidateSession != nil {
				h.pending[e.conn] = e
				go h.validate(e.conn)
				continue
			}
			h.register(e)
		case unregisterEvent:
			if _, pending := h.pending[e.conn]; pending {
				h.rejectPending(e.conn, websocket.CloseNormalClosure)
			} else {
				h.remove(e.conn, websocket.CloseNormalClosure)
			}
			close(e.done)
		case broadcastEvent:
			for c := range h.rooms[e.sessionID] {
				h.deliver(c, e.msg)
			}
			close(e.done)
		case connectedEvent:
			seen := map[string]struct{}{}
			out := []string{}
			for c := range h.rooms[e.sessionID] {
				if _, dup := seen[c.UserID]; !dup {
					seen[c.UserID] = struct{}{}
					out = append(out, c.UserID)
				}
			}
			e.result <- out
		case sessionsEvent:
			out := make([]string, 0, len(h.rooms))
			for id := range h.rooms {
				out = append(out, id)
			}
			e.result <- out
		case shutdownEvent:
			writers := []<-chan struct{}{}
			for c := range h.pending {
				writers = append(writers, h.rejectPending(c, websocket.CloseGoingAway))
			}
			for _, room := range h.rooms {
				for c := range room {
					if done := h.remove(c, websocket.CloseGoingAway); done != nil {
						writers = append(writers, done)
					}
				}
			}
			h.stopPresenceTimers()
			close(h.done)
			e.done <- writers
			return
		case disconnectTokenEvent:
			writers := []<-chan struct{}{}
			for c := range h.pending {
				if c.tokenID == e.tokenID {
					writers = append(writers, h.rejectPending(c, websocket.ClosePolicyViolation))
				}
			}
			for _, room := range h.rooms {
				for c := range room {
					if c.tokenID == e.tokenID {
						if done := h.remove(c, websocket.ClosePolicyViolation); done != nil {
							writers = append(writers, done)
						}
					}
				}
			}
			e.done <- writers
		case disconnectMemberEvent:
			writers := []<-chan struct{}{}
			for c := range h.pending {
				if c.SpaceID == e.spaceID && c.UserID == e.userID {
					writers = append(writers, h.rejectPending(c, websocket.ClosePolicyViolation))
				}
			}
			for _, room := range h.rooms {
				for c := range room {
					if c.SpaceID == e.spaceID && c.UserID == e.userID {
						if done := h.remove(c, websocket.ClosePolicyViolation); done != nil {
							writers = append(writers, done)
						}
					}
				}
			}
			e.done <- writers
		case revalidationEvent:
			if pending, ok := h.pending[e.conn]; ok {
				if e.err != nil {
					h.rejectPending(e.conn, websocket.ClosePolicyViolation)
					continue
				}
				delete(h.pending, e.conn)
				e.conn.expiresAt = e.expiresAt
				h.register(pending)
				continue
			}
			if !h.registered(e.conn) {
				continue
			}
			if e.err != nil {
				h.remove(e.conn, websocket.ClosePolicyViolation)
				continue
			}
			e.conn.expiresAt = e.expiresAt
			h.armExpiry(e.conn)
		case initialStateEvent:
			if !h.registered(e.conn) {
				continue
			}
			if e.err != nil {
				h.remove(e.conn, websocket.ClosePolicyViolation)
				continue
			}
			h.deliver(e.conn, e.initial)
		case expiryEvent:
			if h.registered(e.conn) && e.conn.expiresAt.Equal(e.expiresAt) {
				if h.ValidateSession != nil {
					go h.validate(e.conn)
				}
			}
		}
	}
}

func (h *Hub) register(e registerEvent) {
	room := h.rooms[e.conn.SessionID]
	if room == nil {
		room = make(map[*Conn]struct{})
		h.rooms[e.conn.SessionID] = room
	}
	room[e.conn] = struct{}{}
	h.armExpiry(e.conn)
	if e.initial != nil {
		// The membership read that authorized the handshake happened before
		// this connection existed, so a removal committed mid-upgrade would
		// still have shipped a full room snapshot to someone who had just lost
		// access. Re-check once the connection is registered — from here on the
		// removal path can see it, and the snapshot is only released if the
		// second read still says member.
		if h.gatesInitialState(e.conn) {
			go h.confirmMembership(e.conn, e.initial)
		} else {
			h.deliver(e.conn, e.initial)
		}
	}
	e.accepted <- true
}

func (h *Hub) rejectPending(c *Conn, closeCode int) <-chan struct{} {
	pending, ok := h.pending[c]
	if !ok {
		return nil
	}
	delete(h.pending, c)
	c.markRemoved()
	c.cancel()
	c.closeCode.Store(int32(closeCode))
	close(c.stop)
	close(c.send)
	pending.accepted <- false
	return c.writerDone
}

func (h *Hub) submit(event any) bool {
	select {
	case h.events <- event:
		return true
	case <-h.done:
		return false
	}
}

func (h *Hub) deliver(c *Conn, msg []byte) {
	select {
	case c.send <- msg:
	default:
		h.remove(c, websocket.CloseNormalClosure)
	}
}

func (h *Hub) registered(c *Conn) bool {
	room := h.rooms[c.SessionID]
	_, ok := room[c]
	return ok
}

func (h *Hub) armExpiry(c *Conn) {
	if c.expiresAt.IsZero() {
		return
	}
	if c.expiry != nil {
		c.expiry.Stop()
	}
	expiresAt := c.expiresAt
	delay := time.Until(expiresAt)
	if delay < 0 {
		delay = 0
	}
	c.expiry = time.AfterFunc(delay, func() {
		h.submit(expiryEvent{conn: c, expiresAt: expiresAt})
	})
}

func (h *Hub) remove(c *Conn, closeCode int) <-chan struct{} {
	room, ok := h.rooms[c.SessionID]
	if !ok {
		return nil
	}
	if _, ok := room[c]; !ok {
		return nil
	}
	c.markRemoved()
	if c.expiry != nil {
		c.expiry.Stop()
	}
	c.cancel()
	c.closeCode.Store(int32(closeCode))
	close(c.stop)
	close(c.send)
	delete(room, c)
	if len(room) == 0 {
		delete(h.rooms, c.SessionID)
	}
	// The same person may hold more than one socket here (two tabs). Only the
	// last one leaving means they have actually gone. OnDisconnect writes to the
	// database, so it must not run on the event loop goroutine.
	if h.OnDisconnect != nil {
		last := true
		for other := range room {
			if other.UserID == c.UserID {
				last = false
				break
			}
		}
		if last {
			go h.OnDisconnect(c.SessionID, c.UserID)
		}
	}
	h.schedulePresence(c.SessionID)
	return c.writerDone
}

// Attach registers the websocket and starts its reader/writer goroutines.
// It returns after starting them; the caller is done with the connection.
func (h *Hub) Attach(ws *websocket.Conn, sessionID, userID string, initial []byte) {
	h.AttachAuthenticated(ws, sessionID, userID, initial, SessionAuth{})
}

// AttachAuthenticated binds a websocket to the session token used by its
// handshake and starts its reader and writer goroutines.
func (h *Hub) AttachAuthenticated(ws *websocket.Conn, sessionID, userID string, initial []byte, auth SessionAuth) {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		UserID: userID, SessionID: sessionID, SpaceID: auth.SpaceID, ws: ws,
		send: make(chan []byte, sendBuffer), hub: h, tokenID: auth.TokenID,
		expiresAt: auth.ExpiresAt,
		ctx:       ctx, cancel: cancel, stop: make(chan struct{}), writerDone: make(chan struct{}),
		writeMessage: ws.WriteMessage,
	}
	c.closeCode.Store(websocket.CloseNormalClosure)
	accepted := make(chan bool)
	if !h.submit(registerEvent{conn: c, initial: initial, accepted: accepted}) {
		cancel()
		ws.Close()
		return
	}
	go h.writer(c)
	go h.reader(c)
	if !<-accepted {
		return
	}
	if !c.authState.CompareAndSwap(authPending, authAccepted) {
		return
	}
	if c.tokenID != "" && h.ValidateSession != nil {
		go h.revalidate(ctx, c)
	}

	if h.OnFacilitatorSeen != nil {
		h.OnFacilitatorSeen(sessionID, userID)
	}
	h.schedulePresence(sessionID)
}

func (h *Hub) revalidate(ctx context.Context, c *Conn) {
	interval := h.RevalidationInterval
	if interval <= 0 || interval > maxRevalidate {
		interval = maxRevalidate
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.validate(c)
		}
	}
}

func (h *Hub) validate(c *Conn) {
	ctx, cancel := context.WithTimeout(c.ctx, h.validationTimeout())
	defer cancel()
	expiresAt, err := h.ValidateSession(ctx, c.tokenID)
	// Membership is authorization, not authentication: a live token whose
	// holder was removed from the space must lose the socket too.
	if err == nil && h.ValidateMembership != nil && c.SpaceID != "" {
		member, memberErr := h.ValidateMembership(ctx, c.SpaceID, c.UserID)
		switch {
		case memberErr != nil:
			err = memberErr
		case !member:
			err = ErrNotMember
		}
	}
	if c.ctx.Err() != nil {
		return
	}
	h.submit(revalidationEvent{conn: c, expiresAt: expiresAt, err: err})
}

// gatesInitialState reports whether a connection's first state frame has to
// wait on a post-registration membership check.
func (h *Hub) gatesInitialState(c *Conn) bool {
	return h.ValidateMembership != nil && c.SpaceID != ""
}

// confirmMembership re-reads membership for an already-registered connection
// and releases (or refuses) its initial room snapshot.
func (h *Hub) confirmMembership(c *Conn, initial []byte) {
	ctx, cancel := context.WithTimeout(c.ctx, h.validationTimeout())
	defer cancel()
	member, err := h.ValidateMembership(ctx, c.SpaceID, c.UserID)
	if err == nil && !member {
		err = ErrNotMember
	}
	if c.ctx.Err() != nil {
		return
	}
	h.submit(initialStateEvent{conn: c, initial: initial, err: err})
}

func (h *Hub) validationTimeout() time.Duration {
	timeout := h.ValidationTimeout
	if timeout <= 0 || timeout > maxValidation {
		return maxValidation
	}
	return timeout
}

func (h *Hub) detach(c *Conn) {
	done := make(chan struct{})
	if h.submit(unregisterEvent{conn: c, done: done}) {
		<-done
	}
}

func (h *Hub) writer(c *Conn) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	defer close(c.writerDone)
	defer c.ws.Close()
	for {
		select {
		case <-c.stop:
			h.writeClose(c)
			return
		default:
		}
		select {
		case <-c.stop:
			h.writeClose(c)
			return
		case msg, ok := <-c.send:
			if !ok {
				h.writeClose(c)
				return
			}
			if !c.beginWrite() {
				continue
			}
			c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			err := c.writeMessage(websocket.TextMessage, msg)
			c.finishWrite()
			if err != nil {
				h.detach(c)
				return
			}
		case <-ticker.C:
			if !c.beginWrite() {
				continue
			}
			c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
			err := c.writeMessage(websocket.PingMessage, nil)
			c.finishWrite()
			if err != nil {
				h.detach(c)
				return
			}
		}
	}
}

func (h *Hub) writeClose(c *Conn) {
	c.ws.SetWriteDeadline(time.Now().Add(writeDeadline))
	c.writeMessage(websocket.CloseMessage, websocket.FormatCloseMessage(int(c.closeCode.Load()), ""))
}

func (c *Conn) beginWrite() bool {
	return c.writeState.CompareAndSwap(writeIdle, writeActive)
}

func (c *Conn) finishWrite() {
	if c.writeState.CompareAndSwap(writeActive, writeIdle) {
		return
	}
	c.writeState.CompareAndSwap(writeActiveRemoved, writeRemoved)
}

func (c *Conn) markRemoved() {
	c.authState.Store(authRemoved)
	for {
		switch c.writeState.Load() {
		case writeIdle:
			if c.writeState.CompareAndSwap(writeIdle, writeRemoved) {
				c.removed.Store(true)
				return
			}
		case writeActive:
			if c.writeState.CompareAndSwap(writeActive, writeActiveRemoved) {
				c.removed.Store(true)
				return
			}
		default:
			c.removed.Store(true)
			return
		}
	}
}

func (h *Hub) reader(c *Conn) {
	defer h.detach(c)
	c.ws.SetReadLimit(4096)
	c.ws.SetReadDeadline(time.Now().Add(pongDeadline))
	c.ws.SetPongHandler(func(string) error {
		c.ws.SetReadDeadline(time.Now().Add(pongDeadline))
		if c.authState.Load() == authAccepted && h.OnFacilitatorSeen != nil {
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

// Broadcast delivers a frame to every connection in the room.
func (h *Hub) Broadcast(sessionID string, msg []byte) {
	done := make(chan struct{})
	if h.submit(broadcastEvent{sessionID: sessionID, msg: msg, done: done}) {
		<-done
	}
}

// Sessions returns the ids of every room this hub currently holds a connection
// for. The notification listener uses it to resync after a reconnect.
func (h *Hub) Sessions() []string {
	result := make(chan []string, 1)
	if !h.submit(sessionsEvent{result: result}) {
		return nil
	}
	return <-result
}

// Connected returns the distinct user ids with a live connection to the session
// ON THIS REPLICA.
//
// Not for answering "who is in this room" — that is store.Presence, which sees
// every replica. This one exists for the hub's own tests, which need to check
// the per-user bookkeeping that detach relies on to decide whether a
// disconnecting connection was somebody's last. Wiring it back into a handler
// reintroduces the split-room bug: half the table seeing a different set of
// faces than the other half.
func (h *Hub) Connected(sessionID string) []string {
	result := make(chan []string)
	if !h.submit(connectedEvent{sessionID: sessionID, result: result}) {
		return nil
	}
	return <-result
}

// DisconnectToken synchronously removes all connections authenticated by the
// token identifier.
func (h *Hub) DisconnectToken(tokenID string) {
	if tokenID == "" {
		return
	}
	done := make(chan []<-chan struct{}, 1)
	if h.submit(disconnectTokenEvent{tokenID: tokenID, done: done}) {
		waitForWriters(<-done)
	}
}

// DisconnectSpaceMember synchronously removes every connection this process
// holds for a user in a space. Membership is authorization, so a removal has
// to reach sockets that are already open, not just the next HTTP request.
func (h *Hub) DisconnectSpaceMember(spaceID, userID string) {
	if spaceID == "" || userID == "" {
		return
	}
	done := make(chan []<-chan struct{}, 1)
	if h.submit(disconnectMemberEvent{spaceID: spaceID, userID: userID, done: done}) {
		waitForWriters(<-done)
	}
}

// Shutdown synchronously removes every connection and stops the owner loop.
// Calls racing with it either complete before shutdown or safely become no-ops.
func (h *Hub) Shutdown() {
	h.shutdownOnce.Do(func() {
		done := make(chan []<-chan struct{}, 1)
		if h.submit(shutdownEvent{done: done}) {
			waitForWriters(<-done)
		}
	})
}

// Done is closed when the owner loop stops accepting work.
func (h *Hub) Done() <-chan struct{} {
	return h.done
}

func waitForWriters(writers []<-chan struct{}) {
	for _, done := range writers {
		<-done
	}
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

func (h *Hub) stopPresenceTimers() {
	h.timersMu.Lock()
	defer h.timersMu.Unlock()
	for sessionID, timer := range h.timers {
		timer.Stop()
		delete(h.timers, sessionID)
	}
}
