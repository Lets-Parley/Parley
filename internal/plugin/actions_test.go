package plugin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tetratelabs/wabin/binary"
	"github.com/tetratelabs/wabin/leb128"
	"github.com/tetratelabs/wabin/wasm"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

const (
	opBlock    = 0x02
	opBrIf     = 0x0d
	opLocalGet = 0x20
	opLocalSet = 0x21
	opLocalTee = 0x22
	opI64Const = 0x42
	opI64GeU   = 0x5a
	opI32Sub   = 0x6b
	opI64Add   = 0x7c
	opI64Sub   = 0x7d
)

func i64Const(v int) []byte {
	return append([]byte{opI64Const}, leb128.EncodeInt64(int64(v))...)
}

// buildAction finishes the module with one function exported twice: as
// on_session_action, which the action path calls, and as "run", so the same
// guest can be called the way every other hook is.
func (b *guestBuilder) buildAction(locals []wasm.ValueType, body []byte) []byte {
	b.types = append(b.types, &wasm.FunctionType{Results: []wasm.ValueType{wasm.ValueTypeI32}})
	m := &wasm.Module{
		TypeSection:     b.types,
		ImportSection:   b.imports,
		FunctionSection: []wasm.Index{uint32(len(b.types) - 1)},
		ExportSection: []*wasm.Export{
			{Type: wasm.ExternTypeFunc, Name: ExportSessionAction, Index: uint32(len(b.imports))},
			{Type: wasm.ExternTypeFunc, Name: "run", Index: uint32(len(b.imports))},
		},
		CodeSection: []*wasm.Code{{LocalTypes: locals, Body: body}},
	}
	return binary.EncodeModule(m)
}

// storeBytes writes s into Extism memory at the offset held in a local, one
// byte at a time: a guest's own data segment is not memory the host can read.
func storeBytes(storeU8 uint32, local byte, s string) []byte {
	var out []byte
	for i := range len(s) {
		out = append(out, opLocalGet, local)
		out = append(out, i64Const(i)...)
		out = append(out, opI64Add)
		out = append(out, i32Const(int32(s[i]))...)
		out = append(out, opCall, byte(storeU8))
	}
	return out
}

// guestReplies answers every action with the same output and no error, which
// is all a refusal is.
func guestReplies(reply string) []byte {
	var b guestBuilder
	i64, i32 := wasm.ValueTypeI64, wasm.ValueTypeI32
	alloc := b.importFunc("extism:host/env", "alloc", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	storeU8 := b.importFunc("extism:host/env", "store_u8", []wasm.ValueType{i64, i32}, nil)
	outputSet := b.importFunc("extism:host/env", "output_set", []wasm.ValueType{i64, i64}, nil)

	body := append(i64Const(len(reply)), opCall, byte(alloc), opLocalSet, 0)
	body = append(body, storeBytes(storeU8, 0, reply)...)
	body = append(body, opLocalGet, 0)
	body = append(body, i64Const(len(reply))...)
	body = append(body, opCall, byte(outputSet))
	body = append(body, i32Const(0)...)
	return b.buildAction([]wasm.ValueType{i64}, append(body, opEnd))
}

// guestReports runs to its end and says it failed, which is what a throw in a
// JavaScript guest becomes: the message goes in Extism's error slot and the
// export returns non-zero.
func guestReports(message string) []byte {
	var b guestBuilder
	i64, i32 := wasm.ValueTypeI64, wasm.ValueTypeI32
	alloc := b.importFunc("extism:host/env", "alloc", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	storeU8 := b.importFunc("extism:host/env", "store_u8", []wasm.ValueType{i64, i32}, nil)
	errorSet := b.importFunc("extism:host/env", "error_set", []wasm.ValueType{i64}, nil)

	body := append(i64Const(len(message)), opCall, byte(alloc), opLocalSet, 0)
	body = append(body, storeBytes(storeU8, 0, message)...)
	body = append(body, opLocalGet, 0, opCall, byte(errorSet))
	body = append(body, i32Const(1)...)
	return b.buildAction([]wasm.ValueType{i64}, append(body, opEnd))
}

// guestHangs never returns from an action.
func guestHangs() []byte {
	var b guestBuilder
	return b.buildAction(nil, []byte{opLoop, blockTypeEmpty, opBr, 0x00, opEnd, opUnreachable, opEnd})
}

// guestTraps traps on an action, and on "run".
func guestTraps() []byte {
	var b guestBuilder
	return b.buildAction(nil, []byte{opUnreachable, opEnd})
}

// guestAppends is the shape every ceremony's action has: read a document from
// the key-value store, change it, write it back. It appends three bytes to
// the value under "n", and spins between the read and the write so two calls
// that are allowed to overlap do overlap. The value's length is then a count
// of the writes that survived.
//
// It never parses: the stored value comes back as base64 inside a response of
// a fixed shape, three bytes are four base64 characters, so the new value is
// the old one's characters with four more on the end.
func guestAppends() []byte {
	const (
		getReq   = `{"key":"n"}`
		respHead = `{"ok":true,"data":{"found":true,"value":"`
		respTail = `"}}`
		setHead  = `{"key":"n","value":"`
		setTail  = `QUFB"}`

		req, resp, n, out, i, spin = 0, 1, 2, 3, 4, 5
	)
	var b guestBuilder
	i64, i32 := wasm.ValueTypeI64, wasm.ValueTypeI32
	alloc := b.importFunc("extism:host/env", "alloc", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	length := b.importFunc("extism:host/env", "length", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	loadU8 := b.importFunc("extism:host/env", "load_u8", []wasm.ValueType{i64}, []wasm.ValueType{i32})
	storeU8 := b.importFunc("extism:host/env", "store_u8", []wasm.ValueType{i64, i32}, nil)
	kvGet := b.importFunc("extism:host/user", "parley_kv_get", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	kvSet := b.importFunc("extism:host/user", "parley_kv_set", []wasm.ValueType{i64}, []wasm.ValueType{i64})

	var body []byte
	add := func(parts ...[]byte) {
		for _, p := range parts {
			body = append(body, p...)
		}
	}
	// resp = kv_get(getReq); n = length(resp) - the fixed wrapping.
	add(i64Const(len(getReq)), []byte{opCall, byte(alloc), opLocalSet, req},
		storeBytes(storeU8, req, getReq),
		[]byte{opLocalGet, req, opCall, byte(kvGet), opLocalSet, resp},
		[]byte{opLocalGet, resp, opCall, byte(length)}, i64Const(len(respHead)+len(respTail)),
		[]byte{opI64Sub, opLocalSet, n})
	// The window a second writer falls into.
	add(i32Const(3_000_000), []byte{opLocalSet, spin, opLoop, blockTypeEmpty, opLocalGet, spin},
		i32Const(1), []byte{opI32Sub, opLocalTee, spin, opBrIf, 0, opEnd})
	// out = setHead + resp[len(respHead):][:n] + setTail
	add([]byte{opLocalGet, n}, i64Const(len(setHead)+len(setTail)),
		[]byte{opI64Add, opCall, byte(alloc), opLocalSet, out},
		storeBytes(storeU8, out, setHead))
	add([]byte{opBlock, blockTypeEmpty, opLoop, blockTypeEmpty,
		opLocalGet, i, opLocalGet, n, opI64GeU, opBrIf, 1,
		opLocalGet, out}, i64Const(len(setHead)), []byte{opI64Add, opLocalGet, i, opI64Add,
		opLocalGet, resp}, i64Const(len(respHead)), []byte{opI64Add, opLocalGet, i, opI64Add,
		opCall, byte(loadU8), opCall, byte(storeU8),
		opLocalGet, i}, i64Const(1), []byte{opI64Add, opLocalSet, i,
		opBr, 0, opEnd, opEnd})
	add([]byte{opLocalGet, out}, i64Const(len(setHead)), []byte{opI64Add, opLocalGet, n, opI64Add, opLocalSet, req},
		storeBytes(storeU8, req, setTail),
		[]byte{opLocalGet, out, opCall, byte(kvSet), opDrop},
		i32Const(0), []byte{opEnd})
	return b.buildAction([]wasm.ValueType{i64, i64, i64, i64, i64, i32}, body)
}

// room serves one plugin action over HTTP the way the dispatcher hands it to
// the kind, and counts the broadcasts it asked for.
type room struct {
	*httptest.Server
	broadcasts atomic.Int64
	session    string
}

func actionRoom(t *testing.T, h *Host, in Install) *room {
	t.Helper()
	st, err := h.Store.State(context.Background(), in.ID)
	if err != nil {
		t.Fatal(err)
	}
	kind := h.PluginKind(st, KindDef{Kind: "k", Actions: []ActionDef{{Name: "act", Verb: http.MethodPost}}})
	r := &room{session: "room-" + in.ID}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		id := r.session
		if other := req.URL.Query().Get("room"); other != "" {
			id = other
		}
		kind.Actions["act"].Do(w, req, session.ActionCtx{
			Session:   store.Session{ID: id},
			UserID:    "someone",
			Broadcast: func(context.Context, string) { r.broadcasts.Add(1) },
		})
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *room) act(t *testing.T) (int, string) {
	t.Helper()
	return r.actIn(t, "")
}

// actIn acts in a named room of the same install. The client gives up long
// before the test would, so a wait that has lost its bound fails the test
// instead of hanging it.
func (r *room) actIn(t *testing.T, id string) (int, string) {
	t.Helper()
	client := http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(r.URL+"?room="+id, "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Error(err)
		return 0, ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(body))
}

func failuresCharged(h *Host, installID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.breakerFor(installID)
	return b.failures + b.actionFailures
}

// holdRoom takes a room's advisory lock on a connection of its own, the way
// another replica mid-action holds it, and returns what lets go of it.
func holdRoom(t *testing.T, h *Host, sessionID string) func() {
	t.Helper()
	ctx := context.Background()
	tx, err := h.Store.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1, hashtext($2))`, actionLockClass, sessionID); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() { once.Do(func() { _ = tx.Rollback(ctx) }) }
	t.Cleanup(release)
	return release
}

// roomLocks counts this database's connections holding (granted) or parked on
// (not granted) a given room's action lock.
func roomLocks(t *testing.T, h *Host, sessionID string, granted bool) int {
	t.Helper()
	var n int
	err := h.Store.Pool.QueryRow(context.Background(), `
		select count(*) from pg_locks
		where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())
		  and classid = $1::int::oid and objid = hashtext($2)::oid and granted = $3`,
		actionLockClass, sessionID, granted).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// eventually waits for a condition another goroutine is driving toward.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting until %s", what)
}

func queued(h *Host, sessionID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if q := h.rooms[sessionID]; q != nil {
		return q.waiters
	}
	return 0
}

// released fails unless nothing of the room is left behind in the host or in
// Postgres.
func released(t *testing.T, h *Host, in Install, sessionID string) {
	t.Helper()
	h.mu.Lock()
	inflight, total, rooms, waiting := h.inflight[in.ID], h.total, len(h.rooms), len(h.slotWaiters)
	h.mu.Unlock()
	if inflight != 0 || total != 0 || rooms != 0 || waiting != 0 || h.roomLocks.Load() != 0 {
		t.Fatalf("left behind: %d in flight for the install, %d in total, %d room queues, %d slot waiters, %d lock connections",
			inflight, total, rooms, waiting, h.roomLocks.Load())
	}
	if n := roomLocks(t, h, sessionID, true) + roomLocks(t, h, sessionID, false); n != 0 {
		t.Fatalf("%d connections still hold or wait on the room's lock", n)
	}
}

func TestAPluginRefusesAnActionWithoutBeingChargedForIt(t *testing.T) {
	for _, tc := range []struct {
		reply  string
		status int
		body   string
	}{
		{`{"refused":"invalid"}`, 400, `{"error":"the plugin refused that action as invalid"}`},
		{`{"refused":"forbidden"}`, 403, `{"error":"the plugin does not allow you to do that"}`},
		{`{"refused":"not-found"}`, 404, `{"error":"the plugin could not find what that action names"}`},
		{`{"refused":"conflict"}`, 409, `{"error":"the plugin refused that action as the room stands"}`},
	} {
		t.Run(tc.reply, func(t *testing.T) {
			h, in := hosted(t, guestReplies(tc.reply), HostConfig{BreakerFailures: 2, BreakerCooldown: time.Hour}, 1024)
			r := actionRoom(t, h, in)
			// More refusals than the breaker's threshold: were one charged,
			// the last of these would be answered by the open circuit.
			for range 4 {
				if status, body := r.act(t); status != tc.status || body != tc.body {
					t.Fatalf("got %d %s, want %d %s", status, body, tc.status, tc.body)
				}
			}
			if n := failuresCharged(h, in.ID); n != 0 {
				t.Fatalf("%d failures were charged for refusals", n)
			}
			if n := r.broadcasts.Load(); n != 0 {
				t.Fatalf("a refused action broadcast %d times", n)
			}
		})
	}
}

// What a guest printed was ignored before refusals existed, so anything that
// is not a refusal has to stay an accepted action.
func TestAnActionReplyThatIsNotARefusalIsAccepted(t *testing.T) {
	for _, reply := range []string{``, `{}`, `{"ok":true}`, `done`, `[1]`, `"refused"`} {
		t.Run(reply, func(t *testing.T) {
			h, in := hosted(t, guestReplies(reply), HostConfig{}, 1024)
			r := actionRoom(t, h, in)
			if status, body := r.act(t); status != http.StatusNoContent {
				t.Fatalf("got %d %s, want 204", status, body)
			}
			if n := r.broadcasts.Load(); n != 1 {
				t.Fatalf("an accepted action broadcast %d times, want 1", n)
			}
		})
	}
}

func TestAMalformedRefusalIsAPluginFault(t *testing.T) {
	for _, reply := range []string{`{"refused":"teapot"}`, `{"refused":7}`, `{"refused":null}`, `{"refused":""}`} {
		t.Run(reply, func(t *testing.T) {
			h, in := hosted(t, guestReplies(reply), HostConfig{BreakerCooldown: time.Hour}, 1024)
			r := actionRoom(t, h, in)
			for range 2 {
				if status, body := r.act(t); status != http.StatusBadGateway {
					t.Fatalf("got %d %s, want 502", status, body)
				}
			}
			if n := failuresCharged(h, in.ID); n != 2 {
				t.Fatalf("%d failures were charged for two malformed refusals, want 2", n)
			}
			if n := r.broadcasts.Load(); n != 0 {
				t.Fatalf("a faulted action broadcast %d times", n)
			}
		})
	}
}

// An action is the one export a room participant calls at will. A guest that
// throws on bad input is still contained by the cooldown, but nobody in the
// room can turn that into the install being switched off for the whole org.
func TestFailingActionsDegradeAPluginButNeverDisableIt(t *testing.T) {
	h, in := hosted(t, guestPanicExporting(ExportSessionAction), HostConfig{
		BreakerFailures: 2, BreakerTripLimit: 2, BreakerCooldown: time.Hour,
	}, 1024)
	r := actionRoom(t, h, in)
	ctx := context.Background()

	for round := range 4 {
		for range 2 {
			if status, body := r.act(t); status != http.StatusBadGateway {
				t.Fatalf("got %d %s, want 502", status, body)
			}
		}
		if h.breakerAllows(in.ID) {
			t.Fatalf("round %d: two failed actions did not degrade the plugin", round)
		}
		h.mu.Lock()
		h.breakerFor(in.ID).openTill = time.Time{}
		h.mu.Unlock()
	}
	state, err := h.Store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Install.Enabled {
		t.Fatal("failing actions disabled the install")
	}
}

func TestConcurrentActionsOnOneRoomDoNotLoseUpdates(t *testing.T) {
	const writers = 8
	h, in := hosted(t, guestAppends(), HostConfig{
		CallTimeout: 10 * time.Second, MaxConcurrentCalls: writers, MaxConcurrentPerInstall: writers,
	}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	ctx := context.Background()
	key, _ := namespacedKey("", "n")
	if err := h.Store.Put(ctx, in.ID, key, []byte("AAA")); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for range writers {
		wg.Go(func() {
			if status, body := r.act(t); status != http.StatusNoContent {
				t.Errorf("got %d %s, want 204", status, body)
			}
		})
	}
	wg.Wait()

	value, _, err := h.Store.Get(ctx, in.ID, key)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(value)/3 - 1; got != writers {
		t.Fatalf("%d of %d concurrent writes survived", got, writers)
	}
}

func TestAnActionThatCannotGetTheRoomIsRefusedRatherThanLeftWaiting(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 150 * time.Millisecond}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	ctx := context.Background()
	key, _ := namespacedKey("", "n")
	if err := h.Store.Put(ctx, in.ID, key, []byte("AAA")); err != nil {
		t.Fatal(err)
	}

	holdRoom(t, h, r.session)

	started := time.Now()
	status, body := r.act(t)
	if status != http.StatusConflict {
		t.Fatalf("got %d %s, want 409", status, body)
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Fatalf("the action waited %s for the room", waited)
	}
	if n := failuresCharged(h, in.ID); n != 0 {
		t.Fatalf("%d failures were charged for a busy room", n)
	}
	if value, _, _ := h.Store.Get(ctx, in.ID, key); len(value) != 3 {
		t.Fatal("the guest ran without the room's lock")
	}
}

// A busy room is one room's problem. However many actions it is sent, it has
// one of them at the lock and the rest in line holding nothing, so it parks
// one connection and takes one in-flight slot, and the room next door runs.
func TestABusyRoomHoldsOneConnectionAndDoesNotDelayAnother(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 10 * time.Second}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	ctx := context.Background()
	key, _ := namespacedKey("", "n")
	if err := h.Store.Put(ctx, in.ID, key, []byte("AAA")); err != nil {
		t.Fatal(err)
	}
	release := holdRoom(t, h, "busy")

	const senders = 4
	var wg sync.WaitGroup
	for range senders {
		wg.Go(func() {
			if status, body := r.actIn(t, "busy"); status != http.StatusNoContent {
				t.Errorf("got %d %s, want 204 once the room was free", status, body)
			}
		})
	}
	eventually(t, "every action for the busy room is in line and its head is at the lock", func() bool {
		return queued(h, "busy") == senders && roomLocks(t, h, "busy", false) == 1
	})
	if n := roomLocks(t, h, "busy", false); n != 1 {
		t.Fatalf("%d connections are parked on one room's lock, want 1", n)
	}
	if n := h.roomLocks.Load(); n != 1 {
		t.Fatalf("the host counts %d lock connections, want 1", n)
	}

	started := time.Now()
	if status, body := r.actIn(t, "quiet"); status != http.StatusNoContent {
		t.Fatalf("the quiet room got %d %s, want 204", status, body)
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Fatalf("the quiet room waited %s behind the busy one", waited)
	}

	release()
	wg.Wait()
	released(t, h, in, "busy")
}

func slotWaiters(h *Host) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.slotWaiters)
}

// With every slot of the install taken, a burst across several rooms waits
// for slots instead of draining as failures: each room's head waits, and the
// rest of each room stays in its line behind it.
func TestActionsPastTheInFlightCapWaitForASlot(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 10 * time.Second}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	key, _ := namespacedKey("", "n")
	if err := h.Store.Put(context.Background(), in.ID, key, []byte("AAA")); err != nil {
		t.Fatal(err)
	}
	// Compile the module first: this is about slots, not about two first
	// calls compiling the same module at once.
	if status, body := r.actIn(t, "warm"); status != http.StatusNoContent {
		t.Fatalf("got %d %s, want 204", status, body)
	}
	// Both of the install's slots are busy with something else.
	for range 2 {
		if !h.acquire(in.ID) {
			t.Fatal("could not take a slot")
		}
	}

	rooms := []string{"one", "two", "three"}
	var wg sync.WaitGroup
	for _, id := range rooms {
		for range 2 {
			wg.Go(func() {
				if status, body := r.actIn(t, id); status != http.StatusNoContent {
					t.Errorf("room %s got %d %s, want 204 once a slot was free", id, status, body)
				}
			})
		}
	}
	eventually(t, "each room's head is waiting for a slot", func() bool { return slotWaiters(h) == len(rooms) })
	if n := h.roomLocks.Load(); n != 0 {
		t.Fatalf("%d connections are held by actions that are only waiting for a slot", n)
	}
	h.release(in.ID)
	h.release(in.ID)
	wg.Wait()
	released(t, h, in, "one")
}

// The wait for a slot ends at the action's deadline, as a plugin at capacity
// and not as a busy room, and leaves nothing behind.
func TestAnActionThatNeverGetsASlotIsToldThePluginIsAtCapacity(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 150 * time.Millisecond}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	for range 2 {
		if !h.acquire(in.ID) {
			t.Fatal("could not take a slot")
		}
	}
	status, body := r.act(t)
	if status != http.StatusServiceUnavailable || body != `{"error":"the plugin is at capacity, try again"}` {
		t.Fatalf("got %d %s, want 503", status, body)
	}
	if n := failuresCharged(h, in.ID); n != 0 {
		t.Fatalf("%d failures were charged for a host at capacity", n)
	}
	h.release(in.ID)
	h.release(in.ID)
	released(t, h, in, r.session)
}

// Slots are handed to waiting actions oldest first, inside release, so one is
// never free for a newcomer while an action waits.
func TestSlotsGoToWaitingActionsInOrder(t *testing.T) {
	h := &Host{cfg: HostConfig{MaxConcurrentCalls: 1, MaxConcurrentPerInstall: 1}.withDefaults(), inflight: map[string]int{}}
	if !h.acquire("a") {
		t.Fatal("could not take the slot")
	}
	by := time.Now().Add(time.Minute)
	order := make(chan string, 2)
	wait := func(name string) {
		go func() {
			if h.acquireBy(context.Background(), "a", by) {
				order <- name
			}
		}()
	}
	wait("first")
	eventually(t, "the first is waiting", func() bool { return slotWaiters(h) == 1 })
	wait("second")
	eventually(t, "the second is waiting", func() bool { return slotWaiters(h) == 2 })

	h.release("a")
	if got := <-order; got != "first" {
		t.Fatalf("the slot went to the %s waiter", got)
	}
	h.release("a")
	if got := <-order; got != "second" {
		t.Fatalf("the slot went to the %s waiter", got)
	}
	if h.acquire("a") {
		t.Fatal("a slot was free while a granted waiter held it")
	}
}

func TestOnlyACheapReportedErrorIsFree(t *testing.T) {
	const timeout = 2 * time.Second
	if !cheap(time.Second, timeout) {
		t.Fatal("a call that took half its timeout should still be cheap")
	}
	if cheap(time.Second+time.Millisecond, timeout) {
		t.Fatal("a call that took more than half its timeout was treated as cheap")
	}
}

// Room locks never take the pool's last connections: the guest holding a lock
// needs one for its own key-value calls.
func TestRoomLocksLeaveTheReserveOfThePoolFree(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 10 * time.Second}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	// As though the pool were down to its reserve plus one.
	h.roomLocks.Add(h.Store.Pool.Config().MaxConns - lockReserve - 1)
	release := holdRoom(t, h, "busy")

	done := make(chan int, 1)
	go func() {
		status, _ := r.actIn(t, "busy")
		done <- status
	}()
	eventually(t, "the busy room's action is at the lock", func() bool { return roomLocks(t, h, "busy", false) == 1 })
	if status, body := r.actIn(t, "quiet"); status != http.StatusServiceUnavailable {
		t.Fatalf("got %d %s, want 503 with the lock allowance spent", status, body)
	}
	release()
	if status := <-done; status != http.StatusNoContent {
		t.Fatalf("the busy room's action got %d, want 204", status)
	}
}

// The line in this process and the lock in Postgres end at one deadline.
func TestAnActionWaitingInLineGivesUpAtTheSameDeadline(t *testing.T) {
	h, in := hosted(t, guestAppends(), HostConfig{CallTimeout: 150 * time.Millisecond}, 1<<20, Grant{Capability: CapabilityKV})
	r := actionRoom(t, h, in)
	holdRoom(t, h, r.session)

	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if status, body := r.act(t); status != http.StatusConflict {
				t.Errorf("got %d %s, want 409", status, body)
			}
		})
	}
	wg.Wait()
	if n := roomLocks(t, h, r.session, false); n != 0 {
		t.Fatalf("%d connections are still parked on the room's lock", n)
	}
}

func TestTheRoomIsReleasedAfterAGuestFault(t *testing.T) {
	h, in := hosted(t, guestTraps(), HostConfig{}, 1024)
	r := actionRoom(t, h, in)
	if status, body := r.act(t); status != http.StatusBadGateway {
		t.Fatalf("got %d %s, want 502", status, body)
	}
	released(t, h, in, r.session)
}

func TestTheRoomIsReleasedWhenTheCallerGoesAwayMidCall(t *testing.T) {
	h, in := hosted(t, guestHangs(), HostConfig{CallTimeout: time.Minute}, 1024)
	st, err := h.Store.State(context.Background(), in.ID)
	if err != nil {
		t.Fatal(err)
	}
	kind := h.PluginKind(st, KindDef{Kind: "k", Actions: []ActionDef{{Name: "act", Verb: http.MethodPost}}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`)).WithContext(ctx)
		kind.Actions["act"].Do(httptest.NewRecorder(), req, session.ActionCtx{
			Session: store.Session{ID: "gone"}, Broadcast: func(context.Context, string) {},
		})
	}()
	eventually(t, "the guest is running under the room's lock", func() bool { return roomLocks(t, h, "gone", true) == 1 })
	cancel()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the action outlived its caller")
	}
	released(t, h, in, "gone")
}

// What kind of failure an action was decides what it costs the plugin. A
// guest that ran to its end and reported an error is not charged: that is all
// a guest validating by throwing does with bad input, and anyone in the room
// can send bad input. A guest that had to be stopped is charged.
func TestOnlyAnActionThatHadToBeStoppedIsCharged(t *testing.T) {
	for _, tc := range []struct {
		name    string
		guest   []byte
		timeout time.Duration
		charged bool
	}{
		// A guest that returns in microseconds gets a budget of seconds, so a
		// slow runner cannot push it past the timeout or past half of it.
		{"reported", guestReports("no such card"), time.Minute, false},
		{"trapped", guestTraps(), time.Minute, true},
		{"timed out", guestHangs(), 200 * time.Millisecond, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, in := hosted(t, tc.guest, HostConfig{
				CallTimeout: tc.timeout, BreakerFailures: 2, BreakerCooldown: time.Hour,
			}, 1024)
			r := actionRoom(t, h, in)
			for range 2 {
				if status, body := r.act(t); status != http.StatusBadGateway {
					t.Fatalf("got %d %s, want 502", status, body)
				}
			}
			if degraded := !h.breakerAllows(in.ID); degraded != tc.charged {
				t.Fatalf("degraded = %v after two such actions, want %v", degraded, tc.charged)
			}
		})
	}
}

// The same reported error from any other hook is charged as it always was:
// nobody in a room chooses when those run.
func TestAReportedErrorOutsideAnActionIsStillCharged(t *testing.T) {
	h, in := hosted(t, guestReports("no"), HostConfig{BreakerFailures: 2, BreakerCooldown: time.Hour}, 1024)
	for range 2 {
		if _, err := h.Call(context.Background(), in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestReported) {
			t.Fatalf("got %v, want ErrGuestReported", err)
		}
	}
	if h.breakerAllows(in.ID) {
		t.Fatal("two reported errors from a hook did not degrade the plugin")
	}
}

// Failed actions are counted apart, so a room cannot bring the count one
// short of a trip and leave an unrelated hook failure to finish it.
func TestFailedActionsDoNotCountTowardAHookTrip(t *testing.T) {
	h, in := hosted(t, guestTraps(), HostConfig{BreakerFailures: 2, BreakerTripLimit: 1, BreakerCooldown: time.Hour}, 1024)
	r := actionRoom(t, h, in)
	if status, body := r.act(t); status != http.StatusBadGateway {
		t.Fatalf("got %d %s, want 502", status, body)
	}
	if _, err := h.Call(context.Background(), in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("got %v, want ErrGuestPanic", err)
	}
	state, err := h.Store.State(context.Background(), in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Install.Enabled || !h.breakerAllows(in.ID) {
		t.Fatal("one failed action and one failed hook tripped a breaker set to two failures")
	}
}

func TestARefusalKeyIsMatchedExactly(t *testing.T) {
	h, in := hosted(t, guestReplies(`{"REFUSED":"invalid"}`), HostConfig{}, 1024)
	r := actionRoom(t, h, in)
	if status, body := r.act(t); status != http.StatusNoContent {
		t.Fatalf("got %d %s, want 204: only the exact key is a refusal", status, body)
	}
}
