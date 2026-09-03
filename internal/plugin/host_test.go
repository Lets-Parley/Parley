package plugin

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// bundles is an in-memory bundle source keyed the way a real one is.
type bundles map[string][]byte

func (b bundles) Load(_ context.Context, name, version string) ([]byte, error) {
	wasm, ok := b[name+"@"+version]
	if !ok {
		return nil, fmt.Errorf("no bundle for %s %s", name, version)
	}
	return wasm, nil
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// hosted builds a store, an install with the given grants, and a host serving
// the given guest.
func hosted(t *testing.T, guest []byte, cfg HostConfig, quota int64, grants ...Grant) (*Host, Install) {
	t.Helper()
	store := &Store{Pool: testPool(t)}
	installNo++
	name := fmt.Sprintf("%s-%d-%d", strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")), time.Now().UnixNano(), installNo)
	got, err := store.Install(context.Background(), InstallRequest{
		Name: name, Version: "1.0.0", Grants: grants, QuotaBytes: quota,
	})
	if err != nil {
		t.Fatal(err)
	}
	h := NewHost(store, cfg)
	h.Log = quietLogger()
	h.Bundles = bundles{name + "@1.0.0": guest}
	t.Cleanup(func() { h.Close(context.Background()) })
	return h, got
}

func TestAHangingPluginIsStoppedByTheCallTimeout(t *testing.T) {
	timeout := 300 * time.Millisecond
	h, in := hosted(t, guestHang(), HostConfig{CallTimeout: timeout}, 1024)

	started := time.Now()
	_, err := h.Call(context.Background(), in.ID, "run", nil, ModeAsync)
	elapsed := time.Since(started)

	if !errors.Is(err, ErrCallTimeout) {
		t.Fatalf("got %v, want ErrCallTimeout", err)
	}
	// A lower bound, because "the room survived" also passes when the guest
	// returned instantly and nothing was contained.
	if elapsed < timeout {
		t.Fatalf("the call returned after %s, which is less than the %s timeout; the guest cannot have been running",
			elapsed, timeout)
	}
	if elapsed > 10*timeout {
		t.Fatalf("the call took %s; the timeout did not stop it promptly", elapsed)
	}
}

func TestAMemoryHungryPluginIsStoppedByTheMemoryCap(t *testing.T) {
	// The cap is 16 pages; the guest asks for 512 more and then writes where
	// page 400 would be.
	h, in := hosted(t, guestMemoryHog(512, 400*65536), HostConfig{MemoryPages: 16}, 1024)

	_, err := h.Call(context.Background(), in.ID, "run", nil, ModeAsync)
	if !errors.Is(err, ErrGuestMemory) {
		t.Fatalf("got %v, want ErrGuestMemory", err)
	}
}

func TestAPanickingPluginDoesNotTakeTheProcessWithIt(t *testing.T) {
	h, in := hosted(t, guestPanic(), HostConfig{}, 1024)
	_, err := h.Call(context.Background(), in.ID, "run", nil, ModeAsync)
	if !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("got %v, want ErrGuestPanic", err)
	}

	// The host is still usable afterwards, which is the other half of the
	// claim: recovering must not leave the runtime wedged.
	healthy, in2 := hosted(t, guestNoop(), HostConfig{}, 1024)
	if _, err := healthy.Call(context.Background(), in2.ID, "run", nil, ModeAsync); err != nil {
		t.Fatalf("a healthy plugin should still run after a trap: %v", err)
	}
}

func TestAFetchToALinkLocalAddressIsBlockedInsideTheHostFunction(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_fetch"), HostConfig{},
		1024, Grant{Capability: CapabilityFetch, Scope: "metadata.example.com"})
	h.Fetcher = &Fetcher{resolve: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
	}}

	req, _ := json.Marshal(FetchRequest{URL: "https://metadata.example.com/latest/meta-data/"})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrFetchBlockedAddress) {
		t.Fatalf("host errors %v; want ErrFetchBlockedAddress", report.HostErrors)
	}
}

func TestAFetchRedirectedToADisallowedHostIsBlockedOnTheHop(t *testing.T) {
	_, offPort := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("the plugin must never read this"))
	})
	var toOff string
	_, startPort := serve(t, func(w http.ResponseWriter, _ *http.Request) { redirect(w, toOff) })
	toOff = "https://off.example.com:" + offPort + "/"

	h, in := hosted(t, guestCallsHost("parley_fetch"), HostConfig{},
		1024, Grant{Capability: CapabilityFetch, Scope: "start.example.com"})
	h.Fetcher = testFetcher(t, map[string]string{"start.example.com": "", "off.example.com": ""})

	req, _ := json.Marshal(FetchRequest{URL: "https://start.example.com:" + startPort + "/"})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrFetchHostNotAllowed) {
		t.Fatalf("host errors %v; want ErrFetchHostNotAllowed on the redirect hop", report.HostErrors)
	}
}

func TestASynchronousHookCannotFetchThroughTheHostFunction(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_fetch"), HostConfig{},
		1024, Grant{Capability: CapabilityFetch, Scope: "api.example.com"})
	h.Fetcher = &Fetcher{tlsConfig: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec // never dialled

	req, _ := json.Marshal(FetchRequest{URL: "https://api.example.com/"})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeSync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrFetchSynchronousHook) {
		t.Fatalf("host errors %v; want ErrFetchSynchronousHook even with the grant", report.HostErrors)
	}
}

func TestAPluginPastItsStorageQuotaIsRefused(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_kv_set"), HostConfig{},
		8, Grant{Capability: CapabilityKV})

	req, _ := json.Marshal(kvRequest{Key: "big", Value: make([]byte, 64)})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrQuotaExceeded) {
		t.Fatalf("host errors %v; want ErrQuotaExceeded", report.HostErrors)
	}
}

func TestAForgedKeyCannotReachAnotherNamespace(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_kv_set"), HostConfig{},
		4096, Grant{Capability: CapabilityKV, Scope: "cache"})

	// The separator is the only thing between one scope's keys and another's,
	// so a key carrying it is refused rather than escaped.
	req, _ := json.Marshal(kvRequest{Scope: "cache", Key: "a" + kvSeparator + "secrets"})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrForgedKey) {
		t.Fatalf("host errors %v; want ErrForgedKey", report.HostErrors)
	}

	// And a scope the install was never granted is refused outright.
	req, _ = json.Marshal(kvRequest{Scope: "secrets", Key: "k", Value: []byte("v")})
	_, report, err = h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrNotGranted) {
		t.Fatalf("host errors %v; want ErrNotGranted for an ungranted scope", report.HostErrors)
	}
}

func TestTwoInstallsCannotSeeEachOthersKeysUnderTheSameKey(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	a := install(t, store, Grant{Capability: CapabilityKV})
	b := install(t, store, Grant{Capability: CapabilityKV})

	key, err := namespacedKey("", "shared")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), a.ID, key, []byte("a's")); err != nil {
		t.Fatal(err)
	}
	value, found, err := store.Get(context.Background(), b.ID, key)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Fatalf("install b read %q from install a's namespace", value)
	}
}

func TestAnUngrantedCapabilityIsRefusedInsideTheHostFunction(t *testing.T) {
	// No grants at all: the guest asks anyway.
	h, in := hosted(t, guestCallsHost("parley_kv_set"), HostConfig{}, 1024)
	req, _ := json.Marshal(kvRequest{Key: "k", Value: []byte("v")})
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrNotGranted) {
		t.Fatalf("host errors %v; want ErrNotGranted", report.HostErrors)
	}
}

func TestAGrantRevokedMidLifeStopsWorkingOnTheNextCall(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_kv_set"), HostConfig{},
		4096, Grant{Capability: CapabilityKV})
	ctx := context.Background()
	req, _ := json.Marshal(kvRequest{Key: "k", Value: []byte("v")})

	_, report, err := h.CallWithReport(ctx, in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.HostErrors) != 0 {
		t.Fatalf("the granted call should have succeeded: %v", report.HostErrors)
	}

	// The grant is checked against the install record on every call, so
	// revoking it takes effect now rather than at the next restart.
	if _, err := h.Store.Pool.Exec(ctx,
		`delete from plugin_grants where install_id = $1`, in.ID); err != nil {
		t.Fatal(err)
	}
	_, report, err = h.CallWithReport(ctx, in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrNotGranted) {
		t.Fatalf("host errors %v; want ErrNotGranted after the revoke", report.HostErrors)
	}
}

func TestInFlightCallsAreCappedPerInstallAndInTotal(t *testing.T) {
	h, in := hosted(t, guestHang(), HostConfig{
		CallTimeout: 2 * time.Second, MaxConcurrentCalls: 4, MaxConcurrentPerInstall: 2,
	}, 1024)
	ctx := context.Background()

	var wg sync.WaitGroup
	var mu sync.Mutex
	var busy int
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := h.Call(ctx, in.ID, "run", nil, ModeAsync)
			if errors.Is(err, ErrTooBusy) {
				mu.Lock()
				busy++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if busy < 4 {
		t.Fatalf("%d of 6 concurrent calls were refused; with a per-install cap of 2 at least 4 should be", busy)
	}
}

func TestARepeatedlyFailingPluginIsDegradedAndThenDisabled(t *testing.T) {
	h, in := hosted(t, guestPanic(), HostConfig{
		BreakerFailures: 2, BreakerTripLimit: 2, BreakerCooldown: time.Millisecond,
	}, 1024)
	ctx := context.Background()

	// Two failures degrade it.
	for range 2 {
		if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
			t.Fatalf("got %v, want ErrGuestPanic", err)
		}
	}
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("got %v, want ErrCircuitOpen while degraded", err)
	}

	// Past the cooldown, two more failures exhaust it and it is disabled for
	// good — durably, not just in this process's memory.
	time.Sleep(5 * time.Millisecond)
	for range 2 {
		_, _ = h.Call(ctx, in.ID, "run", nil, ModeAsync)
	}
	state, err := h.Store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Enabled {
		t.Fatal("a plugin that degraded past its trip limit should be disabled")
	}
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrDisabled) {
		t.Fatalf("got %v, want ErrDisabled", err)
	}
	if h.CachedModules() != 0 {
		t.Fatal("disabling a plugin must evict its compiled module rather than leave it resident")
	}
}

func TestTheCompiledModuleCacheIsBounded(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	h := NewHost(store, HostConfig{MaxCachedModules: 2})
	h.Log = quietLogger()
	src := bundles{}
	h.Bundles = src
	t.Cleanup(func() { h.Close(context.Background()) })

	ctx := context.Background()
	for range 4 {
		in := install(t, store)
		state, err := store.State(ctx, in.ID)
		if err != nil {
			t.Fatal(err)
		}
		src[state.Install.Name+"@1.0.0"] = guestNoop()
		if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); err != nil {
			t.Fatal(err)
		}
	}
	if got := h.CachedModules(); got != 2 {
		t.Fatalf("%d modules resident, want at most 2", got)
	}
}

func TestAnUpgradeAskingForMoreParksAndTheOldGrantsStayInForce(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityKV})

	err := store.Upgrade(ctx, in.ID, "2.0.0", []Grant{
		{Capability: CapabilityKV},
		{Capability: CapabilityFetch, Scope: "api.example.com"},
	})
	if !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("got %v, want ErrUpgradePending", err)
	}

	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Version != "1.0.0" {
		t.Fatalf("version is %q; a pending upgrade must not move it", state.Install.Version)
	}
	if !state.Allows(CapabilityKV, "") {
		t.Fatal("the old grants must stay in force while the upgrade is pending")
	}
	if state.Allows(CapabilityFetch, "api.example.com") {
		t.Fatal("a pending upgrade must not grant what it asked for")
	}

	pending, ok, err := store.Pending(ctx, in.ID)
	if err != nil || !ok {
		t.Fatalf("pending upgrade: %v %t", err, ok)
	}
	if pending.Version != "2.0.0" || len(pending.Grants) != 2 {
		t.Fatalf("pending upgrade is %+v", pending)
	}

	if err := store.ApproveUpgrade(ctx, in.ID); err != nil {
		t.Fatal(err)
	}
	state, err = store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Version != "2.0.0" || !state.Allows(CapabilityFetch, "api.example.com") {
		t.Fatalf("after approval: %+v", state)
	}
}

func TestAnUpgradeWithinTheApprovedCapabilitiesAppliesStraightAway(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store,
		Grant{Capability: CapabilityKV},
		Grant{Capability: CapabilityLog})

	if err := store.Upgrade(ctx, in.ID, "1.1.0", []Grant{{Capability: CapabilityKV}}); err != nil {
		t.Fatal(err)
	}
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Version != "1.1.0" {
		t.Fatalf("version is %q, want 1.1.0", state.Install.Version)
	}
	if state.Allows(CapabilityLog, "") {
		t.Fatal("an upgrade that drops a capability should not keep it")
	}
}
