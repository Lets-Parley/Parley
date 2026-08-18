package hub

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testHub serves websockets that attach to a hub, and returns a dial function
// for opening a client connection as a given user in a given session.
func testHub(t *testing.T, h *Hub) func(sessionID, userID string) *websocket.Conn {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.Attach(ws, r.URL.Query().Get("s"), r.URL.Query().Get("u"), nil)
	}))
	t.Cleanup(srv.Close)
	return func(sessionID, userID string) *websocket.Conn {
		c, _, err := websocket.DefaultDialer.Dial(
			"ws"+srv.URL[4:]+"?s="+sessionID+"&u="+userID, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
}

// waitForConnected polls until the session's connected users match want, or
// fails. Attach and detach both finish asynchronously, so there is nothing to
// synchronize on from the outside.
func waitForConnected(t *testing.T, h *Hub, sessionID string, want ...string) {
	t.Helper()
	sort.Strings(want)
	deadline := time.Now().Add(3 * time.Second)
	var got []string
	for time.Now().Before(deadline) {
		got = h.Connected(sessionID)
		sort.Strings(got)
		if equal(got, want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("connected to %s = %v, want %v", sessionID, got, want)
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func readOne(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(msg)
}

func TestConnectedTracksAttachAndDetach(t *testing.T) {
	h := New()
	dial := testHub(t, h)

	if got := h.Connected("empty"); len(got) != 0 {
		t.Fatalf("empty room = %v, want none", got)
	}

	amy := dial("room", "amy")
	dial("room", "ben")
	waitForConnected(t, h, "room", "amy", "ben")

	// A second tab for the same person is one connection but one user.
	dial("room", "amy")
	waitForConnected(t, h, "room", "amy", "ben")

	amy.Close()
	// Amy's other tab is still open, so she stays present.
	waitForConnected(t, h, "room", "amy", "ben")
}

func TestRoomsAreIsolated(t *testing.T) {
	h := New()
	dial := testHub(t, h)

	here := dial("here", "amy")
	dial("there", "ben")
	waitForConnected(t, h, "here", "amy")
	waitForConnected(t, h, "there", "ben")

	h.Broadcast("here", []byte("for here"))
	if got := readOne(t, here); got != "for here" {
		t.Fatalf("message = %q, want %q", got, "for here")
	}

	// Nothing addressed to the other room arrives, and broadcasting to a room
	// nobody is in is not an error.
	h.Broadcast("nobody home", []byte("into the void"))
	h.Broadcast("here", []byte("second"))
	if got := readOne(t, here); got != "second" {
		t.Fatalf("message = %q, want %q — a foreign room's frame leaked in", got, "second")
	}
}

func TestBroadcastReachesEveryConnection(t *testing.T) {
	h := New()
	dial := testHub(t, h)

	clients := []*websocket.Conn{dial("room", "amy"), dial("room", "ben"), dial("room", "amy")}
	waitForConnected(t, h, "room", "amy", "ben")

	h.Broadcast("room", []byte("hello"))
	for i, c := range clients {
		if got := readOne(t, c); got != "hello" {
			t.Errorf("client %d got %q, want hello", i, got)
		}
	}
}

func TestAttachSendsTheInitialFrame(t *testing.T) {
	h := New()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.Attach(ws, "room", "amy", []byte("snapshot"))
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:], nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got := readOne(t, c); got != "snapshot" {
		t.Fatalf("first frame = %q, want the initial snapshot", got)
	}
}

func TestOnFacilitatorSeenFiresOnAttach(t *testing.T) {
	h := New()
	var mu sync.Mutex
	var seen [][2]string
	h.OnFacilitatorSeen = func(sessionID, userID string) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, [2]string{sessionID, userID})
	}
	dial := testHub(t, h)
	dial("room", "amy")
	waitForConnected(t, h, "room", "amy")

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] != [2]string{"room", "amy"} {
		t.Fatalf("OnFacilitatorSeen calls = %v, want one for room/amy", seen)
	}
}

func TestPresenceChangeIsDebouncedPerSession(t *testing.T) {
	h := New()
	var mu sync.Mutex
	calls := map[string]int{}
	h.OnPresenceChange = func(sessionID string) {
		mu.Lock()
		defer mu.Unlock()
		calls[sessionID]++
	}
	dial := testHub(t, h)

	// A burst of connects in one room collapses into a single notification;
	// the debounce is what keeps a room-wide rebuild off every connect.
	for i := 0; i < 5; i++ {
		dial("busy", "user")
	}
	dial("quiet", "amy")
	waitForConnected(t, h, "busy", "user")
	waitForConnected(t, h, "quiet", "amy")

	time.Sleep(presenceDebounce + 500*time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls["busy"] != 1 {
		t.Errorf("presence notifications for the busy room = %d, want 1", calls["busy"])
	}
	if calls["quiet"] != 1 {
		t.Errorf("presence notifications for the quiet room = %d, want 1", calls["quiet"])
	}
}

func TestSendAfterCloseIsIgnored(t *testing.T) {
	// A closed connection must absorb a late frame rather than panic. Broadcast
	// snapshots the room and writes outside the lock, so a connection can be
	// closed underneath it, and the presence debounce broadcasts from a timer
	// goroutine where a panic takes the process down rather than one request.
	c := &Conn{send: make(chan []byte, 2)}
	c.Close()
	c.Close() // idempotent
	c.Send([]byte("late"))
}

func TestSendDropsAConnectionWithAFullBuffer(t *testing.T) {
	// A reader that has stopped draining must not wedge the room: once the
	// buffer fills, the connection is closed instead of blocking the sender.
	c := &Conn{send: make(chan []byte, sendBuffer)}
	for i := 0; i < sendBuffer; i++ {
		c.Send([]byte("fill"))
	}
	if len(c.send) != sendBuffer {
		t.Fatalf("buffered %d frames, want %d", len(c.send), sendBuffer)
	}
	c.Send([]byte("one too many"))

	// The connection is now closed: draining reaches a closed channel rather
	// than blocking forever.
	for i := 0; i < sendBuffer; i++ {
		<-c.send
	}
	if _, open := <-c.send; open {
		t.Fatal("the send channel is still open after overflowing the buffer")
	}
}

func TestBroadcastSurvivesConcurrentDisconnects(t *testing.T) {
	h := New()
	dial := testHub(t, h)

	var clients []*websocket.Conn
	for i := 0; i < 40; i++ {
		clients = append(clients, dial("room", "user"))
	}
	waitForConnected(t, h, "room", "user")

	// Broadcasting while connections drop must not panic. Broadcast snapshots
	// the room under the mutex and writes outside it, so every frame here
	// races a detach closing the same connection.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 4000; i++ {
			h.Broadcast("room", []byte("x"))
		}
	}()
	go func() {
		defer wg.Done()
		for _, c := range clients {
			c.Close()
		}
	}()
	wg.Wait()

	waitForConnected(t, h, "room")
}
