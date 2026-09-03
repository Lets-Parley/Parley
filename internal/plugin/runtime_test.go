package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
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
