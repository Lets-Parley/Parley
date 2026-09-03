package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Without a bundle directory there is no host, and the workers keep the nil
// handlers that make them drain nothing.
func TestWithoutABundleDirectoryThereIsNoPluginRuntime(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	if r := NewRuntime(store, "", HostConfig{}, quietLogger()); r != nil {
		t.Fatalf("a runtime was wired with no bundle directory: %+v", r)
	}
}

// The wiring test the guards do not cover. Every fixture in this package calls
// the host directly, so the two lines that point the workers at the host can
// be deleted without a single assertion moving — and an instance would then
// accept jobs and events and run no plugin code at all. This drives both
// handlers end to end, through a real bundle on disk.
func TestTheRuntimePointsBothWorkersAtTheHost(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityKV})
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, state.Install.Name+"-1.0.0.wasm"), guestPanicExporting("on_job", "on_event"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := NewRuntime(store, dir, HostConfig{}, quietLogger())
	if r == nil {
		t.Fatal("no runtime was wired for a bundle directory")
	}
	t.Cleanup(r.Close)

	// The guest traps, so reaching it is what ErrGuestPanic proves: a nil or
	// misdirected handler cannot produce it.
	if err := r.Queue.Run(ctx, Job{InstallID: in.ID, Kind: "k"}); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("the job handler returned %v; want ErrGuestPanic, which only the host can produce", err)
	}
	if err := r.Outbox.Deliver(ctx, Delivery{
		InstallID: in.ID, Topic: "t", Payload: json.RawMessage(`{}`),
	}); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("the delivery handler returned %v; want ErrGuestPanic", err)
	}
	if r.Host.Bus == nil || r.Host.Queue == nil {
		t.Fatal("the host must hold the bus and the queue, or parley_emit and parley_job_enqueue refuse")
	}
}

// Start's two `go` statements are the whole of the plugin runtime's liveness,
// and nothing else in the package goes through them: every other test drives
// the handlers directly, so deleting either one leaves the suite green while a
// real instance quietly runs no plugin jobs, or delivers no plugin events, for
// the life of the process.
//
// So this one never touches a handler. It enqueues a job and publishes an
// event, starts the runtime, and waits for the workers to pick both rows up —
// the attempt counter moving is something only a running worker can do.
func TestStartRunsBothWorkersWithoutAnybodyCallingTheHandlers(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	subject := topic(t)
	in := install(t, store,
		Grant{Capability: CapabilityJobs},
		Grant{Capability: CapabilityEvents, Scope: subject})
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, state.Install.Name+"-1.0.0.wasm"),
		guestPanicExporting("on_job", "on_event"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := NewRuntime(store, dir, HostConfig{}, quietLogger())
	if r == nil {
		t.Fatal("no runtime was wired for a bundle directory")
	}
	t.Cleanup(r.Close)

	jobID, err := r.Queue.Enqueue(ctx, Job{InstallID: in.ID, Kind: "work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Bus.WithEvents(ctx,
		[]Event{{Topic: subject, Payload: json.RawMessage(`{}`)}},
		func(pgx.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}

	// Nothing has run yet: the rows are the workers' to find.
	if attempts := jobAttempts(t, store, jobID); attempts != 0 {
		t.Fatalf("the job already has %d attempts before the runtime started", attempts)
	}

	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	r.Start(runCtx)

	// The guest traps, so a claimed row records a failed attempt rather than
	// completing — either way the counter only moves if a worker touched it.
	deadline := time.Now().Add(20 * time.Second)
	var jobSeen, deliverySeen bool
	for time.Now().Before(deadline) && !(jobSeen && deliverySeen) {
		jobSeen = jobSeen || jobAttempts(t, store, jobID) > 0
		deliverySeen = deliverySeen || deliveryAttempts(t, store, in.ID, subject) > 0
		if jobSeen && deliverySeen {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !jobSeen {
		t.Error("the job was never claimed: Start did not run the job worker")
	}
	if !deliverySeen {
		t.Error("the delivery was never claimed: Start did not run the outbox worker")
	}
}

func jobAttempts(t *testing.T, s *Store, id int64) int {
	t.Helper()
	var attempts int
	if err := s.Pool.QueryRow(context.Background(),
		`select attempts from plugin_jobs where id = $1`, id).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	return attempts
}

func deliveryAttempts(t *testing.T, s *Store, installID, subject string) int {
	t.Helper()
	var attempts int
	if err := s.Pool.QueryRow(context.Background(), `
		select d.attempts from plugin_deliveries d
		join plugin_events e on e.id = d.event_id
		where d.install_id = $1 and e.topic = $2`, installID, subject).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	return attempts
}
