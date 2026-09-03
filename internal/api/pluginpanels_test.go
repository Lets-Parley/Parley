package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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
