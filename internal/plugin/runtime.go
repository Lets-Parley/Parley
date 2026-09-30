package plugin

import (
	"context"
	"log/slog"
	"sync"
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

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewRuntime wires a runtime over a bundle source. It always runs: bundles
// live in plugin_bundles as well as PLUGIN_DIR, so an instance without the
// directory still hosts the installs whose bundles are stored. A module is
// only compiled when an enabled install is first called.
func NewRuntime(store *Store, bundles Bundles, limits HostConfig, log *slog.Logger) *Runtime {
	host := NewHost(store, limits)
	host.Log = log
	host.Bus = &Bus{Pool: store.Pool}
	host.Queue = &Queue{Pool: store.Pool, Log: log}
	host.Bundles = bundles
	host.Queue.Run = host.RunJob
	return &Runtime{
		Host:   host,
		Bus:    host.Bus,
		Queue:  host.Queue,
		Outbox: &Outbox{Pool: store.Pool, Log: log, Deliver: host.DeliverEvent},
	}
}

// Start runs the outbox and job workers until ctx is done or Close is called.
func (r *Runtime) Start(ctx context.Context) {
	ctx, r.cancel = context.WithCancel(ctx)
	r.wg.Add(2)
	go func() { defer r.wg.Done(); r.Outbox.Run(ctx, DefaultInterval) }()
	go func() { defer r.wg.Done(); r.Queue.RunWorker(ctx, DefaultInterval) }()
}

// Close stops the workers, waits for them to return, and releases every
// compiled module. The caller may close the pool once it returns.
func (r *Runtime) Close() {
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
	r.Host.Close(context.Background())
}
