package plugin

import (
	"context"
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

// buildAction finishes the module with one on_session_action export, which is
// the export the action path calls.
func (b *guestBuilder) buildAction(locals []wasm.ValueType, body []byte) []byte {
	b.types = append(b.types, &wasm.FunctionType{Results: []wasm.ValueType{wasm.ValueTypeI32}})
	m := &wasm.Module{
		TypeSection:     b.types,
		ImportSection:   b.imports,
		FunctionSection: []wasm.Index{uint32(len(b.types) - 1)},
		ExportSection: []*wasm.Export{{
			Type: wasm.ExternTypeFunc, Name: ExportSessionAction, Index: uint32(len(b.imports)),
		}},
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
		kind.Actions["act"].Do(w, req, session.ActionCtx{
			Session:   store.Session{ID: r.session},
			UserID:    "someone",
			Broadcast: func(context.Context, string) { r.broadcasts.Add(1) },
		})
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *room) act(t *testing.T) (int, string) {
	t.Helper()
	resp, err := http.Post(r.URL, "application/json", strings.NewReader(`{}`))
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
	return h.breakerFor(installID).failures
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

	// Another replica, mid-action on the same room.
	tx, err := h.Store.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1, hashtext($2))`, actionLockClass, r.session); err != nil {
		t.Fatal(err)
	}

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
