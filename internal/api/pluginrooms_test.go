package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/plugintest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

type memBundles map[string][]byte

func (b memBundles) Resolve(_ context.Context, name, version string) (string, error) {
	return name + "@" + version, nil
}

func (b memBundles) Load(_ context.Context, name, version string) ([]byte, string, error) {
	wasm, ok := b[name+"@"+version]
	if !ok {
		return nil, "", fmt.Errorf("no bundle for %s %s", name, version)
	}
	return wasm, name + "@" + version, nil
}

// syncBuffer is a log sink several goroutines write to.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// viewer is one connected client, remembering the plugin state of the last
// frame it was sent.
type viewer struct {
	ws   *websocket.Conn
	mu   sync.Mutex
	last string
}

func watch(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) *viewer {
	t.Helper()
	ws, _, err := dialWS(t, srv, sessionID, cookie, testOrigin)
	if err != nil {
		t.Fatalf("a viewer could not connect: %v", err)
	}
	v := &viewer{ws: ws}
	t.Cleanup(func() { ws.Close() })
	go func() {
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var frame struct {
				State json.RawMessage `json:"state"`
			}
			if json.Unmarshal(raw, &frame) == nil && frame.State != nil {
				v.mu.Lock()
				v.last = string(frame.State)
				v.mu.Unlock()
			}
		}
	}()
	return v
}

func (v *viewer) state() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.last
}

// The whole path, with the limits the binary ships: a real router, a real
// guest providing the room's kind, sockets for the people watching. One
// person acting quickly in a full room is the ordinary case, and it has to
// work without anyone being told the plugin is busy.
func TestARoomFullOfViewersSurvivesOnePersonActingQuickly(t *testing.T) {
	const viewers, actions = 30, 20

	var logs syncBuffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	pool := testPool(t)
	// Thirty sign-ups from one address would use up the hourly budget of the
	// next package to share this database, so leave none behind.
	t.Cleanup(func() { resetSchema(t) })
	plugins := &plugin.Store{Pool: pool}
	host := plugin.NewHost(plugins, plugin.HostConfig{})
	bundles := memBundles{}
	host.Bundles = bundles
	// The plugin limits are the defaults. Only the sign-up budget is raised,
	// because thirty people here arrive from one address.
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: testOrigin, Plugins: plugins, PluginHost: host,
		Limits: Limits{IdentityIPHourly: 1 << 20, IdentityGlobalHourly: 1 << 20},
	})
	ctx := context.Background()

	kind := "counter" + randomKindSuffix(t)
	name := newPluginName(t)
	bundles[name+"@1.0.0"] = plugintest.Counter()
	in, err := plugins.Install(ctx, plugin.InstallRequest{
		OrgID: defaultOrg(t, pool), Name: name, Version: "1.0.0", QuotaBytes: 1 << 20,
		Grants: []plugin.Grant{{Capability: plugin.CapabilityKV}},
		Kinds:  []plugin.KindDef{{Kind: kind, Display: "Counter", Actions: []plugin.ActionDef{{Name: "bump", Verb: http.MethodPost}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "delete from sessions where kind = $1", kind)
		_, _ = pool.Exec(ctx, "delete from session_kinds where kind = $1", kind)
	})
	if err := plugins.Put(ctx, in.ID, plugintest.CounterKey, plugintest.CounterSeed); err != nil {
		t.Fatal(err)
	}

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Busy Counter Room", fac)
	slug := sp["slug"].(string)
	resp, body := createSession(t, srv, slug, kind, "Counter", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating the room: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	watching := []*viewer{watch(t, srv, id, fac)}
	for i := 1; i < viewers; i++ {
		c := signup(t, srv, fmt.Sprintf("Viewer %d", i))
		if resp := joinSpace(t, srv, slug, c, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join: %d", resp.StatusCode)
		}
		watching = append(watching, watch(t, srv, id, c))
	}
	late := signup(t, srv, "Late")
	if resp := joinSpace(t, srv, slug, late, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}

	var wg sync.WaitGroup
	var refused atomic.Int64
	for range actions {
		wg.Go(func() {
			req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/sessions/"+id+"/actions/bump", strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(fac)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent {
				refused.Add(1)
				t.Errorf("an action was answered %d, want 204", resp.StatusCode)
			}
		})
	}
	// Somebody opens the room while all of that is going on. Their first
	// frame has to arrive, state and all.
	lateWS, _, err := dialWS(t, srv, id, late, testOrigin)
	if err != nil {
		t.Fatalf("a client could not connect while actions were queued: %v", err)
	}
	defer lateWS.Close()
	_ = lateWS.SetReadDeadline(time.Now().Add(20 * time.Second))
	_, first, err := lateWS.ReadMessage()
	if err != nil {
		t.Fatalf("no first frame for a client that connected while actions were queued: %v", err)
	}
	var firstFrame struct {
		State json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(first, &firstFrame); err != nil || !strings.Contains(string(firstFrame.State), `"found":true`) {
		t.Fatalf("the first frame carries no plugin state: %s", first)
	}
	wg.Wait()

	// Nothing lost on the way in: every action's write is in the stored value.
	value, _, err := plugins.Get(ctx, in.ID, plugintest.CounterKey)
	if err != nil {
		t.Fatal(err)
	}
	if kept := len(value)/3 - 1; kept != actions {
		t.Fatalf("%d of %d actions were kept", kept, actions)
	}
	// And nothing stale on the way out: every viewer ends on that value.
	_, final := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	want, _ := json.Marshal(final["state"])
	var wantState, gotState any
	_ = json.Unmarshal(want, &wantState)
	deadline := time.Now().Add(20 * time.Second)
	for i, v := range watching {
		for {
			_ = json.Unmarshal([]byte(v.state()), &gotState)
			got, _ := json.Marshal(gotState)
			if string(got) == string(want) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("viewer %d ended on %s, want %s", i, v.state(), want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	// Only this room's lines, and only the refusal itself: the logger is the
	// process's, and the server of a test that ran earlier is still listening
	// for notifications with its pool closed, so it logs a failed build of
	// its own for every broadcast here.
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, id) && strings.Contains(line, "too many plugin calls") {
			t.Fatalf("a state build was refused during the burst: %s", line)
		}
	}
	st, err := plugins.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if h := host.Health(in.ID, st.Install.Enabled); h.State != plugin.HealthOK || h.LastError != "" {
		t.Fatalf("the burst left the plugin %s (last error %q), want healthy and uncharged", h.State, h.LastError)
	}
}

// A burst of changes to one room is not a state build per change: a broadcast
// that waited behind one which began after it was asked for is already
// covered by it.
func TestABurstOfBroadcastsOnOneRoomSharesStateBuilds(t *testing.T) {
	const changes = 8
	srv, pool, plugins, host := hostServer(t)
	kind := "burst" + randomKindSuffix(t)
	in := installIn(t, plugins, defaultOrg(t, pool), plugin.KindDef{Kind: kind, Display: "Burst"})

	var builds, arrived atomic.Int64
	counting := atomic.Bool{}
	gate := make(chan struct{})
	_ = host.Kinds.Unregister(kind)
	if err := host.Kinds.Register(session.Kind{
		Name:      kind,
		OrgID:     in.OrgID,
		NewConfig: func() any { return new(json.RawMessage) },
		State: func(context.Context, *pgxpool.Pool, store.Session) (any, error) {
			if counting.Load() && builds.Add(1) == 1 {
				<-gate
			}
			return map[string]any{}, nil
		},
		Actions: map[string]session.Action{
			"change": {Verb: http.MethodPost, Do: func(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
				arrived.Add(1)
				ac.Broadcast(r.Context(), ac.Session.ID)
				w.WriteHeader(http.StatusNoContent)
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Kinds.Unregister(kind) })

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Burst Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Burst", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating the room: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	counting.Store(true)
	var wg sync.WaitGroup
	for range changes {
		wg.Go(func() {
			if _, err := doJSONStatus(t, srv, "POST", "/api/sessions/"+id+"/actions/change", `{}`, fac); err != nil {
				t.Error(err)
			}
		})
	}
	// Every change has reached its broadcast, and the first build is held.
	for deadline := time.Now().Add(10 * time.Second); arrived.Load() < changes; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the changes never arrived")
		}
	}
	close(gate)
	wg.Wait()
	if n := builds.Load(); n >= changes {
		t.Fatalf("%d state builds for %d changes that arrived together; a held broadcast should cover those behind it", n, changes)
	}
}
