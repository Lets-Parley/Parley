package plugin

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
)

// An install pinned to one row runs that row's bytes, even once a row the
// name-and-version lookup prefers is stored beside it.
func TestAPinnedInstallRunsExactlyTheBytesItWasPinnedTo(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	key := testKey(t)
	bs := &BundleStore{Pool: store.Pool, Trusted: []ed25519.PublicKey{pubOf(key)}, AllowUnsigned: true, Log: quietLogger()}
	unsigned, err := bs.Insert(ctx, packed(t, in.Name, guestPanic(), nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PinInstalls(ctx, bs.TrustedKeyIDs(), quietLogger()); err != nil {
		t.Fatal(err)
	}
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Bundle == nil || state.Install.Bundle.Digest != unsigned.Digest || state.Install.Bundle.KeyID != "" {
		t.Fatalf("the boot pin chose %+v, want the unsigned row %s", state.Install.Bundle, unsigned.Digest)
	}
	// A signed row for the same name and version: Resolve now prefers it.
	if _, err := bs.Insert(ctx, packed(t, in.Name, guestNoop(), key), nil); err != nil {
		t.Fatal(err)
	}
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = bs
	t.Cleanup(func() { h.Close(ctx) })
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("got %v, want ErrGuestPanic from the pinned unsigned bundle", err)
	}
	if got := h.LoadedBundles(); len(got) != 1 || got[0] != unsigned.Digest+"/" {
		t.Fatalf("loaded bundles = %v, want the pinned digest", got)
	}
}

// The boot pin never disables an install it cannot match, and records what it
// pins so a rollback can name it later.
func TestPinInstallsLeavesAnUnmatchedInstallRunning(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	matched, unmatched := install(t, store), install(t, store)
	bs, b := storedBundle(t, store.Pool, matched.Name, guestNoop())
	if err := store.PinInstalls(ctx, bs.TrustedKeyIDs(), quietLogger()); err != nil {
		t.Fatal(err)
	}
	st, _ := store.State(ctx, unmatched.ID)
	if st.Install.Bundle != nil || !st.Install.Enabled {
		t.Fatalf("unmatched install = %+v, want unpinned and still enabled", st.Install)
	}
	adm := store.InOrg(testOrgID)
	if ran, err := adm.Ran(ctx, matched.ID, BundleRef{Digest: b.Digest, KeyID: b.KeyID}); err != nil || !ran {
		t.Fatalf("Ran(pinned) = %v, %v, want true", ran, err)
	}
	if ran, err := adm.Ran(ctx, matched.ID, BundleRef{Digest: "other", KeyID: b.KeyID}); err != nil || ran {
		t.Fatalf("Ran(never pinned) = %v, %v, want false", ran, err)
	}
}

// Enable compiles first. A bundle that will not load leaves the install off
// and nothing resident.
func TestEnableLeavesAnInstallOffWhenItsBundleWillNotLoad(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	if err := store.SetEnabled(ctx, in.ID, false); err != nil {
		t.Fatal(err)
	}
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = bundles{}
	if err := h.Enable(ctx, in.ID); err == nil {
		t.Fatal("enabling an install with no bundle succeeded")
	}
	st, _ := store.State(ctx, in.ID)
	if st.Install.Enabled {
		t.Fatal("a failed enable left the install enabled")
	}
	if h.CachedModules() != 0 {
		t.Fatal("a failed enable left a module resident")
	}
}
