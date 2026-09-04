package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

// panelsPath is where a room asks what plugin UI it should show. It is scoped
// to the room because the room is what fixes the org: a link guest holds no
// org membership to resolve one from, and the panel list is tenant metadata.
func panelsPath(sessionID string) string {
	return "/api/sessions/" + sessionID + "/plugins/panels"
}

// readPanels asks for a room's panels and returns their names.
func readPanels(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) []string {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+panelsPath(sessionID), nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: got %d, want 200", panelsPath(sessionID), resp.StatusCode)
	}
	var panels []panel
	if err := json.NewDecoder(resp.Body).Decode(&panels); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, p := range panels {
		names = append(names, p.Name)
	}
	return names
}

func contains(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// The panel list names which plugins an org has installed and what each one
// was granted. That a grant is re-checked at the effect makes the *grant* safe
// to disclose; it says nothing about the enumeration. Which plugins another
// tenant runs is that tenant's metadata, and this route is open to a link
// guest — the least-trusted identity the product mints — so an unscoped query
// hands every org's install list to anyone with a link to any room.
func TestPluginPanelsAreScopedToTheRoomsOwnOrg(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"ours-1.0.0.ui.js", "theirs-1.0.0.ui.js"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("//"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	ctx := context.Background()

	// Org B: a second tenant this room's people have never heard of.
	otherSlug := "other-" + randomSlugSuffix(t)
	var otherOrg string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id",
		otherSlug).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "delete from orgs where id = $1", otherOrg) })

	installPlugin(t, pool, "ours", true)
	installPluginInOrg(t, pool, otherOrg, "theirs", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	// A member of the room's own org.
	names := readPanels(t, srv, sess, dana)
	if !contains(names, "ours") {
		t.Fatalf("the room's own org's panel is missing: %v", names)
	}
	if contains(names, "theirs") {
		t.Fatalf("another org's install was enumerated to a member of this org: %v", names)
	}

	// And a link guest — no org membership at all, and the identity this route
	// is deliberately open to.
	guest, _ := standupLinkGuest(t, srv, sess, "Gus", dana)
	names = readPanels(t, srv, sess, guest)
	if !contains(names, "ours") {
		t.Fatalf("a guest of the room cannot see its own org's panel: %v", names)
	}
	if contains(names, "theirs") {
		t.Fatalf("a link guest enumerated another org's installs: %v", names)
	}
}

// The list is a read on a room, so it is behind the room's own gate: a
// stranger to the space is told nothing, the same 404 every other route on
// /sessions/{id} gives them.
func TestPluginPanelsAreRefusedToAStrangerToTheRoom(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ours-1.0.0.ui.js"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "ours", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)
	mallory := signup(t, srv, "Mallory")

	req, _ := http.NewRequest("GET", srv.URL+panelsPath(sess), nil)
	req.AddCookie(mallory)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a stranger reading a room's panels: got %d, want 404", resp.StatusCode)
	}
}

func writePluginUI(t *testing.T, dir, name, version string, slots []string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+"-"+version+".ui.js"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	if slots == nil {
		return
	}
	body, err := json.Marshal(slots)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+"-"+version+".slots.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readPanelRows(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) []panel {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+panelsPath(sessionID), nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: got %d, want 200", panelsPath(sessionID), resp.StatusCode)
	}
	var panels []panel
	if err := json.NewDecoder(resp.Body).Decode(&panels); err != nil {
		t.Fatal(err)
	}
	return panels
}

func slotsOf(t *testing.T, panels []panel, name string) []string {
	t.Helper()
	for _, p := range panels {
		if p.Name == name {
			return p.Slots
		}
	}
	t.Fatalf("plugin %q is missing from the panel list", name)
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A plugin that never declared a chrome slot is not listed in that chrome.
// The nested panel is the historical default when nothing is declared at all.
func TestPluginPanelsCarryDeclaredChromeSlots(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "toolbar-only", "1.0.0", []string{"toolbar"})
	writePluginUI(t, dir, "silent", "1.0.0", []string{})
	writePluginUI(t, dir, "legacy", "1.0.0", nil)

	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "toolbar-only", true)
	installPlugin(t, pool, "silent", true)
	installPlugin(t, pool, "legacy", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	rows := readPanelRows(t, srv, sess, dana)
	if got := slotsOf(t, rows, "toolbar-only"); !equalStrings(got, []string{"toolbar"}) {
		t.Fatalf("toolbar-only slots = %v, want [toolbar]", got)
	}
	if contains(readPanels(t, srv, sess, dana), "silent") {
		t.Fatalf("a plugin that declared no slots was listed: %v", rows)
	}
	if got := slotsOf(t, rows, "legacy"); !equalStrings(got, []string{"panel"}) {
		t.Fatalf("an undeclared UI bundle should still be a nested panel: %v", got)
	}
}

// A sidecar that names chrome the host does not have — notifications, or
// anything else — must not leak that name into the room. Dropping it here is
// what keeps an unknown slot out of the toolbar, not a later filter.
func TestPluginPanelsDropUnknownChromeSlots(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "noisy", "1.0.0", []string{"toolbar", "notifications", "panel"})

	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "noisy", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	got := slotsOf(t, readPanelRows(t, srv, sess, dana), "noisy")
	if !equalStrings(got, []string{"toolbar", "panel"}) {
		t.Fatalf("slots = %v, want [toolbar panel]", got)
	}
	if contains(got, "notifications") {
		t.Fatalf("unknown chrome slot leaked into the room: %v", got)
	}
}

func TestGuestChromeSlotsOmitNavAndExportWhenTheKindCannot(t *testing.T) {
	slots := []string{"panel", "toolbar", "nav", "export-menu"}
	got := filterChromeSlots(slots, true, true)
	if !equalStrings(got, []string{"panel", "toolbar", "export-menu"}) {
		t.Fatalf("a guest in an exporting room: %v", got)
	}
	got = filterChromeSlots(slots, true, false)
	if !equalStrings(got, []string{"panel", "toolbar"}) {
		t.Fatalf("a guest in a room with no export: %v", got)
	}
	got = filterChromeSlots(slots, false, true)
	if !equalStrings(got, slots) {
		t.Fatalf("a member should see every declared slot: %v", got)
	}
}

func TestLinkGuestPluginPanelsOmitNavAndKeepExportOnAPokerRoom(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "chrome", "1.0.0", []string{"nav", "export-menu", "toolbar"})

	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "chrome", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)
	guest, _ := standupLinkGuest(t, srv, sess, "Gus", dana)

	got := slotsOf(t, readPanelRows(t, srv, sess, guest), "chrome")
	if contains(got, "nav") {
		t.Fatalf("a link guest was offered org/space nav chrome: %v", got)
	}
	if !contains(got, "export-menu") {
		t.Fatalf("a link guest in a poker room lost the export-menu slot: %v", got)
	}
	if !contains(got, "toolbar") {
		t.Fatalf("a link guest lost the toolbar slot: %v", got)
	}
}

// Poker and standup both export, so a guest HTTP test on those kinds cannot
// tell kindHasExport from "always true". A plugin-provided kind with no CSV
// is the wiring: export-menu must not appear, toolbar must.
func TestLinkGuestPluginPanelsOmitExportMenuWhenTheKindHasNoCSV(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "chrome", "1.0.0", []string{"export-menu", "toolbar"})

	pool := testPool(t)
	plugins := &plugin.Store{Pool: pool}
	host := plugin.NewHost(plugins, plugin.HostConfig{})
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: testOrigin,
		PluginDir:     dir,
		Plugins:       plugins,
		PluginHost:    host,
	})

	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, defaultOrg(t, pool), plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any {
		return map[string]any{}
	})
	installPlugin(t, pool, "chrome", true)

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "No Export Space", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a plugin-kind room: %d %v", resp.StatusCode, body)
	}
	sess := body["id"].(string)
	guest, _ := standupLinkGuest(t, srv, sess, "Gus", fac)

	got := slotsOf(t, readPanelRows(t, srv, sess, guest), "chrome")
	if contains(got, "export-menu") {
		t.Fatalf("a link guest was offered export-menu on a kind with no CSV: %v", got)
	}
	if !contains(got, "toolbar") {
		t.Fatalf("a link guest lost the toolbar slot: %v", got)
	}
}

func TestOrgPluginPanelsAreRefusedToALinkGuest(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "navvy", "1.0.0", []string{"nav"})
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "navvy", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)
	guest, _ := standupLinkGuest(t, srv, sess, "Gus", dana)

	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/default/plugins/panels", nil)
	req.AddCookie(guest)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a link guest reading org plugin chrome: got %d, want 401", resp.StatusCode)
	}
}

func TestOrgPluginPanelsListOnlyNavSlotsForAMember(t *testing.T) {
	dir := t.TempDir()
	writePluginUI(t, dir, "navvy", "1.0.0", []string{"nav", "toolbar"})
	writePluginUI(t, dir, "roomy", "1.0.0", []string{"panel"})
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	installPlugin(t, pool, "navvy", true)
	installPlugin(t, pool, "roomy", true)

	dana := signup(t, srv, "Dana")
	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/default/plugins/panels", nil)
	req.AddCookie(dana)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET org plugin chrome: got %d, want 200", resp.StatusCode)
	}
	var panels []panel
	if err := json.NewDecoder(resp.Body).Decode(&panels); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, p := range panels {
		names = append(names, p.Name)
		if p.Name == "navvy" && !equalStrings(p.Slots, []string{"nav"}) {
			t.Fatalf("org chrome for navvy = %v, want [nav] only", p.Slots)
		}
	}
	if !contains(names, "navvy") {
		t.Fatalf("the org nav plugin is missing: %v", names)
	}
	if contains(names, "roomy") {
		t.Fatalf("a panel-only plugin was listed on org nav chrome: %v", names)
	}
}
