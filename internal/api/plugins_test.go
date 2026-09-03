package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

const pluginsPath = "/api/orgs/" + store.DefaultOrgSlug + "/admin/plugins"

// pluginServer wires a router with a plugin store, and hands back an org admin
// — the operator — plus the store the tests seed through.
func pluginServer(t *testing.T) (*httptest.Server, *pgxpool.Pool, *plugin.Store, *http.Cookie, string) {
	t.Helper()
	pool := testPool(t)
	plugins := &plugin.Store{Pool: pool}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: plugins})
	admin, adminID := signupWithID(t, srv, "Operator")
	makeOrgAdmin(t, pool, adminID)
	return srv, pool, plugins, admin, adminID
}

func newPluginName(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("demo-%d", time.Now().UnixNano())
}

func pluginPkg(name, version string, caps ...map[string]string) string {
	body := map[string]any{
		"manifest": 1, "kind": "plugin", "name": name, "version": version,
		"capabilities": caps,
	}
	out, _ := json.Marshal(body)
	return string(out)
}

// Authorization is the middleware, not the nav link. An ordinary org member is
// refused every route on this tree, server-side.
func TestPluginAdminIsRefusedToAnOrdinaryMember(t *testing.T) {
	srv, _, _, _, _ := pluginServer(t)
	member, _ := signupWithID(t, srv, "Member")

	for _, probe := range []struct{ method, path, body string }{
		{"GET", "", ""},
		{"POST", "", `{"grantsAccepted":true,"package":` + pluginPkg("demo", "1.0.0") + `}`},
		{"POST", "/preview", pluginPkg("demo", "1.0.0")},
		{"POST", "/00000000-0000-0000-0000-000000000000/upgrade", `{"approve":true}`},
		{"POST", "/00000000-0000-0000-0000-000000000000/enabled", `{"enabled":false}`},
		{"DELETE", "/00000000-0000-0000-0000-000000000000", ""},
		{"POST", "/themes", `{"name":"x","version":"1.0.0"}`},
	} {
		got, err := requestStatus(srv, probe.method, pluginsPath+probe.path, probe.body, member)
		if err != nil {
			t.Fatal(err)
		}
		if got != http.StatusForbidden {
			t.Errorf("%s %s as an ordinary member = %d, want 403", probe.method, pluginsPath+probe.path, got)
		}
	}
}

// And the operator is not refused, which is what makes the test above mean
// something: a route that 403s everybody would pass it too.
func TestPluginAdminIsOpenToTheOperator(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)
	resp, body := doJSON(t, srv, "GET", pluginsPath, "", admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the operator's own list = %d: %v", resp.StatusCode, body)
	}
	if _, ok := body["installs"]; !ok {
		t.Fatalf("the list carries no installs key: %v", body)
	}
}

// The consent screen's copy comes from the server, so the wildcard an operator
// agrees to is expanded by the code that enforces it.
func TestPreviewExpandsTheAllowlistAndNamesConsequences(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)
	pkg := pluginPkg(newPluginName(t), "1.0.0",
		map[string]string{"capability": "fetch", "scope": "*.example.com"},
		map[string]string{"capability": "session:read"})

	resp, body := doJSON(t, srv, "POST", pluginsPath+"/preview", pkg, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("preview = %d: %v", resp.StatusCode, body)
	}
	raw, _ := json.Marshal(body["grants"])
	var grants []plugin.DescribedGrant
	if err := json.Unmarshal(raw, &grants); err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 {
		t.Fatalf("preview described %d grants, want 2: %v", len(grants), grants)
	}
	var fetch plugin.DescribedGrant
	for _, g := range grants {
		if g.Capability == "fetch" {
			fetch = g
		}
	}
	if fetch.Permits == "" {
		t.Fatal("the fetch grant arrived with no consequence sentence at all")
	}
	if !containsAll(fetch.Permits, "send", "subdomain") {
		t.Fatalf("the fetch grant reads as %q, which does not say what it permits in consequence", fetch.Permits)
	}
	if len(fetch.Allows) == 0 {
		t.Fatal("the wildcard was not expanded into worked examples, so an operator cannot read what it covers")
	}
	if body["widens"] != true {
		t.Fatalf("a fresh install of a plugin asking for two capabilities did not read as widening: %v", body)
	}
}

// The whole lifecycle, and the audit row behind each step.
func TestInstallUpgradeApproveDisableUninstallAreAudited(t *testing.T) {
	srv, pool, plugins, admin, adminID := pluginServer(t)
	ctx := context.Background()
	name := newPluginName(t)

	// An install with no explicit grant decision is refused: a client that
	// never showed the consent screen cannot install by omission.
	got, err := requestStatus(srv, "POST", pluginsPath, `{"package":`+pluginPkg(name, "1.0.0",
		map[string]string{"capability": "log"})+`}`, admin)
	if err != nil {
		t.Fatal(err)
	}
	if got != http.StatusBadRequest {
		t.Fatalf("an install without grantsAccepted = %d, want 400", got)
	}

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0",
			map[string]string{"capability": "log"})+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("the install came back with no id: %v", body)
	}
	assertAudited(t, pool, "plugin.install", adminID)

	// An upgrade asking for more must not get it by arriving: the install
	// keeps its old version and its old grants until somebody approves.
	resp, body = doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "2.0.0",
			map[string]string{"capability": "log"},
			map[string]string{"capability": "fetch", "scope": "*.example.com"})+`}`, admin)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("a widening upgrade = %d, want 202: %v", resp.StatusCode, body)
	}
	state, err := plugins.State(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if state.Install.Version != "1.0.0" {
		t.Fatalf("the plugin moved to %s before anybody approved it", state.Install.Version)
	}
	// Scope matching in State.Allows is exact — the allowlist pattern is the
	// scope, and hostAllowed applies it at fetch time — so the grant is
	// asserted by the pattern it was requested with.
	if state.Allows("fetch", "*.example.com") {
		t.Fatal("the plugin holds the fetch grant it only requested — an unapproved upgrade widened it")
	}
	pending, _ := body["pending"].(map[string]any)
	added, _ := pending["added"].([]any)
	if len(added) != 1 {
		t.Fatalf("the pending upgrade renders %d added grants, want the one it asks for: %v", len(added), pending)
	}

	// Approval is never implicit: a POST that does not say so is refused and
	// the plugin stays where it is.
	if got, err := requestStatus(srv, "POST", pluginsPath+"/"+id+"/upgrade", `{}`, admin); err != nil || got != http.StatusBadRequest {
		t.Fatalf("an approval that did not say approve = %d (%v), want 400", got, err)
	}
	state, _ = plugins.State(ctx, id)
	if state.Install.Version != "1.0.0" {
		t.Fatalf("an unspoken approval moved the plugin to %s", state.Install.Version)
	}

	resp, body = doJSON(t, srv, "POST", pluginsPath+"/"+id+"/upgrade", `{"approve":true}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve = %d: %v", resp.StatusCode, body)
	}
	state, _ = plugins.State(ctx, id)
	if state.Install.Version != "2.0.0" || !state.Allows("fetch", "*.example.com") {
		t.Fatalf("after approval the install is %+v", state)
	}
	assertAudited(t, pool, "plugin.upgrade_approved", adminID)

	// Disable is reversible and must never be routed through uninstall.
	resp, body = doJSON(t, srv, "POST", pluginsPath+"/"+id+"/enabled", `{"enabled":false}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable = %d: %v", resp.StatusCode, body)
	}
	if state, _ = plugins.State(ctx, id); state.Install.Enabled {
		t.Fatal("the plugin is still enabled after a disable")
	}
	assertAudited(t, pool, "plugin.disable", adminID)
	health, _ := body["health"].(map[string]any)
	if health["state"] != "disabled" || health["reason"] == "" {
		t.Fatalf("a disabled plugin reports health %v, and the screen has to be able to say why", health)
	}

	if _, err := doJSONStatus(t, srv, "POST", pluginsPath+"/"+id+"/enabled", `{"enabled":true}`, admin); err != nil {
		t.Fatal(err)
	}
	assertAudited(t, pool, "plugin.enable", adminID)

	got, err = requestStatus(srv, "DELETE", pluginsPath+"/"+id, "", admin)
	if err != nil {
		t.Fatal(err)
	}
	if got != http.StatusNoContent {
		t.Fatalf("uninstall = %d, want 204", got)
	}
	if _, err := plugins.State(ctx, id); err == nil {
		t.Fatal("the install survived its own uninstall")
	}
	assertAudited(t, pool, "plugin.uninstall", adminID)
}

// The refusal has to say which rooms block it.
func TestUninstallIsRefusedAndExplainsWhichSessionsBlockIt(t *testing.T) {
	srv, pool, plugins, admin, _ := pluginServer(t)
	ctx := context.Background()
	name := newPluginName(t)

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0",
			map[string]string{"capability": "log"})+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	kind := "retro" + id[:8]
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display) values ($1, $2, 'Retrospective')`,
		kind, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(context.Background(), `delete from session_kinds where kind = $1`, kind)
	})
	slug, owner, _, _ := privateSpace(t, srv)
	_ = owner
	var spaceID, facilitator string
	if err := pool.QueryRow(ctx, `select id from spaces where slug = $1`, slug).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select user_id from members where space_id = $1 limit 1`, spaceID).Scan(&facilitator); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into sessions (space_id, kind, title, facilitator_id) values ($1, $2, 'Retro', $3)`,
		spaceID, kind, facilitator); err != nil {
		t.Fatal(err)
	}

	resp, body = doJSON(t, srv, "DELETE", pluginsPath+"/"+id, "", admin)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("uninstall with a live room of its kind = %d, want 409: %v", resp.StatusCode, body)
	}
	msg, _ := body["error"].(string)
	if !containsAll(msg, "Retrospective") {
		t.Fatalf("the refusal is %q and does not name the rooms that block it", msg)
	}
	if body["blocked"] == nil {
		t.Fatalf("the refusal carries no machine-readable list of what blocks it: %v", body)
	}
	if _, err := plugins.State(ctx, id); err != nil {
		t.Fatalf("a refused uninstall deleted the install anyway: %v", err)
	}
}

// The theme tier executes nothing, but it is still an install.
func TestApplyingAThemeIsAudited(t *testing.T) {
	srv, pool, _, admin, adminID := pluginServer(t)
	got, err := requestStatus(srv, "POST", pluginsPath+"/themes",
		`{"name":"Midnight","version":"1.0.0","contrastAcknowledged":true}`, admin)
	if err != nil || got != http.StatusNoContent {
		t.Fatalf("theme audit = %d (%v), want 204", got, err)
	}
	detail := assertAudited(t, pool, "theme.install", adminID)
	if !containsAll(detail, "Midnight", "contrast") {
		t.Fatalf("the audit detail is %q and does not record what was applied or that the gate was overridden", detail)
	}
}

/* ------------------------------------------------------------- helpers -- */

// assertAudited fails unless exactly this action was recorded against this
// actor, and returns the detail so a test can assert on what it says.
func assertAudited(t *testing.T, pool *pgxpool.Pool, action, actorID string) string {
	t.Helper()
	var detail string
	if err := pool.QueryRow(context.Background(),
		`select detail from org_audit_log where action = $1 and actor_id = $2
		 order by created_at desc limit 1`, action, actorID).Scan(&detail); err != nil {
		t.Fatalf("no %s audit record for the acting operator: %v", action, err)
	}
	return detail
}

func doJSONStatus(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie) (map[string]any, error) {
	t.Helper()
	resp, out := doJSON(t, srv, method, path, body, cookie)
	if resp.StatusCode >= 300 {
		return out, fmt.Errorf("%s %s = %d: %v", method, path, resp.StatusCode, out)
	}
	return out, nil
}

func containsAll(haystack string, needles ...string) bool {
	for _, n := range needles {
		found := false
		for i := 0; i+len(n) <= len(haystack); i++ {
			if haystack[i:i+len(n)] == n {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
