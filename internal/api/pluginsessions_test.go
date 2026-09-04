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

// A plugin reads a room through the same envelope a browser is sent, so the
// kind's own redaction is what it gets. Poker's pre-reveal state names who has
// voted and never what they voted, and that is the line this pins: a plugin
// with session:read granted still cannot see a vote value before the reveal.
func TestAPluginCannotReadAVoteValueBeforeTheReveal(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	in := installIn(t, plugins, defaultOrg(t, pool))

	fac, member, id := setupSession(t, srv, "Plugin Reads A Room")
	voterID := userID(t, srv, member)
	story := addStory(t, srv, id, "Login page", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "13", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}

	if host.Sessions == nil {
		t.Fatal("the host has no session surface, so parley_session_get answers ErrNoSessions")
	}
	state, err := host.Sessions.Read(ctx, in.ID, id)
	if err != nil {
		t.Fatalf("reading a room of its own org: %v", err)
	}
	// Pre-reveal poker emits who has voted and omits the votes entirely, so
	// the absence of the votes array is the redaction itself rather than a
	// value that happens not to appear.
	if strings.Contains(string(state), `"votes"`) {
		t.Fatalf("a pre-reveal vote value is readable by a plugin: %s", state)
	}
	if !strings.Contains(string(state), `"votedUserIds":["`+voterID+`"]`) {
		t.Fatalf("the plugin was not given the room's state at all: %s", state)
	}

	// After the reveal the same read shows it, which is what says the check
	// above is about the reveal and not about the read failing.
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal: %d %v", resp.StatusCode, body)
	}
	revealed, err := host.Sessions.Read(ctx, in.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(revealed), `"value":"13"`) {
		t.Fatalf("the vote is still hidden after the reveal, so the check above proves nothing: %s", revealed)
	}
}

// An install belongs to one org and so does everything it may touch. A room in
// another org answers the same "no such session" as one that does not exist.
func TestAPluginCannotReadOrPatchAnotherOrgsRoom(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	other := newOrgRow(t, pool)
	in := installIn(t, plugins, other)

	fac, _, id := setupSession(t, srv, "Another Orgs Room")
	_ = fac

	if _, err := host.Sessions.Read(ctx, in.ID, id); err == nil {
		t.Fatal("a plugin installed in another org read this org's room")
	}
	if err := host.Sessions.Patch(ctx, in.ID, id, []byte(`{"phase":"mine"}`)); err == nil {
		t.Fatal("a plugin installed in another org patched this org's room")
	}
}

// The patch surface is a closed document, an ended room is closed to it, and a
// change it does make reaches the room.
func TestAPluginPatchIsBoundedAndRefusedOnAnEndedRoom(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	ctx := context.Background()
	in := installIn(t, plugins, defaultOrg(t, pool))
	fac, _, id := setupSession(t, srv, "Plugin Patches A Room")

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
