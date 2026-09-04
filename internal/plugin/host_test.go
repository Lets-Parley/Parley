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
		OrgID: testOrgID, Name: name, Version: "1.0.0", Grants: grants, QuotaBytes: quota,
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

// TestInFlightCallsAreCappedPerInstallAndInTotal used to race two "holder"
// calls against four expected refusals: it launched all six goroutines
// together and assumed all reached acquire() while the holders still held
// their slots. On a loaded runner the holders' guest could time out and
// release before the other four were even scheduled, so the refusal count
// depended on wall-clock scheduling rather than the cap.
//
// The precondition — two slots already in flight for this install — is set
// up directly through the same acquire() the call path uses, instead of by
// racing real concurrent calls against a timeout. That still exercises the
// exact guard under test (a mutation that guts acquire()'s condition is
// still caught, since acquire() is what this test calls), while making the
// four calls that must be refused genuinely deterministic: the cap is
// already at capacity before any of them starts.
func TestInFlightCallsAreCappedPerInstallAndInTotal(t *testing.T) {
	h, in := hosted(t, guestNoop(), HostConfig{
		MaxConcurrentCalls: 4, MaxConcurrentPerInstall: 2,
	}, 1024)

	if !h.acquire(in.ID) || !h.acquire(in.ID) {
		t.Fatal("expected to be able to hold the install's two slots directly")
	}
	defer h.release(in.ID)
	defer h.release(in.ID)

	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	var busy int
	for range 4 {
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
	if busy != 4 {
		t.Fatalf("%d of 4 calls were refused while 2 slots were held; with a per-install cap of 2 all 4 should be", busy)
	}
}

func TestARepeatedlyFailingPluginIsDegradedAndThenDisabled(t *testing.T) {
	// The cooldown is long enough that it cannot lapse while the test runs.
	// A short one made the assertion below a race against the clock: the
	// breaker opens for the cooldown from the moment of the second failure,
	// and any scheduling delay between that and the third call — a database
	// round trip, the race detector, a loaded runner — closed the window and
	// let the call through, so the test read the guest's trap instead of the
	// refusal it was written for. The cooldown's expiry is driven below
	// instead of waited on.
	h, in := hosted(t, guestPanic(), HostConfig{
		BreakerFailures: 2, BreakerTripLimit: 2, BreakerCooldown: time.Hour,
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
	// good — durably, not just in this process's memory. The cooldown is ended
	// by moving the breaker's deadline into the past rather than by sleeping,
	// so the test does not depend on how long anything took.
	h.mu.Lock()
	h.breakerFor(in.ID).openTill = time.Time{}
	h.mu.Unlock()
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

func TestAnUpgradeIsRunFromTheNewBundleRatherThanTheCachedOne(t *testing.T) {
	// The compiled module is cached per install, and the cache key that makes
	// it safe is the version. Without that check an upgraded install keeps
	// serving the bundle it was running before — which is a security property,
	// not only a correctness one: the new bundle is the one an operator
	// approved, and the old one is code they have decided to stop running.
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityKV})
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	name := state.Install.Name

	src := bundles{name + "@1.0.0": guestNoop()}
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = src
	t.Cleanup(func() { h.Close(ctx) })

	// v1 is compiled and cached by this call.
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); err != nil {
		t.Fatal(err)
	}

	// An upgrade within the already-approved capabilities, so it applies at
	// once rather than parking for an operator.
	if err := store.Upgrade(ctx, in.ID, "2.0.0", []Grant{{Capability: CapabilityKV}}); err != nil {
		t.Fatal(err)
	}
	// v2 behaves differently, and only the new bundle can produce that.
	src[name+"@2.0.0"] = guestPanic()

	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("got %v, want ErrGuestPanic — the call was served by the stale 1.0.0 module", err)
	}
}

func TestACallThatArrivesWithNoModeIsRefusedTheNetwork(t *testing.T) {
	// The zero CallMode is what a host function sees when a call reaches it
	// with no callInfo attached — the fallback hostfn.go builds. The fetch ban
	// rests on the mode, so the mode it was never told has to be the refusing
	// one; a zero value that means "asynchronous" makes the ban fail open.
	h, in := hosted(t, guestNoop(), HostConfig{},
		1024, Grant{Capability: CapabilityFetch, Scope: "api.example.com"})
	ctx := context.Background()
	st, err := h.Store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if callFrom(ctx) != nil {
		t.Fatal("a context with no call attached should carry no callInfo")
	}

	req, _ := json.Marshal(FetchRequest{URL: "https://api.example.com/"})
	_, err = h.fetch(ctx, st, &callInfo{installID: in.ID}, req)
	if !errors.Is(err, ErrFetchSynchronousHook) {
		t.Fatalf("got %v, want ErrFetchSynchronousHook for a call with no mode", err)
	}
}

func TestAMalformedHostFunctionRequestIsRefusedRatherThanReadAsEmpty(t *testing.T) {
	// Ignoring the decode error would leave the zero request behind, and the
	// zero request is a read of the empty key in the default scope — a
	// different operation from the one the guest sent, performed silently.
	h, in := hosted(t, guestCallsHost("parley_kv_get"), HostConfig{},
		4096, Grant{Capability: CapabilityKV})

	_, report, err := h.CallWithReport(context.Background(), in.ID, "run",
		[]byte(`{"key": "unterminated`), ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrBadRequest) {
		t.Fatalf("host errors %v; want ErrBadRequest", report.HostErrors)
	}
}

func TestAGuestSuppliedScopeIsScreenedAndTheKeyIsBounded(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_kv_set"), HostConfig{},
		1<<20, Grant{Capability: CapabilityKV})
	ctx := context.Background()

	// The scope arrives in the same request the key does, so screening only
	// the key leaves the guest able to land a write in another of its scopes.
	req, _ := json.Marshal(kvRequest{Scope: "cache" + kvSeparator + "secrets", Key: "k", Value: []byte("v")})
	_, report, err := h.CallWithReport(ctx, in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrForgedKey) {
		t.Fatalf("host errors %v; want ErrForgedKey for a scope carrying the separator", report.HostErrors)
	}

	// And an unbounded key is an unbounded row: the guest picks the length.
	req, _ = json.Marshal(kvRequest{Key: strings.Repeat("k", maxKVKeyBytes+1), Value: []byte("v")})
	_, report, err = h.CallWithReport(ctx, in.ID, "run", req, ModeAsync)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Refused(ErrKeyTooLong) {
		t.Fatalf("host errors %v; want ErrKeyTooLong", report.HostErrors)
	}
}

func TestASuccessBetweenTwoFailuresKeepsTheBreakerClosed(t *testing.T) {
	// A breaker that only ever counts up degrades a plugin that fails once an
	// hour, which is a working plugin. The reset on success is what makes the
	// threshold mean "consecutive".
	b := &breaker{threshold: 2, tripLimit: 2}
	now := time.Now()

	if got := b.failure(now, time.Hour); got != breakerHealthy {
		t.Fatalf("the first failure gave %v, want breakerHealthy", got)
	}
	b.success()
	if got := b.failure(now, time.Hour); got != breakerHealthy {
		t.Fatalf("a failure after a success gave %v; the success must have reset the run", got)
	}
	// Two in a row, with nothing between them, do trip it.
	if got := b.failure(now, time.Hour); got != breakerDegraded {
		t.Fatalf("two consecutive failures gave %v, want breakerDegraded", got)
	}
}

func TestOneCapabilityIsNeverAPrefixOfAnother(t *testing.T) {
	// Matching capabilities by prefix happens to work today only because no
	// two constants are prefixes of each other. "session:read" and
	// "session:patch" are one rename away from making that false, and reading
	// a session and rewriting one are not the same power.
	read := State{Grants: []Grant{{Capability: CapabilitySessionRead}}}
	if read.Allows(CapabilitySessionPatch, "") {
		t.Error("a session:read grant must not permit session:patch")
	}
	patch := State{Grants: []Grant{{Capability: CapabilitySessionPatch}}}
	if patch.Allows(CapabilitySessionRead, "") {
		t.Error("a session:patch grant must not permit session:read")
	}
	if !read.Allows(CapabilitySessionRead, "") || !patch.Allows(CapabilitySessionPatch, "") {
		t.Error("a grant must permit its own capability")
	}
	// The shape the prefix bug needs, spelled out: a shorter capability must
	// not open a longer one that starts with it, in either direction.
	short := State{Grants: []Grant{{Capability: "session"}}}
	if short.Allows(CapabilitySessionRead, "") {
		t.Error("a grant for \"session\" must not permit \"session:read\"")
	}
	if read.Allows("session", "") {
		t.Error("a session:read grant must not permit a bare \"session\"")
	}
}

func TestAnUnrelatedTrapIsNotReportedAsAMemoryFailure(t *testing.T) {
	// Every fixture asserts its own mechanism by identity, so a mechanism a
	// fixture could earn by accident undermines all of them. The memory arm
	// used to match the bare word "exceeds", which appears in runtime errors
	// that have nothing to do with memory.
	h := &Host{cfg: HostConfig{}.withDefaults()}
	ctx := context.Background()

	trap := errors.New("wasm error: unreachable: the call stack exceeds its limit")
	if err := h.classify(ctx, time.Now(), trap); !errors.Is(err, ErrGuestPanic) {
		t.Errorf("got %v, want ErrGuestPanic — an unrelated \"exceeds\" is not a memory failure", err)
	}
	// The real memory failures still classify as they did.
	for _, msg := range []string{
		"out of bounds memory access",
		"memory size exceeds the limit",
		"module[main] memory[0] minimum size exceeds the max pages",
	} {
		if err := h.classify(ctx, time.Now(), errors.New(msg)); !errors.Is(err, ErrGuestMemory) {
			t.Errorf("%q classified as %v, want ErrGuestMemory", msg, err)
		}
	}
}

func TestARefusedApprovalNamesThePluginRatherThanItsID(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityKV})
	state, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}

	// An allowlist entry the guard cannot enforce, parked as a pending grant
	// directly: Upgrade would have refused it on the way in, and what is under
	// test is the refusal on the way out.
	if _, err := store.Pool.Exec(ctx,
		`update plugin_installs set pending_version = '2.0.0' where id = $1`, in.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Pool.Exec(ctx, `
		insert into plugin_pending_grants (install_id, capability, scope)
		values ($1, $2, $3)`, in.ID, CapabilityFetch, "api.*.example.com"); err != nil {
		t.Fatal(err)
	}

	err = store.ApproveUpgrade(ctx, in.ID)
	if !errors.Is(err, ErrAllowPattern) {
		t.Fatalf("got %v, want ErrAllowPattern", err)
	}
	if !strings.Contains(err.Error(), state.Install.Name) {
		t.Fatalf("the refusal reads %q; it should name the plugin, as every other grant check does", err)
	}
}

// Every host function that checks a capability must refuse with ErrNotGranted
// and with nothing else.
//
// The sentinel is not tidiness. A guest that reads a refusal as "malformed
// input" retries forever against what is actually a permanent policy denial,
// and an operator reading the log sees a client bug where a capability
// decision was made. Swapping any one of these branches to ErrBadRequest left
// the whole suite green, so the identity of the refusal is pinned here, per
// host function, rather than left to whichever test happened to run the call.
func TestEveryCapabilityRefusalKeepsItsSentinel(t *testing.T) {
	// No store, no bus, no queue: every one of these checks its grant before
	// it reaches anything, and a refusal that needed a database would be a
	// refusal made too late.
	h := &Host{}
	st := State{Install: Install{ID: "install", Name: "ungranted", Enabled: true}}
	ctx := context.Background()

	call := func(fn func(context.Context, State, *callInfo, json.RawMessage) (any, error), req any) (any, error) {
		raw, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		return fn(ctx, st, &callInfo{installID: st.Install.ID, mode: ModeAsync}, raw)
	}

	for _, tc := range []struct {
		name string
		fn   func(context.Context, State, *callInfo, json.RawMessage) (any, error)
		req  any
	}{
		{"parley_kv_get", h.kvGet, kvRequest{Scope: "cache", Key: "k"}},
		{"parley_kv_set", h.kvSet, kvRequest{Scope: "cache", Key: "k", Value: []byte("v")}},
		{"parley_fetch", h.fetch, FetchRequest{URL: "https://api.example.com/"}},
		{"parley_secret_get", h.secretGet, map[string]string{"name": "token"}},
		{"parley_log", h.logMessage, map[string]string{"level": "info", "message": "hello"}},
		{"parley_emit", h.emit, map[string]any{"topic": "thing.happened"}},
		{"parley_session_get", h.sessionGet, map[string]string{"session": "s"}},
		{"parley_session_patch", h.sessionPatch, map[string]any{"session": "s", "patch": json.RawMessage(`{}`)}},
		{"parley_job_enqueue", h.enqueue, map[string]any{"kind": "work"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := call(tc.fn, tc.req)
			if err == nil {
				t.Fatalf("%s returned %v with no grant at all; want a refusal", tc.name, out)
			}
			if !errors.Is(err, ErrNotGranted) {
				t.Fatalf("%s refused with %v; want ErrNotGranted, the sentinel a guest reads as permanent", tc.name, err)
			}
			// A capability decision downgraded to a malformed-input error is
			// the failure this test exists for, so it is named rather than
			// left to fall out of the check above.
			if errors.Is(err, ErrBadRequest) {
				t.Fatalf("%s reported a capability refusal as ErrBadRequest: %v", tc.name, err)
			}
		})
	}
}

// An approval consumes the pending rows as well as applying them.
//
// Applying the grants and leaving the pending rows behind passes every other
// test in this package, and it is not harmless: the rows an operator has
// already consumed stay readable, so a later approval — or a widened read of
// that table — can resurrect capabilities from a decision that is over.
func TestAnApprovedUpgradeLeavesNothingPendingBehind(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityKV})

	if err := store.Upgrade(ctx, in.ID, "2.0.0", []Grant{
		{Capability: CapabilityKV},
		{Capability: CapabilityFetch, Scope: "api.example.com"},
	}); !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("got %v, want ErrUpgradePending", err)
	}
	if err := store.ApproveUpgrade(ctx, in.ID); err != nil {
		t.Fatal(err)
	}

	var left int
	if err := store.Pool.QueryRow(ctx,
		`select count(*) from plugin_pending_grants where install_id = $1`, in.ID).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatalf("%d pending grant rows survived the approval; a consumed decision must leave none", left)
	}

	if _, ok, err := store.Pending(ctx, in.ID); err != nil || ok {
		t.Fatalf("Pending reports %t (err %v) after an approval; want no pending upgrade", ok, err)
	}
}

// One install's pending upgrade is one install's. The filter on the pending
// read is the only thing that makes that true, and dropping it went red only
// because unrelated rows happened to be in the shared test database — an
// accident of ordering, not an assertion. This one names the expectation.
func TestOneInstallsPendingUpgradeIsNotAnothers(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	a := install(t, store, Grant{Capability: CapabilityKV})
	b := install(t, store, Grant{Capability: CapabilityKV})

	if err := store.Upgrade(ctx, a.ID, "2.0.0", []Grant{
		{Capability: CapabilityFetch, Scope: "a.example.com"},
	}); !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("install a: got %v, want ErrUpgradePending", err)
	}
	if err := store.Upgrade(ctx, b.ID, "3.0.0", []Grant{
		{Capability: CapabilityFetch, Scope: "b.example.com"},
	}); !errors.Is(err, ErrUpgradePending) {
		t.Fatalf("install b: got %v, want ErrUpgradePending", err)
	}

	pending, ok, err := store.Pending(ctx, a.ID)
	if err != nil || !ok {
		t.Fatalf("install a has no pending upgrade: %v %t", err, ok)
	}
	// Hand-written, not derived from what was just asked for: install a asked
	// for exactly one grant, and b's must not be in the answer.
	want := PendingUpgrade{Version: "2.0.0", Grants: []Grant{
		{Capability: "fetch", Scope: "a.example.com"},
	}}
	if pending.Version != want.Version {
		t.Fatalf("install a's pending version is %q, want %q", pending.Version, want.Version)
	}
	if len(pending.Grants) != 1 {
		t.Fatalf("install a's pending grants are %+v; want exactly its own one", pending.Grants)
	}
	if pending.Grants[0] != want.Grants[0] {
		t.Fatalf("install a's pending grant is %+v, want %+v", pending.Grants[0], want.Grants[0])
	}
}
