package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	extism "github.com/extism/go-sdk"
)

// The host functions are the whole of a plugin's reach. There is deliberately
// no SQL function: a plugin never sees the pool, so storage is the namespaced
// key-value store and nothing else.
//
// Every one of them checks the grant *here*, immediately before the effect,
// against the install record read fresh from the database. Checking at load
// time would mean a revoked grant kept working until a restart; checking
// against the bundle's own manifest would mean the plugin decides what the
// plugin may do.

// kvSeparator joins the granted scope to the plugin's key. A key containing it
// is refused rather than escaped, because a plugin has no reason to send one
// and every reason to try.
const kvSeparator = "\x1f"

// Errors host functions return through the envelope.
var (
	// ErrForgedKey is returned for a key that tries to climb out of its
	// namespace.
	ErrForgedKey = errors.New("a plugin key may not contain the namespace separator")
	// ErrNoSessions is returned when the server has no session surface wired.
	ErrNoSessions = errors.New("session access is not configured on this server")
	// ErrNoQueue is returned when the server has no job queue wired.
	ErrNoQueue = errors.New("the job queue is not configured on this server")
	// ErrNoBus is returned when the server has no event bus wired.
	ErrNoBus = errors.New("the event bus is not configured on this server")
)

type callKey struct{}

// callInfo travels with one call. The host errors it collects are what a
// hostile fixture asserts on: a guest is free to ignore a refusal, so the
// refusal has to be visible to the host as well as to the guest.
type callInfo struct {
	installID string
	mode      CallMode

	mu     sync.Mutex
	errors []error
}

func (c *callInfo) refuse(err error) {
	c.mu.Lock()
	c.errors = append(c.errors, err)
	c.mu.Unlock()
}

func (c *callInfo) snapshot() []error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]error(nil), c.errors...)
}

func callFrom(ctx context.Context) *callInfo {
	info, _ := ctx.Value(callKey{}).(*callInfo)
	return info
}

// CallReport is what the host observed while the guest ran. HostErrors holds
// every refusal a host function handed back, in order.
type CallReport struct {
	HostErrors []error
}

// Refused reports whether any host function refused with target.
func (r CallReport) Refused(target error) bool {
	for _, err := range r.HostErrors {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

// CallWithReport is Call plus what the host functions refused. Call is the
// production path; this exists because a guest that swallows a refusal must
// not be able to make a test pass.
func (h *Host) CallWithReport(ctx context.Context, installID, fn string, input []byte, mode CallMode) ([]byte, CallReport, error) {
	info := &callInfo{installID: installID, mode: mode}
	out, err := h.call(ctx, installID, fn, input, mode, info)
	return out, CallReport{HostErrors: info.snapshot()}, err
}

// envelope is what every host function writes back. A plugin sees a refusal as
// data rather than a trap, so a well-written plugin can degrade instead of
// dying, and a badly written one still cannot proceed.
type envelope struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// hostFunctions builds the eight capabilities for one install. The install id
// is closed over at compile time — it is the host's, not the guest's — while
// the grants behind it are read on every call.
func (h *Host) hostFunctions(installID string) []extism.HostFunction {
	fn := func(name string, body func(ctx context.Context, st State, info *callInfo, req json.RawMessage) (any, error)) extism.HostFunction {
		return extism.NewHostFunctionWithStack(name,
			func(ctx context.Context, p *extism.CurrentPlugin, stack []uint64) {
				info := callFrom(ctx)
				if info == nil {
					info = &callInfo{installID: installID}
				}
				out, err := func() (any, error) {
					raw, err := p.ReadBytes(stack[0])
					if err != nil {
						return nil, fmt.Errorf("reading the %s request: %w", name, err)
					}
					st, err := h.Store.State(ctx, installID)
					if err != nil {
						return nil, err
					}
					if !st.Install.Enabled {
						return nil, fmt.Errorf("%s: %w", st.Install.Name, ErrDisabled)
					}
					return body(ctx, st, info, raw)
				}()

				env := envelope{OK: err == nil}
				if err != nil {
					info.refuse(err)
					env.Error = err.Error()
				} else if out != nil {
					data, marshalErr := json.Marshal(out)
					if marshalErr != nil {
						env = envelope{OK: false, Error: marshalErr.Error()}
					} else {
						env.Data = data
					}
				}
				encoded, _ := json.Marshal(env)
				offset, writeErr := p.WriteBytes(encoded)
				if writeErr != nil {
					// Nothing can be handed back, so let the call trap; the
					// call site recovers it.
					panic(fmt.Errorf("writing the %s response: %w", name, writeErr))
				}
				stack[0] = offset
			},
			[]extism.ValueType{extism.ValueTypePTR},
			[]extism.ValueType{extism.ValueTypePTR},
		)
	}

	return []extism.HostFunction{
		fn("parley_kv_get", h.kvGet),
		fn("parley_kv_set", h.kvSet),
		fn("parley_fetch", h.fetch),
		fn("parley_secret_get", h.secretGet),
		fn("parley_log", h.logMessage),
		fn("parley_emit", h.emit),
		fn("parley_session_get", h.sessionGet),
		fn("parley_session_patch", h.sessionPatch),
		fn("parley_job_enqueue", h.enqueue),
	}
}

func decode[T any](raw json.RawMessage, into *T) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("the request is not the JSON this host function takes: %w", err)
	}
	return nil
}

// namespacedKey is the whole of the cross-install defence on the key side. The
// install is a database column the guest never touches, so forging a key can
// only ever reach another *scope*, and a key that tries is refused.
func namespacedKey(scope, key string) (string, error) {
	if strings.Contains(key, kvSeparator) {
		return "", fmt.Errorf("%q: %w", key, ErrForgedKey)
	}
	if key == "" {
		return "", fmt.Errorf("the key is empty: %w", ErrForgedKey)
	}
	return scope + kvSeparator + key, nil
}

type kvRequest struct {
	Scope string `json:"scope,omitempty"`
	Key   string `json:"key"`
	Value []byte `json:"value,omitempty"`
}

func (h *Host) kvGet(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req kvRequest
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilityKV, req.Scope) {
		return nil, fmt.Errorf("%s in scope %q: %w", CapabilityKV, req.Scope, ErrNotGranted)
	}
	key, err := namespacedKey(req.Scope, req.Key)
	if err != nil {
		return nil, err
	}
	value, found, err := h.Store.Get(ctx, st.Install.ID, key)
	if err != nil {
		return nil, err
	}
	return map[string]any{"found": found, "value": value}, nil
}

func (h *Host) kvSet(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req kvRequest
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilityKV, req.Scope) {
		return nil, fmt.Errorf("%s in scope %q: %w", CapabilityKV, req.Scope, ErrNotGranted)
	}
	key, err := namespacedKey(req.Scope, req.Key)
	if err != nil {
		return nil, err
	}
	if err := h.Store.Put(ctx, st.Install.ID, key, req.Value); err != nil {
		return nil, err
	}
	return map[string]any{"written": len(req.Value)}, nil
}

func (h *Host) fetch(ctx context.Context, st State, info *callInfo, raw json.RawMessage) (any, error) {
	// The mode check comes first and no grant reaches it. A hook runs on the
	// path a room's broadcast waits on; it may not wait on the network.
	if info.mode == ModeSync {
		return nil, ErrFetchSynchronousHook
	}
	var req FetchRequest
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	allow := st.Scopes(CapabilityFetch)
	if len(allow) == 0 {
		return nil, fmt.Errorf("%s: %w", CapabilityFetch, ErrNotGranted)
	}
	fetcher := h.Fetcher
	if fetcher == nil {
		fetcher = &Fetcher{}
	}
	return fetcher.Do(ctx, allow, req, false)
}

func (h *Host) secretGet(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilitySecrets, req.Name) {
		return nil, fmt.Errorf("%s %q: %w", CapabilitySecrets, req.Name, ErrNotGranted)
	}
	value, err := h.Store.GetSecret(ctx, st.Install.ID, req.Name)
	if err != nil {
		return nil, err
	}
	return map[string]any{"value": value}, nil
}

func (h *Host) logMessage(_ context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilityLog, "") {
		return nil, fmt.Errorf("%s: %w", CapabilityLog, ErrNotGranted)
	}
	if h.Log == nil {
		return map[string]any{"logged": false}, nil
	}
	level := slog.LevelInfo
	switch strings.ToLower(req.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	// The plugin's message is an attribute, never the log message itself, so
	// it cannot forge a line that reads as the server's own.
	h.Log.Log(context.Background(), level, "plugin log",
		"plugin", st.Install.Name, "install_id", st.Install.ID, "message", req.Message)
	return map[string]any{"logged": true}, nil
}

func (h *Host) emit(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Topic   string          `json:"topic"`
		Payload json.RawMessage `json:"payload,omitempty"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilityEmit, req.Topic) {
		return nil, fmt.Errorf("%s %q: %w", CapabilityEmit, req.Topic, ErrNotGranted)
	}
	if h.Bus == nil {
		return nil, ErrNoBus
	}
	// The topic a plugin emits on is namespaced by its install, so it cannot
	// publish an event that reads as one of the core's.
	topic := fmt.Sprintf("plugin.%s.%s", st.Install.Name, req.Topic)
	if err := h.Bus.Publish(ctx, Event{Topic: topic, Payload: req.Payload}); err != nil {
		return nil, err
	}
	return map[string]any{"topic": topic}, nil
}

func (h *Host) sessionGet(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Session string `json:"session"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilitySessionRead, req.Session) {
		return nil, fmt.Errorf("%s: %w", CapabilitySessionRead, ErrNotGranted)
	}
	if h.Sessions == nil {
		return nil, ErrNoSessions
	}
	state, err := h.Sessions.Read(ctx, st.Install.ID, req.Session)
	if err != nil {
		return nil, err
	}
	return map[string]any{"state": json.RawMessage(state)}, nil
}

func (h *Host) sessionPatch(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Session string          `json:"session"`
		Patch   json.RawMessage `json:"patch"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilitySessionPatch, req.Session) {
		return nil, fmt.Errorf("%s: %w", CapabilitySessionPatch, ErrNotGranted)
	}
	if h.Sessions == nil {
		return nil, ErrNoSessions
	}
	if err := h.Sessions.Patch(ctx, st.Install.ID, req.Session, req.Patch); err != nil {
		return nil, err
	}
	return map[string]any{"applied": true}, nil
}

func (h *Host) enqueue(ctx context.Context, st State, _ *callInfo, raw json.RawMessage) (any, error) {
	var req struct {
		Kind    string          `json:"kind"`
		Payload json.RawMessage `json:"payload,omitempty"`
		DelayMS int64           `json:"delay_ms,omitempty"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if !st.Allows(CapabilityJobs, req.Kind) {
		return nil, fmt.Errorf("%s %q: %w", CapabilityJobs, req.Kind, ErrNotGranted)
	}
	if h.Queue == nil {
		return nil, ErrNoQueue
	}
	runAt := time.Now()
	if req.DelayMS > 0 {
		runAt = runAt.Add(time.Duration(req.DelayMS) * time.Millisecond)
	}
	id, err := h.Queue.Enqueue(ctx, Job{
		InstallID: st.Install.ID,
		Kind:      req.Kind,
		Payload:   req.Payload,
		RunAt:     runAt,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"job_id": id}, nil
}
