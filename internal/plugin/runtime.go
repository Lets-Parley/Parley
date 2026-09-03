package plugin

import (
	"context"
	"log/slog"
)

// Runtime is the plugin machinery an instance runs: the host, the bus, and the
// two workers whose handlers are the host's.
//
// It exists as a type rather than as a dozen lines in main so that the wiring
// can be tested. The wiring is the part with no other cover: every guard in
// this package is exercised by a fixture that calls the host directly, so
// dropping the one line that points the job worker at the host leaves the
// whole suite green while the server silently runs no plugin jobs at all.
type Runtime struct {
	Host   *Host
	Bus    *Bus
	Queue  *Queue
	Outbox *Outbox
}

// NewRuntime wires a runtime for a bundle directory, or returns nil when there
// is no directory to serve. Nil is the "no plugins" answer on purpose: an
// instance without PLUGIN_DIR never instantiates a WASM runtime, and making
// that a nil Runtime rather than an `if` in the caller means both halves of
// the decision are testable here.
func NewRuntime(store *Store, dir string, limits HostConfig, log *slog.Logger) *Runtime {
	if dir == "" {
		return nil
	}
	host := NewHost(store, limits)
	host.Log = log
	host.Bus = &Bus{Pool: store.Pool}
	host.Queue = &Queue{Pool: store.Pool, Log: log}
	host.Bundles = DirBundles(dir)
	host.Queue.Run = host.RunJob
	return &Runtime{
		Host:   host,
		Bus:    host.Bus,
		Queue:  host.Queue,
		Outbox: &Outbox{Pool: store.Pool, Log: log, Deliver: host.DeliverEvent},
	}
}

// Start runs the outbox and job workers until ctx is done.
func (r *Runtime) Start(ctx context.Context) {
	go r.Outbox.Run(ctx, DefaultInterval)
	go r.Queue.RunWorker(ctx, DefaultInterval)
}

// Close releases every compiled module.
func (r *Runtime) Close() { r.Host.Close(context.Background()) }
