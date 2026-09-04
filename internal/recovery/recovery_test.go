package recovery

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// captureLog points the default logger at a buffer for the duration of one
// test. Handle and Log write through slog's default logger on purpose: the
// process configures that once at startup, and a panic report that went
// somewhere else would not reach the operator's log pipeline.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	if buf.Len() == 0 {
		t.Fatal("a recovered panic logged nothing at all")
	}
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("log line is not one JSON object: %v (%q)", err, buf.String())
	}
	return line
}

// The log line is the whole product of recovery: a panic that is swallowed
// silently is worse than the crash it replaced, because nobody ever learns the
// bug exists. Its shape is documented for operators to alert on, so it is
// pinned here rather than left to drift.
func TestHandleLogsTheRecoveredPanic(t *testing.T) {
	buf := captureLog(t)

	func() {
		defer Handle("presence sweeper", "session", "01J")
		panic("sweeper exploded")
	}()

	line := decode(t, buf)
	if got := line["level"]; got != "ERROR" {
		t.Errorf("level = %v, want ERROR", got)
	}
	if got := line["msg"]; got != "recovered a panic in a background goroutine" {
		t.Errorf("msg = %v, want the documented message", got)
	}
	if got := line["goroutine"]; got != "presence sweeper" {
		t.Errorf("goroutine = %v, want presence sweeper", got)
	}
	if got := line["panic"]; got != "sweeper exploded" {
		t.Errorf("panic = %v, want sweeper exploded", got)
	}
	if got := line["session"]; got != "01J" {
		t.Errorf("session = %v, want the caller's extra attribute", got)
	}
	stack, _ := line["stack"].(string)
	if !strings.Contains(stack, "TestHandleLogsTheRecoveredPanic") {
		t.Errorf("stack does not reach the panicking frame: %q", stack)
	}
}

// Handle must swallow the panic, not merely observe it on the way past.
func TestHandleStopsThePanic(t *testing.T) {
	captureLog(t)
	survived := false
	func() {
		defer func() { survived = true }()
		defer Handle("hub callback")
		panic("callback exploded")
	}()
	if !survived {
		t.Fatal("Handle let the panic through")
	}
}

// A goroutine with nothing to recover must log nothing: an unconditional line
// would make the alert on this message useless.
func TestHandleIsSilentWithoutAPanic(t *testing.T) {
	buf := captureLog(t)
	func() { defer Handle("quiet worker") }()
	if buf.Len() != 0 {
		t.Fatalf("logged without a panic: %q", buf.String())
	}
}

// Log is the seam for a caller that recovers itself — the fanout listener turns
// its panic into a reconnect — and must produce the same line Handle would.
func TestLogMatchesHandlesShape(t *testing.T) {
	buf := captureLog(t)
	Log("listener exploded", "session notification listener")

	line := decode(t, buf)
	if got := line["msg"]; got != "recovered a panic in a background goroutine" {
		t.Errorf("msg = %v, want the documented message", got)
	}
	if got := line["goroutine"]; got != "session notification listener" {
		t.Errorf("goroutine = %v, want the listener", got)
	}
	if got := line["panic"]; got != "listener exploded" {
		t.Errorf("panic = %v, want listener exploded", got)
	}
	if _, ok := line["stack"].(string); !ok {
		t.Error("no stack on a Log line")
	}
}
