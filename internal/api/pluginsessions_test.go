package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// hostServer is a server with a plugin host wired into it, which is what gives
// the host its session surface and its kind registry. There is no bundle
// source: nothing here runs guest code, because what is under test is the
// surface the guest would reach through and the path a registered kind is
// dispatched on.
func hostServer(t *testing.T) (*httptest.Server, *pgxpool.Pool, *plugin.Store, *plugin.Host) {
	t.Helper()
	pool := testPool(t)
	plugins := &plugin.Store{Pool: pool}
	host := plugin.NewHost(plugins, plugin.HostConfig{})
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: plugins, PluginHost: host})
	return srv, pool, plugins, host
}

// installIn records an install for an org directly, which is the operator
// route's own effect minus the HTTP.
func installIn(t *testing.T, plugins *plugin.Store, orgID string, kinds ...plugin.KindDef) plugin.Install {
	t.Helper()
	in, err := plugins.Install(context.Background(), plugin.InstallRequest{
		OrgID: orgID, Name: newPluginName(t), Version: "1.0.0",
		QuotaBytes: 1 << 20, Kinds: kinds,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, k := range kinds {
			_, _ = plugins.Pool.Exec(ctx, "delete from sessions where kind = $1", k.Kind)
			_, _ = plugins.Pool.Exec(ctx, "delete from session_kinds where kind = $1", k.Kind)
		}
	})
	return in
}

func defaultOrg(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	org, err := (&store.Orgs{Pool: pool}).Default(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return org.ID
}

// The room a plugin can reach is a room of its own ceremony. A poker room is
// provider 'core' with no org, so no install provides it — and this is the
// finding that made the check exist: patching {"revealed": true} at a poker
// room is the facilitator-only reveal, reached without being the facilitator,
// and it turns every hidden vote in the room into a readable one.
//
// So this asserts the refusal *and* the consequence: after the refused patch
// the room is still hidden, and the votes are still not there to read.
func TestAPluginCannotReadOrRevealAPokerRoomItDoesNotProvide(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	// An install of this org, holding a ceremony of its own — so what shuts it
	// out of the poker room is the poker room's kind and not a missing org or
	// a plugin that provides nothing at all.
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, defaultOrg(t, pool), plugin.KindDef{Kind: kind, Display: "Retrospective"})

	fac, member, id := setupSession(t, srv, "Plugin Eyes A Poker Room")
	story := addStory(t, srv, id, "Login page", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "13", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}

	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"revealed":true}`)); err == nil {
		t.Fatal("a plugin revealed a poker room it does not provide")
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"mine"}`)); err == nil {
		t.Fatal("a plugin moved the phase of a poker room it does not provide")
	}
	if _, err := host.Sessions.Read(ctx, in.ID, id); err == nil {
		t.Fatal("a plugin read a poker room it does not provide")
	}

	// The consequence, not just the return value: the reveal did not happen,
	// so the votes are still hidden from everybody who can see the room.
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Revealed {
		t.Fatal("the refused patch revealed the room anyway")
	}
	resp, body := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reading the room back: %d", resp.StatusCode)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"value":"13"`) {
		t.Fatalf("the vote is readable after the refused reveal: %s", raw)
	}
}

// A plugin reads a room of its own ceremony through the same envelope a
// browser is sent, built by the session registry. That is what makes the
// surface a projection rather than a filter: whatever the kind's own State
// decided is client-safe is what a plugin gets, and there is no second path
// that reaches storage directly.
func TestAPluginReadsItsOwnRoomThroughTheRegistryEnvelope(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})

	// The kind's State is the only thing that decides the payload, and this one
	// has something to hide: the authors of the notes are emitted only once the
	// room is revealed, exactly as poker's vote values are. That is what makes
	// the assertion below a redaction assertion rather than a shape assertion —
	// the field exists, the plugin owns this ceremony, and it still does not get
	// it until the state function says so.
	registerStubKind(t, host, kind, in.OrgID, func(sess store.Session) any {
		out := map[string]any{"columns": []string{"went-well"}}
		if sess.Revealed {
			out["authors"] = []string{"Fay"}
		}
		return out
	})

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Own Ceremony Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of the plugin's own kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	state, err := host.Sessions.Read(ctx, in.ID, id)
	if err != nil {
		t.Fatalf("reading a room of its own ceremony: %v", err)
	}
	if !strings.Contains(string(state), `"columns":["went-well"]`) {
		t.Fatalf("the plugin was not given its own room's state: %s", state)
	}
	if strings.Contains(string(state), "authors") {
		t.Fatalf("the plugin was handed a field its kind redacts before the reveal: %s", state)
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"gathering"}`)); err != nil {
		t.Fatalf("patching a room of its own ceremony: %v", err)
	}

	// And the projection tracks the room rather than the caller: once the room
	// is revealed the same read carries the field, so what was withheld above
	// was withheld by the state function and not by a plugin-shaped filter.
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"revealed":true}`)); err != nil {
		t.Fatalf("revealing a room of its own ceremony: %v", err)
	}
	state, err = host.Sessions.Read(ctx, in.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(state), `"authors":["Fay"]`) {
		t.Fatalf("the revealed room still withholds the field: %s", state)
	}
}

// The kind-ownership check is fail-closed, and that is a property of its
// failure path: when the store cannot answer "does this install provide this
// ceremony", the surface refuses rather than assuming it does.
//
// Nothing else in this file can see it. Every fixture here has a database that
// answers, so swallowing the error and defaulting to "yes" leaves the whole
// package green — including every test above, which is why pluginSessions has
// a seam for the answer at all. The seam is nil in production; a test is the
// only thing that ever sets it.
func TestAnUnanswerableOwnershipQuestionRefusesRatherThanGrants(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any {
		return map[string]any{"columns": []string{"went-well"}}
	})

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Room The Store Cannot Vouch For", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of the plugin's own kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	// Reachable while the store answers, so the refusals below are about the
	// failure and not about a room this plugin could never touch.
	if _, err := host.Sessions.Read(ctx, in.ID, id); err != nil {
		t.Fatalf("reading its own room while the store is answering: %v", err)
	}

	surface, ok := host.Sessions.(*pluginSessions)
	if !ok {
		t.Fatalf("the host's session surface is %T, not the one this test can reach into", host.Sessions)
	}
	boom := errors.New("the ownership question could not be answered")
	surface.provideKind = func(context.Context, string, string) (bool, error) { return false, boom }
	t.Cleanup(func() { surface.provideKind = nil })

	if _, err := host.Sessions.Read(ctx, in.ID, id); !errors.Is(err, boom) {
		t.Fatalf("reading a room whose ownership could not be resolved: got %v, want the store's error", err)
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"revealed":true}`)); !errors.Is(err, boom) {
		t.Fatalf("patching a room whose ownership could not be resolved: got %v, want the store's error", err)
	}

	// The consequence, not only the return value: the reveal the patch asked
	// for did not happen.
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Revealed {
		t.Fatal("a patch that could not be authorised revealed the room anyway")
	}
}

// registerStubKind puts a kind into the live registry without a guest behind
// it. Nothing here runs WASM, so a plugin-provided kind's State has to come
// from somewhere: this is that somewhere, and it stands in for the guest call
// h.PluginKind would make.
func registerStubKind(t *testing.T, host *plugin.Host, kind, orgID string, state func(store.Session) any) {
	t.Helper()
	if err := host.Kinds.Register(session.Kind{
		Name:      kind,
		OrgID:     orgID,
		NewConfig: func() any { return new(json.RawMessage) },
		State: func(_ context.Context, _ *pgxpool.Pool, sess store.Session) (any, error) {
			return state(sess), nil
		},
		Actions: map[string]session.Action{},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Kinds.Unregister(kind) })
}

// Switching a plugin off takes its ceremony away while rooms of it are still
// open. Those rooms outlive the install by design — sessions.kind is a foreign
// key to a row that is retired rather than deleted — so the room has to load in
// a degraded state and come back untouched when the plugin is switched on
// again. Erroring instead would mean an operator disabling a plugin broke every
// room of its kind, including the history of rooms that had already ended.
func TestARoomOfADisabledPluginsKindStillLoadsAndComesBack(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any {
		return map[string]any{"columns": []string{"went-well"}}
	})

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Disabled Ceremony Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of a plugin-provided kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	// The real disable path: it reads what the install provides and retires
	// exactly those kinds out of the live registry.
	if err := host.Disable(ctx, in.ID, "an operator switched it off"); err != nil {
		t.Fatalf("disabling the plugin: %v", err)
	}
	if host.Kinds.(*session.Registry).Known(kind) {
		t.Fatal("the disable left the ceremony registered, so the rest of this proves nothing")
	}

	resp, body = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a room whose plugin is switched off: got %d, want 200", resp.StatusCode)
	}
	if body["kindUnavailable"] != true {
		t.Fatalf("the room does not say its ceremony is unavailable: %v", body)
	}
	if body["state"] != nil {
		t.Fatalf("a room with no ceremony running carried a state payload: %v", body["state"])
	}
	if body["title"] != "Retro" {
		t.Fatalf("the degraded room lost the session's own data: %v", body)
	}

	// And switching it back on restores the room exactly as it was. The
	// registration stands in for OfferKinds, which would build a guest-backed
	// kind and there is no guest here.
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any {
		return map[string]any{"columns": []string{"went-well"}}
	})
	resp, body = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a room whose plugin is switched back on: %d", resp.StatusCode)
	}
	if body["kindUnavailable"] != nil {
		t.Fatalf("the room still reports its ceremony unavailable: %v", body)
	}
	raw, err := json.Marshal(body["state"])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"columns":["went-well"]`) {
		t.Fatalf("the restored room did not get its ceremony's state back: %s", raw)
	}
}

// The browser frames a plugin kind from the envelope, not from a second fetch.
// Name, version and grants have to travel with the ceremony so SessionPage can
// point the sandbox at /plugin-ui and redact against the grants in force.
func TestAPluginKindEnvelopeNamesTheInstall(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installCeremony(t, plugins, orgID, newPluginName(t), kind,
		plugin.Grant{Capability: plugin.CapabilitySessionRead},
	)
	registerPluginKindWithStubState(t, host, plugins, in, kind)

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Named Ceremony Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of a plugin-provided kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)
	resp, body = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reading the room: %d %v", resp.StatusCode, body)
	}
	plug, _ := body["plugin"].(map[string]any)
	if plug == nil {
		t.Fatalf("the envelope named no install: %v", body)
	}
	if plug["name"] != in.Name || plug["version"] != "1.0.0" {
		t.Fatalf("plugin on the envelope is %v, want %s@1.0.0", plug, in.Name)
	}
	grants, _ := plug["grants"].([]any)
	if len(grants) != 1 || grants[0] != "session:read" {
		t.Fatalf("grants on the envelope are %v", plug["grants"])
	}
}

func offeredPluginGrants(t *testing.T, host *plugin.Host, kind string) string {
	t.Helper()
	p := host.Kinds.(*session.Registry).KindPlugin(kind)
	if p == nil {
		return ""
	}
	return strings.Join(p.Grants, ",")
}

func installCeremony(t *testing.T, plugins *plugin.Store, orgID, name, kind string, grants ...plugin.Grant) plugin.Install {
	t.Helper()
	in, err := plugins.Install(context.Background(), plugin.InstallRequest{
		OrgID: orgID, Name: name, Version: "1.0.0", QuotaBytes: 1 << 20,
		Grants: grants, Kinds: []plugin.KindDef{{Kind: kind, Display: "Retrospective"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = plugins.Pool.Exec(ctx, "delete from sessions where kind = $1", kind)
		_, _ = plugins.Pool.Exec(ctx, "delete from session_kinds where kind = $1", kind)
	})
	return in
}

func registerPluginKindWithStubState(t *testing.T, host *plugin.Host, plugins *plugin.Store, in plugin.Install, kind string) {
	t.Helper()
	st, err := plugins.State(context.Background(), in.ID)
	if err != nil {
		t.Fatal(err)
	}
	k := host.PluginKind(st, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	k.State = func(_ context.Context, _ *pgxpool.Pool, _ store.Session) (any, error) {
		return map[string]any{"columns": []string{"went-well"}}, nil
	}
	if err := host.Kinds.Register(k); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Kinds.Unregister(kind) })
}

// A narrowing upgrade replaces the grants in force. The kind registered at
// enable still names the old set unless OfferKinds runs again, and the room
// iframe redacts against that snapshot.
func TestANarrowingUpgradeRebuildsTheKindPluginGrants(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	admin, adminID := signupWithID(t, srv, "Operator")
	makeOrgAdmin(t, pool, adminID)
	kind := "retro" + randomKindSuffix(t)
	name := newPluginName(t)
	in := installCeremony(t, plugins, orgID, name, kind,
		plugin.Grant{Capability: plugin.CapabilitySessionRead},
		plugin.Grant{Capability: plugin.CapabilityLog},
	)
	if err := host.OfferKinds(ctx, in.ID); err != nil {
		t.Fatal(err)
	}
	if got := offeredPluginGrants(t, host, kind); got != "log,session:read" {
		t.Fatalf("before the upgrade the kind names %q", got)
	}

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.1.0",
			map[string]string{"capability": "session:read"})+`}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("narrowing upgrade = %d: %v", resp.StatusCode, body)
	}
	if got := offeredPluginGrants(t, host, kind); got != "session:read" {
		t.Fatalf("after a narrowing upgrade the kind still names %q, want session:read", got)
	}
}

// Approving a wider grant set is the other write that changes what the
// sandbox may be told it holds.
func TestApprovingAnUpgradeRebuildsTheKindPluginGrants(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	admin, adminID := signupWithID(t, srv, "Operator")
	makeOrgAdmin(t, pool, adminID)
	kind := "retro" + randomKindSuffix(t)
	name := newPluginName(t)
	in := installCeremony(t, plugins, orgID, name, kind,
		plugin.Grant{Capability: plugin.CapabilityLog},
	)
	if err := host.OfferKinds(ctx, in.ID); err != nil {
		t.Fatal(err)
	}
	if got := offeredPluginGrants(t, host, kind); got != "log" {
		t.Fatalf("before approval the kind names %q", got)
	}

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "2.0.0",
			map[string]string{"capability": "log"},
			map[string]string{"capability": "session:read"})+`}`, admin)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("widening upgrade = %d, want 202: %v", resp.StatusCode, body)
	}
	if got := offeredPluginGrants(t, host, kind); got != "log" {
		t.Fatalf("a pending upgrade changed the kind's grants to %q", got)
	}

	resp, body = doJSON(t, srv, "POST", pluginsPath+"/"+in.ID+"/upgrade", `{"approve":true}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve = %d: %v", resp.StatusCode, body)
	}
	if got := offeredPluginGrants(t, host, kind); got != "log,session:read" {
		t.Fatalf("after approval the kind still names %q, want log,session:read", got)
	}
}

func envelopePluginGrants(body map[string]any) string {
	plug, _ := body["plugin"].(map[string]any)
	raw, _ := plug["grants"].([]any)
	out := make([]string, 0, len(raw))
	for _, g := range raw {
		s, _ := g.(string)
		out = append(out, s)
	}
	return strings.Join(out, ",")
}

// Nested panels read Store.State; the full-room path must not keep a stale
// Kind.Plugin snapshot after the grants in force have changed.
func TestASessionEnvelopeReflectsLiveGrantsAfterANarrowingUpgrade(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installCeremony(t, plugins, orgID, newPluginName(t), kind,
		plugin.Grant{Capability: plugin.CapabilitySessionRead},
		plugin.Grant{Capability: plugin.CapabilityLog},
	)
	registerPluginKindWithStubState(t, host, plugins, in, kind)

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Live Grant Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of a plugin-provided kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)
	resp, body = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reading the room: %d %v", resp.StatusCode, body)
	}
	if got := envelopePluginGrants(body); got != "log,session:read" {
		t.Fatalf("before the upgrade the envelope names %q", got)
	}

	if err := plugins.Upgrade(ctx, in.ID, "1.1.0", []plugin.Grant{
		{Capability: plugin.CapabilitySessionRead},
	}, nil); err != nil {
		t.Fatal(err)
	}
	resp, body = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reading the room after the upgrade: %d %v", resp.StatusCode, body)
	}
	if got := envelopePluginGrants(body); got != "session:read" {
		t.Fatalf("after a narrowing upgrade the envelope still names %q", got)
	}
}

// An install belongs to one org and so does everything it may touch.
//
// Isolating that from the kind-ownership check takes some care, and the care is
// the point: through the API the two overlap, because a room can only ever be
// created of a kind its own org is offered. So the room here is one of the
// install's *own* ceremony — ownership satisfied — and its space is then moved
// into another org underneath it, which is the only shape where the org check
// is the thing doing the refusing. Break sameOrg and this test goes red; break
// ownsKind and it does not, which is what says the two guards are tested apart.
func TestAPluginCannotReadOrPatchAnotherOrgsRoom(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any { return map[string]any{} })

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Room That Moves Org", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of the plugin's own kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	// Reachable before the move, so the refusals below are about the org and
	// not about a room the plugin could never touch in the first place.
	if _, err := host.Sessions.Read(ctx, in.ID, id); err != nil {
		t.Fatalf("reading its own room before the move: %v", err)
	}

	other := newOrgRow(t, pool)
	if _, err := pool.Exec(ctx,
		"update spaces set org_id = $1 where slug = $2", other, sp["slug"]); err != nil {
		t.Fatal(err)
	}

	if _, err := host.Sessions.Read(ctx, in.ID, id); err == nil {
		t.Fatal("a plugin read a room that is not in its org")
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"mine"}`)); err == nil {
		t.Fatal("a plugin patched a room that is not in its org")
	}
}

// The patch surface is a closed document, an ended room is closed to it, and a
// change it does make reaches the room.
func TestAPluginPatchIsBoundedAndRefusedOnAnEndedRoom(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any { return map[string]any{} })

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Plugin Patches A Room", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of the plugin's own kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"endedAt":"2020-01-01T00:00:00Z"}`)); err == nil {
		t.Fatal("a plugin closed a room through a field the patch document does not have")
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"gathering"}`)); err != nil {
		t.Fatalf("patching the phase of a room in its own org: %v", err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Phase != "gathering" {
		t.Fatalf("phase = %q, want the patched value", sess.Phase)
	}

	closeSession(t, srv, id, fac)
	err = host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"after-hours"}`))
	if !errors.Is(err, store.ErrSessionEnded) {
		t.Fatalf("patching an ended room: got %v, want ErrSessionEnded", err)
	}
}

// A kind registered at runtime is dispatched on exactly the ladder a core kind
// is: an unknown action is 404, the wrong verb 405, a facilitator-only action
// asked by a member 403, and anything at all on an ended room 409.
func TestAPluginProvidedKindGoesThroughTheSameAuthorisationLadder(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})

	ran := false
	if err := host.Kinds.Register(session.Kind{
		Name:      kind,
		OrgID:     in.OrgID,
		NewConfig: func() any { return new(json.RawMessage) },
		State: func(context.Context, *pgxpool.Pool, store.Session) (any, error) {
			return map[string]any{"columns": []string{}}, nil
		},
		Actions: map[string]session.Action{
			"gather": {Verb: http.MethodPost, Do: func(w http.ResponseWriter, _ *http.Request, _ session.ActionCtx) {
				ran = true
				w.WriteHeader(http.StatusNoContent)
			}},
			"close": {Verb: http.MethodPost, FacilitatorOnly: true, Do: func(w http.ResponseWriter, _ *http.Request, _ session.ActionCtx) {
				w.WriteHeader(http.StatusNoContent)
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Kinds.Unregister(kind) })

	fac := signup(t, srv, "Fay")
	member := signup(t, srv, "Mel")
	_, sp := createSpace(t, srv, "Runtime Kind Room", fac)
	slug := sp["slug"].(string)
	if resp := joinSpace(t, srv, slug, member, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	resp, body := createSession(t, srv, slug, kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of a plugin-provided kind: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/gather", `{}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("a granted action of a plugin kind: %d", resp.StatusCode)
	}
	if !ran {
		t.Fatal("the dispatcher answered but never reached the kind")
	}
	for _, c := range []struct {
		name, method, action string
		cookie               *http.Cookie
		want                 int
	}{
		{"an unknown action", "POST", "nope", member, http.StatusNotFound},
		{"the wrong verb", "PUT", "gather", member, http.StatusMethodNotAllowed},
		{"a facilitator-only action", "POST", "close", member, http.StatusForbidden},
	} {
		resp, _ := doJSON(t, srv, c.method, "/api/sessions/"+id+"/actions/"+c.action, `{}`, c.cookie)
		if resp.StatusCode != c.want {
			t.Errorf("%s on a plugin kind: got %d, want %d", c.name, resp.StatusCode, c.want)
		}
	}

	closeSession(t, srv, id, fac)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/gather", `{}`, fac); resp.StatusCode != http.StatusConflict {
		t.Errorf("an action on an ended room of a plugin kind: got %d, want 409", resp.StatusCode)
	}

	// The registry refuses a GET action whoever registers it: an action is a
	// write and the cross-site guard exempts GET.
	err := host.Kinds.Register(session.Kind{
		Name:    kind + "-get",
		OrgID:   in.OrgID,
		Actions: map[string]session.Action{"peek": {Verb: http.MethodGet}},
	})
	if err == nil {
		t.Fatal("a plugin registered an action answering GET, which the cross-site guard exempts")
	}
	_ = ctx
}

// newOrgRow makes a second org. The migrations ship one, and a cross-org test
// needs another one to be shut out of.
func newOrgRow(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	slug := "org" + randomKindSuffix(t)
	var id string
	if err := pool.QueryRow(context.Background(),
		"insert into orgs (slug, name, claim_value) values ($1, $1, $1) returning id::text", slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// randomKindSuffix keeps a test's kind name unique: session_kinds.kind is the
// primary key and rows outlive a single test run only if cleanup fails, but
// two tests running against one database must not collide either way.
func randomKindSuffix(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
}
