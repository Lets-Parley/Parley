package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	return pluginPkgWith(name, version, nil, caps...)
}

func pluginPkgWith(name, version string, kinds []plugin.KindDef, caps ...map[string]string) string {
	body := map[string]any{
		"manifest": 1, "kind": "plugin", "name": name, "version": version,
		"capabilities": caps,
	}
	if kinds != nil {
		body["kinds"] = kinds
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
		// mountPlugins registers eight routes and this table probes all
		// eight. The theme reset is gated by the same middleware as the rest,
		// so leaving it out was a coverage gap rather than a hole — but it is
		// exactly the gap a refactor that moved one route out from under the
		// gate would slip through unnoticed.
		{"DELETE", "/themes", ""},
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
		`insert into session_kinds (kind, provider, display, org_id) values ($1, $2, 'Retrospective', $3)`,
		kind, name, defaultOrg(t, pool)); err != nil {
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

// The cross-tenant attack, pinned.
//
// plugin_installs carried no org until 0034 and `name` was unique across the
// instance, so every lookup resolved against every install on the box. The
// admin gate in front of these routes resolves the {slug} in the caller's own
// path, which proves only that they administer *an* org: an admin of a second
// org — never a member of the first — could list the first org's installs and
// then uninstall one, destroying its key-value store and its unrecoverable
// encrypted secrets, with the audit row landing in their own org's log.
//
// Every route that takes an install id must answer 404 for an id belonging to
// somebody else, and 404 rather than 403, so the surface cannot be used to
// learn which ids exist elsewhere.
func TestOneOrgsAdminCannotTouchAnothersPlugin(t *testing.T) {
	srv, pool, plugins, admin, _ := pluginServer(t)
	ctx := context.Background()

	// Org A's plugin, installed by org A's operator through the real surface.
	name := newPluginName(t)
	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0",
			map[string]string{"capability": "log"})+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}
	victimID, _ := body["id"].(string)
	if victimID == "" {
		t.Fatalf("the install came back with no id: %v", body)
	}

	// A second org, freshly created, and an admin of it who has never been a
	// member of the first.
	otherSlug := "other-" + randomSlugSuffix(t)
	var otherOrg string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id",
		otherSlug).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "delete from orgs where id = $1", otherOrg) })
	attacker, attackerID := signupWithID(t, srv, "Interloper")
	if _, err := pool.Exec(ctx,
		"delete from org_members where user_id = $1", attackerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')",
		otherOrg, attackerID); err != nil {
		t.Fatal(err)
	}
	otherPath := "/api/orgs/" + otherSlug + "/admin/plugins"

	// The list is the org's own, so the victim's install is not in it. This is
	// the reconnaissance step the attack starts from.
	resp, body = doJSON(t, srv, "GET", otherPath, "", attacker)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the second org's own list = %d: %v", resp.StatusCode, body)
	}
	installs, _ := body["installs"].([]any)
	for _, raw := range installs {
		view, _ := raw.(map[string]any)
		if view["id"] == victimID {
			t.Fatalf("the second org's admin can see another org's install in their own list: %v", body)
		}
	}

	// And every route that takes an id refuses the foreign one, with 404
	// rather than 403.
	for _, probe := range []struct{ method, path, body string }{
		{"POST", "/" + victimID + "/upgrade", `{"approve":true}`},
		{"POST", "/" + victimID + "/enabled", `{"enabled":false}`},
		{"DELETE", "/" + victimID, ""},
	} {
		got, err := requestStatus(srv, probe.method, otherPath+probe.path, probe.body, attacker)
		if err != nil {
			t.Fatal(err)
		}
		if got != http.StatusNotFound {
			t.Errorf("%s %s against another org's install = %d, want 404",
				probe.method, otherPath+probe.path, got)
		}
	}

	// The install and its data survived all of it.
	if _, err := plugins.State(ctx, victimID); err != nil {
		t.Fatalf("another org's admin destroyed this install: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx,
		"select count(*) from plugin_installs where id = $1", victimID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("the victim org has %d rows for its install, want 1", count)
	}

	// The same plugin name in the second org is a different install, not a
	// collision with the first org's: ownership is what "installed" means now.
	resp, body = doJSON(t, srv, "POST", otherPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0",
			map[string]string{"capability": "log"})+`}`, attacker)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("installing the same plugin name in a second org = %d, want 201: %v", resp.StatusCode, body)
	}
	if body["id"] == victimID {
		t.Fatal("the second org's install is the first org's install")
	}
}

// The approval route 404s an install that does not exist — as the operator,
// not only as the member the authorization table already covers. It used to
// 500 here, which reads as a server fault rather than a typo in a URL.
func TestApprovingAnUpgradeOnAnUnknownInstallIsNotFound(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)
	got, err := requestStatus(srv, "POST",
		pluginsPath+"/3f1d2c4b-5a6e-4b7c-8d9e-0a1b2c3d4e5f/upgrade", `{"approve":true}`, admin)
	if err != nil {
		t.Fatal(err)
	}
	if got != http.StatusNotFound {
		t.Fatalf("approving an upgrade on an install that does not exist = %d, want 404", got)
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

// The browser reads the wire, not the Go struct: a slice field that is nil at
// With no plugin host running, the server cannot observe anything about an
// enabled install's runtime health — so it must not assert HealthOK, which
// reads to an operator as "this was checked and is fine". Disabled must stay
// exactly as before: it is durable in plugin_installs.enabled and is known
// without a host.
func TestHealthWithoutAHostIsUnknownNotHealthy(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)

	name := newPluginName(t)
	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0")+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)

	_, listBody := doJSON(t, srv, "GET", pluginsPath, "", admin)
	installs, _ := listBody["installs"].([]any)
	var enabledHealth map[string]any
	for _, raw := range installs {
		m, _ := raw.(map[string]any)
		if m["id"] == id {
			enabledHealth, _ = m["health"].(map[string]any)
		}
	}
	if enabledHealth == nil {
		t.Fatalf("the new install did not appear in the list: %v", listBody)
	}
	if enabledHealth["state"] == plugin.HealthOK {
		t.Fatalf("an enabled install with no host running reports health %v — nothing is running to have observed that", enabledHealth)
	}
	if enabledHealth["state"] != plugin.HealthUnknown {
		t.Fatalf("an enabled install with no host running reports health %v, want state %q", enabledHealth, plugin.HealthUnknown)
	}
	if enabledHealth["reason"] == "" {
		t.Fatalf("an unknown health reports no reason: %v", enabledHealth)
	}

	// Disabled is unaffected: it is durable and known without a host.
	resp, disableBody := doJSON(t, srv, "POST", pluginsPath+"/"+id+"/enabled", `{"enabled":false}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable = %d: %v", resp.StatusCode, disableBody)
	}
	disabledHealth, _ := disableBody["health"].(map[string]any)
	if disabledHealth["state"] != plugin.HealthDisabled || disabledHealth["reason"] != "an operator switched it off" {
		t.Fatalf("a disabled install with no host reports health %v", disabledHealth)
	}
}

// marshal time serializes as JSON null, and PluginsPage.tsx indexes straight
// into every one of these with `.length`, which throws on null. Every place
// the API declares an array — provides, and a preview's added/removed — must
// therefore come across as `[]`, never `null`, in the exact bytes a browser
// receives. This is asserted against the raw response body, not a decoded Go
// value: decoding through map[string]any would collapse "obviously missing"
// and "explicitly null" into the same nil interface and hide the bug.
func TestPluginJSONNeverSendsNullForADeclaredArray(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)

	// An install that provides no session kinds is the ordinary case, not the
	// exception — most plugins provide nothing — so this is what the page
	// sees for essentially every install it lists.
	name := newPluginName(t)
	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0")+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}

	raw := rawBody(t, srv, "GET", pluginsPath, "", admin)
	if strings.Contains(raw, `"provides":null`) {
		t.Fatalf("the install list marshals provides as null, which crashes install.provides.length in the browser: %s", raw)
	}
	if !strings.Contains(raw, `"provides":[]`) {
		t.Fatalf("the install list does not carry provides as an empty array: %s", raw)
	}

	// A preview of a brand-new plugin — no prior install to diff against — has
	// nothing pending. added/removed must still be arrays: the frontend type
	// declares them non-optional, and the page reads preview.added.length
	// unconditionally.
	previewRaw := rawBody(t, srv, "POST", pluginsPath+"/preview", pluginPkg(newPluginName(t), "1.0.0"), admin)
	if strings.Contains(previewRaw, `"added":null`) || strings.Contains(previewRaw, `"removed":null`) {
		t.Fatalf("a fresh-install preview marshals added/removed as null, which crashes preview.added.length in the browser: %s", previewRaw)
	}
	if !strings.Contains(previewRaw, `"added":[]`) || !strings.Contains(previewRaw, `"removed":[]`) {
		t.Fatalf("a fresh-install preview does not carry added/removed as empty arrays: %s", previewRaw)
	}
}

// A package that declares a session kind is installed with that kind on the
// record, so ProvidedKinds can read it back. That is the hole the HTTP path
// had: InstallRequest.Kinds existed and the store wrote it, but the upload
// never carried the field through.
func TestInstallPackageDeclaringAKindPersistsIt(t *testing.T) {
	srv, _, plugins, admin, _ := pluginServer(t)
	name := newPluginName(t)
	kind := fmt.Sprintf("board-%d", time.Now().UnixNano())
	pkg := pluginPkgWith(name, "1.0.0", []plugin.KindDef{{
		Kind: kind, Display: "Board",
		Actions: []plugin.ActionDef{{Name: "add-card", Verb: "POST"}},
	}})

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pkg+`}`, admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d: %v", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("the install came back with no id: %v", body)
	}
	got, err := plugins.ProvidedKinds(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != kind || got[0].Display != "Board" {
		t.Fatalf("ProvidedKinds = %#v, want the declared kind %q", got, kind)
	}
	if len(got[0].Actions) != 1 || got[0].Actions[0].Name != "add-card" || got[0].Actions[0].Verb != http.MethodPost {
		t.Fatalf("the persisted actions = %#v, want add-card POST", got[0].Actions)
	}
}

// A kind name the host will not accept is a 400 at install, not a 201 that
// silently drops the declaration — or a 500 that looks like Parley broke.
func TestInstallPackageWithABadKindNameIsRefused(t *testing.T) {
	srv, pool, _, admin, _ := pluginServer(t)
	name := newPluginName(t)
	pkg := pluginPkgWith(name, "1.0.0", []plugin.KindDef{{
		Kind: "NOT_A_KIND", Display: "Broken",
	}})

	resp, body := doJSON(t, srv, "POST", pluginsPath,
		`{"grantsAccepted":true,"package":`+pkg+`}`, admin)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a package with a bad kind name = %d, want 400: %v", resp.StatusCode, body)
	}
	var n int
	if err := pool.QueryRow(context.Background(),
		`select count(*) from plugin_installs where name = $1`, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("the refused package was still installed (%d rows)", n)
	}
}

/* ------------------------------------------------------------- helpers -- */

// rawBody performs the request and hands back the response body exactly as
// the wire carried it, unparsed — the thing a browser's JSON.parse actually
// sees, as opposed to a Go map that cannot distinguish an absent key from an
// explicit null.
func rawBody(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie) string {
	t.Helper()
	var rd io.Reader = strings.NewReader(body)
	req, err := http.NewRequest(method, srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode >= 300 {
		t.Fatalf("%s %s = %d: %s", method, path, resp.StatusCode, b)
	}
	return string(b)
}

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
