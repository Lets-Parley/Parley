// Package recovery contains the one thing every long-lived goroutine in the
// process needs: a panic in it must not be a panic in the process.
//
// middleware.Recoverer covers HTTP handlers, and nothing else. Everything that
// runs outside a request — the hub's socket pumps and callbacks, the fanout
// listener, the presence sweeper, the plugin retention, outbox and job loops —
// is a goroutine whose panic would take the whole server down, taking every
// other room's live session with it.
package recovery

import (
	"fmt"
	"log/slog"
	"runtime/debug"
)

// Handle recovers a panic in the goroutine that deferred it and logs it at
// error with a stack. `what` names the goroutine.
//
//	defer recovery.Handle("presence sweeper")
//
// It must be deferred directly, never called from inside another deferred
// closure: recover only works when it is the deferred function that calls it.
// A caller that needs to react to the panic — restart a loop, turn it into an
// error — recovers itself and calls Log.
func Handle(what string, attrs ...any) {
	if r := recover(); r != nil {
		Log(r, what, attrs...)
	}
}

// Log records an already-recovered panic in the shape Handle would have used.
func Log(r any, what string, attrs ...any) {
	// Fields, not a formatted line: the stack is multi-line and the goroutine
	// name is what an operator greps for.
	args := []any{"goroutine", what, "panic", fmt.Sprint(r), "stack", string(debug.Stack())}
	slog.Error("recovered a panic in a background goroutine", append(args, attrs...)...)
}
