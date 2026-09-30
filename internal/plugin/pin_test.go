package plugin

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/lets-parley/parley/internal/plugin/bundle"
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

func packVer(t *testing.T, name, version string, key ed25519.PrivateKey) []byte {
	t.Helper()
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": guestNoop()},
		[]byte(fmt.Sprintf(`{"name":%q,"version":%q}`, name, version)), key)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func rawPin(t *testing.T, s *Store, id string) string {
	t.Helper()
	var d *string
	if err := s.Pool.QueryRow(context.Background(), `select bundle_digest from plugin_installs where id = $1`, id).Scan(&d); err != nil {
		t.Fatal(err)
	}
	if d == nil {
		return ""
	}
	return *d
}

// A pinned install and an upgrade that brings no bundle: the pin stays, and
// because its version no longer matches it stops being authoritative until the
// boot pin re-derives it.
func TestAnUnpinnedUpgradeNeverClearsAPinAndAStalePinIsNotAuthoritative(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	key := testKey(t)
	bs := &BundleStore{Pool: store.Pool, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	name := uniqueName(t)
	a, err := bs.Insert(ctx, packVer(t, name, "1.0.0", key), nil)
	if err != nil {
		t.Fatal(err)
	}
	in, err := store.Install(ctx, InstallRequest{OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Bundle: &BundleRef{Digest: a.Digest, KeyID: a.KeyID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upgrade(ctx, in.ID, "2.0.0", nil, nil); err != nil {
		t.Fatal(err)
	}
	if rawPin(t, store, in.ID) != a.Digest {
		t.Fatal("an upgrade with no bundle cleared the pin")
	}
	if st, _ := store.State(ctx, in.ID); st.Install.Bundle != nil {
		t.Fatalf("a pin for 1.0.0 is authoritative for 2.0.0: %+v", st.Install.Bundle)
	}
	b, err := bs.Insert(ctx, packVer(t, name, "2.0.0", key), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PinInstalls(ctx, bs.TrustedKeyIDs(), quietLogger()); err != nil {
		t.Fatal(err)
	}
	if rawPin(t, store, in.ID) != b.Digest {
		t.Fatal("the boot pin did not re-derive a stale pin")
	}
}

// Install records its pin, and approving a widening upgrade applies the
// staged one and records it too.
func TestApprovingAnUpgradeAppliesAndRecordsItsPin(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	key := testKey(t)
	bs := &BundleStore{Pool: store.Pool, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	name := uniqueName(t)
	a, _ := bs.Insert(ctx, packVer(t, name, "1.0.0", key), nil)
	b, _ := bs.Insert(ctx, packVer(t, name, "2.0.0", key), nil)
	refA, refB := BundleRef{Digest: a.Digest, KeyID: a.KeyID}, BundleRef{Digest: b.Digest, KeyID: b.KeyID}
	in, err := store.Install(ctx, InstallRequest{OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024, Bundle: &refA})
	if err != nil {
		t.Fatal(err)
	}
	adm := store.InOrg(testOrgID)
	if ran, _ := adm.Ran(ctx, in.ID, refA); !ran {
		t.Fatal("install did not record its pin")
	}
	if err := store.UpgradeTo(ctx, in.ID, "2.0.0", []Grant{{Capability: CapabilityLog}}, nil, &refB); !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("got %v, want pending", err)
	}
	if err := store.ApproveUpgrade(ctx, in.ID); err != nil {
		t.Fatal(err)
	}
	if rawPin(t, store, in.ID) != b.Digest {
		t.Fatal("approval did not apply the staged pin")
	}
	if ran, _ := adm.Ran(ctx, in.ID, refB); !ran {
		t.Fatal("approval did not record the pin")
	}
}

// The boot pin matches only bundles trusted now.
func TestPinInstallsSkipsAnUntrustedBundle(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	bs := &BundleStore{Pool: store.Pool, AllowUnsigned: true, Log: quietLogger()}
	if _, err := bs.Insert(ctx, packed(t, in.Name, guestNoop(), nil), nil); err != nil {
		t.Fatal(err)
	}
	if err := store.PinInstalls(ctx, []string{"somekey"}, quietLogger()); err != nil {
		t.Fatal(err)
	}
	if rawPin(t, store, in.ID) != "" {
		t.Fatal("the boot pin chose a bundle this instance does not trust")
	}
}

// An install that has a pin only ever runs stored, trusted rows: a stale pin
// never falls through to a loose file, and a stored row for its version
// re-pins it.
func TestAStalePinNeverRunsALooseFile(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	key := testKey(t)
	dir := t.TempDir()
	bs := &BundleStore{Pool: store.Pool, Dir: dir, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	name := uniqueName(t)
	a, _ := bs.Insert(ctx, packVer(t, name, "1.0.0", key), nil)
	in, err := store.Install(ctx, InstallRequest{OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Bundle: &BundleRef{Digest: a.Digest, KeyID: a.KeyID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upgrade(ctx, in.ID, "2.0.0", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+"-2.0.0.wasm"), guestNoop(), 0o600); err != nil {
		t.Fatal(err)
	}
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = bs
	t.Cleanup(func() { h.Close(ctx) })
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrNoBundle) {
		t.Fatalf("a stale-pinned install with only a loose file: got %v, want ErrNoBundle", err)
	}
	b, _ := bs.Insert(ctx, packVer(t, name, "2.0.0", key), nil)
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); err != nil {
		t.Fatalf("with a stored row: %v", err)
	}
	if rawPin(t, store, in.ID) != b.Digest {
		t.Fatal("the stored row did not re-pin the install")
	}
}

// Approving an upgrade that staged no bundle keeps the pin it had.
func TestApprovingAnUnpinnedUpgradeKeepsThePin(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	key := testKey(t)
	bs := &BundleStore{Pool: store.Pool, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	name := uniqueName(t)
	a, _ := bs.Insert(ctx, packVer(t, name, "1.0.0", key), nil)
	in, err := store.Install(ctx, InstallRequest{OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Bundle: &BundleRef{Digest: a.Digest, KeyID: a.KeyID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upgrade(ctx, in.ID, "2.0.0", []Grant{{Capability: CapabilityLog}}, nil); !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("got %v, want pending", err)
	}
	if err := store.ApproveUpgrade(ctx, in.ID); err != nil {
		t.Fatal(err)
	}
	if rawPin(t, store, in.ID) != a.Digest {
		t.Fatal("approving an upgrade with no staged bundle cleared the pin")
	}
}
