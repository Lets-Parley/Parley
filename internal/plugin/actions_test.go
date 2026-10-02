package plugin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	opLocalGet = 0x20
	opLocalSet = 0x21
	opI64Const = 0x42
	opI64Add   = 0x7c
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
	b := h.breakerFor(installID)
	return b.failures + b.actionFailures
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

func TestOnlyACheapReportedErrorIsFree(t *testing.T) {
	const timeout = 2 * time.Second
	if !cheap(time.Second, timeout) {
		t.Fatal("a call that took half its timeout should still be cheap")
	}
	if cheap(time.Second+time.Millisecond, timeout) {
		t.Fatal("a call that took more than half its timeout was treated as cheap")
	}
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

// The same reported error, from the same guest, is free or charged by how
// long the call took. The host's clock is driven here, so neither side
// depends on how fast the runner is.
func TestAReportedActionErrorIsChargedOnceItUsedMostOfItsCall(t *testing.T) {
	for _, tc := range []struct {
		name    string
		took    time.Duration
		charged bool
	}{
		{"a tenth of the timeout", 6 * time.Second, false},
		{"two thirds of the timeout", 40 * time.Second, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, in := hosted(t, guestReports("no such card"), HostConfig{
				CallTimeout: time.Minute, BreakerFailures: 2, BreakerCooldown: time.Hour,
			}, 1024)
			// Each reading of the clock is tc.took after the one before, and
			// a call reads it once before the guest runs and once after.
			var tick atomic.Int64
			h.now = func() time.Time { return time.Unix(0, 0).Add(time.Duration(tick.Add(1)) * tc.took) }
			r := actionRoom(t, h, in)
			for range 2 {
				if status, body := r.act(t); status != http.StatusBadGateway {
					t.Fatalf("got %d %s, want 502", status, body)
				}
			}
			if degraded := !h.breakerAllows(in.ID); degraded != tc.charged {
				t.Fatalf("degraded = %v after two reported errors that each took %s of a minute, want %v", degraded, tc.took, tc.charged)
			}
		})
	}
}
