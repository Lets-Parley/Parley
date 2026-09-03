package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	extism "github.com/extism/go-sdk"
	"github.com/tetratelabs/wazero"
)

// The host runs plugin code. Everything in this file exists to bound what that
// code can do to the process it shares:
//
//   - one call is bounded by a timeout, a memory cap, and a recover at the
//     call site, so a hang, an allocation storm, or a panic ends the call
//     rather than the room;
//   - the process is bounded by a cap on in-flight calls, total and per
//     install, because a plugin that makes many individually well-behaved
//     calls exhausts a process that only bounds each call;
//   - a plugin that keeps failing is degraded and then disabled, because a
//     broken plugin retried forever is an outage with extra steps.
//
// A plugin gets no filesystem, no sockets, no clock beyond wall time, and no
// SQL. Extism's own http_request is left with an empty allowed-hosts list,
// which disables it: all egress goes through the guarded fetch host function.

// Containment defaults. All are deliberately small; an operator raises them
// knowingly.
const (
	DefaultCallTimeout      = 2 * time.Second
	DefaultMemoryPages      = 256 // 16 MiB
	DefaultMaxConcurrent    = 8
	DefaultPerInstall       = 2
	DefaultCachedModules    = 16
	DefaultBreakerFailures  = 5
	DefaultBreakerCooldown  = 30 * time.Second
	DefaultBreakerTripLimit = 3
)

// Errors the containment layer returns. Each hostile fixture asserts one of
// these by identity: "the room survived" also passes when the fixture did
// nothing.
var (
	// ErrDisabled is returned for an install that is switched off.
	ErrDisabled = errors.New("the plugin is disabled")
	// ErrTooBusy is returned when the in-flight cap is reached.
	ErrTooBusy = errors.New("too many plugin calls are already in flight")
	// ErrCircuitOpen is returned while a repeatedly failing plugin is degraded.
	ErrCircuitOpen = errors.New("the plugin is degraded after repeated failures")
	// ErrCallTimeout is returned when a call outruns the per-call timeout.
	ErrCallTimeout = errors.New("the plugin call ran past its timeout and was stopped")
	// ErrGuestMemory is returned when a call is stopped by the memory cap.
	ErrGuestMemory = errors.New("the plugin call was stopped by the memory cap")
	// ErrGuestPanic is returned when guest code traps or the call site
	// recovers a panic.
	ErrGuestPanic = errors.New("the plugin call trapped")
	// ErrNoBundle is returned when no bundle source is configured.
	ErrNoBundle = errors.New("no plugin bundle source is configured")
)

// CallMode says which path a call is on, because one of the guards depends on
// it rather than on a grant.
type CallMode int

const (
	// ModeAsync is a job or an outbox delivery. It may fetch, with the grant.
	ModeAsync CallMode = iota
	// ModeSync is a hook on the path a room's state broadcast waits on. It may
	// never fetch, whatever it has been granted: remote data reaches a hook
	// from a cache a job filled.
	ModeSync
)

// Bundles hands the host the WASM for an install. It is an interface so the
// host does not care whether bundles live on disk, in the image, or in a
// table, and so a test can supply bytes without a filesystem.
type Bundles interface {
	Load(ctx context.Context, name, version string) ([]byte, error)
}

// Sessions is the read and patch surface a plugin sees of live session state.
// A nil Sessions means those two host functions are unavailable, which is not
// the same as ungranted.
type Sessions interface {
	// Read returns redacted, client-safe state. It is broadcast material.
	Read(ctx context.Context, installID, sessionID string) ([]byte, error)
	// Patch proposes a change. The implementation decides what it will accept;
	// nothing a plugin sends is trusted here.
	Patch(ctx context.Context, installID, sessionID string, patch []byte) error
}

// HostConfig is the containment budget.
type HostConfig struct {
	CallTimeout             time.Duration
	MemoryPages             uint32
	MaxConcurrentCalls      int
	MaxConcurrentPerInstall int
	MaxCachedModules        int
	BreakerFailures         int
	BreakerCooldown         time.Duration
	BreakerTripLimit        int
}

func (c HostConfig) withDefaults() HostConfig {
	if c.CallTimeout <= 0 {
		c.CallTimeout = DefaultCallTimeout
	}
	if c.MemoryPages == 0 {
		c.MemoryPages = DefaultMemoryPages
	}
	c.MaxConcurrentCalls = orDefaultInt(c.MaxConcurrentCalls, DefaultMaxConcurrent)
	c.MaxConcurrentPerInstall = orDefaultInt(c.MaxConcurrentPerInstall, DefaultPerInstall)
	c.MaxCachedModules = orDefaultInt(c.MaxCachedModules, DefaultCachedModules)
	c.BreakerFailures = orDefaultInt(c.BreakerFailures, DefaultBreakerFailures)
	c.BreakerTripLimit = orDefaultInt(c.BreakerTripLimit, DefaultBreakerTripLimit)
	if c.BreakerCooldown <= 0 {
		c.BreakerCooldown = DefaultBreakerCooldown
	}
	return c
}

type cachedModule struct {
	version  string
	compiled *extism.CompiledPlugin
}

// Host loads, runs and contains plugins.
type Host struct {
	Store    *Store
	Bus      *Bus
	Queue    *Queue
	Fetcher  *Fetcher
	Bundles  Bundles
	Sessions Sessions
	Log      *slog.Logger

	cfg HostConfig

	mu       sync.Mutex
	cache    map[string]*cachedModule
	lru      []string // least recently used first
	breakers map[string]*breaker
	inflight map[string]int
	total    int
}

// NewHost builds a host with the containment budget filled in.
func NewHost(store *Store, cfg HostConfig) *Host {
	return &Host{
		Store:    store,
		Fetcher:  &Fetcher{},
		cfg:      cfg.withDefaults(),
		cache:    map[string]*cachedModule{},
		breakers: map[string]*breaker{},
		inflight: map[string]int{},
	}
}

// Config exposes the budget in force, for the startup log and for tests.
func (h *Host) Config() HostConfig { return h.cfg }

// Enable compiles an install's bundle once and puts it in the cache, so the
// first call after an enable is not also the first compile.
func (h *Host) Enable(ctx context.Context, installID string) error {
	if err := h.Store.SetEnabled(ctx, installID, true); err != nil {
		return err
	}
	h.mu.Lock()
	delete(h.breakers, installID)
	h.mu.Unlock()
	_, err := h.module(ctx, installID)
	return err
}

// Disable switches an install off and evicts its compiled module, rather than
// leaving a disabled plugin's code resident.
func (h *Host) Disable(ctx context.Context, installID, reason string) error {
	if err := h.Store.SetEnabled(ctx, installID, false); err != nil {
		return err
	}
	h.evict(ctx, installID)
	if h.Log != nil {
		h.Log.Warn("plugin disabled", "install_id", installID, "reason", reason)
	}
	return nil
}

func (h *Host) evict(ctx context.Context, installID string) {
	h.mu.Lock()
	entry, ok := h.cache[installID]
	delete(h.cache, installID)
	h.lru = removeString(h.lru, installID)
	h.mu.Unlock()
	if ok {
		_ = entry.compiled.Close(ctx)
	}
}

// Close releases every cached module.
func (h *Host) Close(ctx context.Context) {
	h.mu.Lock()
	entries := h.cache
	h.cache = map[string]*cachedModule{}
	h.lru = nil
	h.mu.Unlock()
	for _, e := range entries {
		_ = e.compiled.Close(ctx)
	}
}

// CachedModules is how many compiled modules are resident. The cache is
// bounded; this is what a test asserts the bound with.
func (h *Host) CachedModules() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.cache)
}

// module returns the compiled module for an install, compiling and caching it
// on the way if it is not resident or the version moved.
func (h *Host) module(ctx context.Context, installID string) (*extism.CompiledPlugin, error) {
	state, err := h.Store.State(ctx, installID)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	if entry, ok := h.cache[installID]; ok && entry.version == state.Install.Version {
		h.lru = append(removeString(h.lru, installID), installID)
		h.mu.Unlock()
		return entry.compiled, nil
	}
	h.mu.Unlock()

	if h.Bundles == nil {
		return nil, ErrNoBundle
	}
	wasm, err := h.Bundles.Load(ctx, state.Install.Name, state.Install.Version)
	if err != nil {
		return nil, fmt.Errorf("loading the bundle for %s: %w", state.Install.Name, err)
	}

	compiled, err := extism.NewCompiledPlugin(ctx,
		extism.Manifest{
			Wasm: []extism.Wasm{extism.WasmData{Data: wasm, Name: "main"}},
			// No AllowedHosts and no AllowedPaths: Extism's own http_request
			// and filesystem access stay off, so the guarded fetch host
			// function is the only way out.
			Memory:  &extism.ManifestMemory{MaxPages: h.cfg.MemoryPages},
			Timeout: uint64(h.cfg.CallTimeout.Milliseconds()),
		},
		extism.PluginConfig{
			EnableWasi:    true,
			RuntimeConfig: wazero.NewRuntimeConfig().WithMemoryLimitPages(h.cfg.MemoryPages).WithCloseOnContextDone(true),
		},
		h.hostFunctions(installID),
	)
	if err != nil {
		return nil, fmt.Errorf("compiling %s %s: %w", state.Install.Name, state.Install.Version, err)
	}

	h.mu.Lock()
	if old, ok := h.cache[installID]; ok {
		defer func() { _ = old.compiled.Close(ctx) }()
	}
	h.cache[installID] = &cachedModule{version: state.Install.Version, compiled: compiled}
	h.lru = append(removeString(h.lru, installID), installID)
	var overflow []*cachedModule
	for len(h.cache) > h.cfg.MaxCachedModules {
		oldest := h.lru[0]
		h.lru = h.lru[1:]
		if e, ok := h.cache[oldest]; ok {
			overflow = append(overflow, e)
			delete(h.cache, oldest)
		}
	}
	h.mu.Unlock()
	for _, e := range overflow {
		_ = e.compiled.Close(ctx)
	}
	return compiled, nil
}

func removeString(xs []string, want string) []string {
	out := xs[:0]
	for _, x := range xs {
		if x != want {
			out = append(out, x)
		}
	}
	return out
}

// Call runs one exported function of one plugin, contained.
func (h *Host) Call(ctx context.Context, installID, fn string, input []byte, mode CallMode) ([]byte, error) {
	out, _, err := h.CallWithReport(ctx, installID, fn, input, mode)
	return out, err
}

func (h *Host) call(ctx context.Context, installID, fn string, input []byte, mode CallMode, info *callInfo) ([]byte, error) {
	state, err := h.Store.State(ctx, installID)
	if err != nil {
		return nil, err
	}
	if !state.Install.Enabled {
		return nil, fmt.Errorf("%s: %w", state.Install.Name, ErrDisabled)
	}
	if !h.breakerFor(installID).allow(time.Now()) {
		return nil, fmt.Errorf("%s: %w", state.Install.Name, ErrCircuitOpen)
	}
	if !h.acquire(installID) {
		return nil, fmt.Errorf("%s: %w", state.Install.Name, ErrTooBusy)
	}
	defer h.release(installID)

	compiled, err := h.module(ctx, installID)
	if err != nil {
		return nil, err
	}

	out, err := h.invoke(ctx, compiled, fn, input, info)
	h.record(ctx, installID, state.Install.Name, err)
	return out, err
}

// invoke is the call site every guard converges on: a deadline, an instance
// that is thrown away afterwards, and a recover, because a trap in guest code
// must not take the goroutine that scheduled it.
func (h *Host) invoke(ctx context.Context, compiled *extism.CompiledPlugin, fn string, input []byte, info *callInfo) (out []byte, err error) {
	ctx, cancel := context.WithTimeout(ctx, h.cfg.CallTimeout)
	defer cancel()
	ctx = context.WithValue(ctx, callKey{}, info)

	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", ErrGuestPanic, r)
			out = nil
		}
	}()

	started := time.Now()
	instance, err := compiled.Instance(ctx, extism.PluginInstanceConfig{
		ModuleConfig: wazero.NewModuleConfig().WithSysNanotime().WithSysWalltime(),
	})
	if err != nil {
		return nil, h.classify(ctx, started, fmt.Errorf("instantiating %s: %w", fn, err))
	}
	defer func() { _ = instance.CloseWithContext(context.WithoutCancel(ctx)) }()

	_, output, err := instance.CallWithContext(ctx, fn, input)
	if err != nil {
		return nil, h.classify(ctx, started, err)
	}
	return output, nil
}

// classify turns a runtime failure into the specific containment error that
// caused it, so a fixture can assert its own mechanism instead of "something
// went wrong".
func (h *Host) classify(ctx context.Context, started time.Time, err error) error {
	msg := err.Error()
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded),
		strings.Contains(msg, "module closed with context deadline exceeded"):
		return fmt.Errorf("%w after %s: %v", ErrCallTimeout, time.Since(started).Round(time.Millisecond), err)
	case strings.Contains(msg, "out of bounds memory access"),
		strings.Contains(msg, "memory size"),
		strings.Contains(msg, "max_memory"),
		strings.Contains(msg, "exceeds"):
		return fmt.Errorf("%w: %v", ErrGuestMemory, err)
	case strings.Contains(msg, "unreachable"), strings.Contains(msg, "wasm error"),
		strings.Contains(msg, "panic"):
		return fmt.Errorf("%w: %v", ErrGuestPanic, err)
	}
	return err
}

func (h *Host) acquire(installID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.total >= h.cfg.MaxConcurrentCalls || h.inflight[installID] >= h.cfg.MaxConcurrentPerInstall {
		return false
	}
	h.total++
	h.inflight[installID]++
	return true
}

func (h *Host) release(installID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.total--
	h.inflight[installID]--
	if h.inflight[installID] <= 0 {
		delete(h.inflight, installID)
	}
}

func (h *Host) breakerFor(installID string) *breaker {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, ok := h.breakers[installID]
	if !ok {
		b = &breaker{threshold: h.cfg.BreakerFailures, tripLimit: h.cfg.BreakerTripLimit}
		h.breakers[installID] = b
	}
	return b
}

// record feeds the breaker and disables an install that has degraded too many
// times. Disabling is durable: a plugin that has proved it cannot run does not
// come back on the next restart.
func (h *Host) record(ctx context.Context, installID, name string, callErr error) {
	b := h.breakerFor(installID)
	if callErr == nil {
		b.success()
		return
	}
	// A refusal by the containment layer is the host working, not the plugin
	// failing; charging it would let load disable a healthy plugin.
	if errors.Is(callErr, ErrTooBusy) || errors.Is(callErr, ErrCircuitOpen) || errors.Is(callErr, ErrDisabled) {
		return
	}
	switch b.failure(time.Now(), h.cfg.BreakerCooldown) {
	case breakerDegraded:
		if h.Log != nil {
			h.Log.Warn("plugin degraded after repeated failures",
				"install_id", installID, "plugin", name, "error", callErr)
		}
	case breakerExhausted:
		if err := h.Disable(context.WithoutCancel(ctx), installID,
			fmt.Sprintf("degraded %d times; last error: %v", h.cfg.BreakerTripLimit, callErr)); err != nil && h.Log != nil {
			h.Log.Error("could not disable a failing plugin", "install_id", installID, "error", err)
		}
	}
}

// DirBundles loads bundles from a directory as "<name>-<version>.wasm". A
// name or version that could climb out of the directory is refused rather than
// cleaned, because a bundle path is operator input and there is no legitimate
// separator in either field.
type DirBundles string

// Load implements Bundles.
func (d DirBundles) Load(_ context.Context, name, version string) ([]byte, error) {
	for _, field := range []string{name, version} {
		if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			return nil, fmt.Errorf("%q is not a usable bundle name or version", field)
		}
	}
	path := filepath.Join(string(d), name+"-"+version+".wasm")
	wasm, err := os.ReadFile(path) //nolint:gosec // the components are screened above
	if err != nil {
		return nil, fmt.Errorf("reading the bundle for %s %s: %w", name, version, err)
	}
	return wasm, nil
}

// DeliverEvent is the Outbox.Deliver handler: it hands one event to the
// plugin that subscribed to it. Deliveries are at-least-once, so a plugin's
// on_event must be idempotent — see the package comment.
func (h *Host) DeliverEvent(ctx context.Context, d Delivery) error {
	input, err := json.Marshal(map[string]any{"topic": d.Topic, "payload": d.Payload})
	if err != nil {
		return fmt.Errorf("encoding %s for delivery: %w", d.Topic, err)
	}
	_, err = h.Call(ctx, d.InstallID, "on_event", input, ModeAsync)
	return err
}

// RunJob is the Queue.Run handler. A job is the only place a plugin may reach
// the network, which is why anything a synchronous hook needs from outside has
// to have been put in the key-value store by one of these first.
func (h *Host) RunJob(ctx context.Context, job Job) error {
	input, err := json.Marshal(map[string]any{"kind": job.Kind, "payload": job.Payload})
	if err != nil {
		return fmt.Errorf("encoding the %s job: %w", job.Kind, err)
	}
	_, err = h.Call(ctx, job.InstallID, "on_job", input, ModeAsync)
	return err
}
