package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/api"
	"github.com/lets-parley/parley/internal/auth"
	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

// The plugin UI shipped dead once: every handler test built api.Options itself
// with a PluginDir set, so the frame route and the panel list were exercised
// with a directory and passed, while main's own literal never set the field
// and both took their empty-directory early return in the real binary. A test
// that asserts the field round-trips through a struct is the same shape that
// already passed. This one starts from main's configuration path — the parsed
// config, through apiOptions, into a real router — and asks the two questions
// the operator asked: does the frame serve a bundle, and does the room list a
// panel.
func TestMainsOptionsServeThePluginUI(t *testing.T) {
	dir := t.TempDir()
	name := "wiring" + strings.ReplaceAll(t.Name(), "/", "")
	if err := os.WriteFile(filepath.Join(dir, name+"-1.0.0.ui.js"), []byte("//ui"), 0o600); err != nil {
		t.Fatal(err)
	}

	pool := migratedPool(t)
	seedPluginInstall(t, pool, name)

	// The config main would have parsed with PLUGIN_DIR set.
	base, _ := url.Parse("http://example.test")
	cfg := config{
		BaseURL:   base,
		AuthMode:  api.ModeOpen,
		PluginDir: dir,
	}
	opts := apiOptions(t.Context(), cfg, false, nil, nil)

	handler := api.Router(pool, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := srv.Client()
	client.Jar = jar

	// The frame route: the sandbox document a room embeds.
	resp, err := client.Get(srv.URL + "/plugin-ui/" + name + "/1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /plugin-ui/%s/1.0.0: got %d, want 200 — the app main builds serves no plugin UI", name, resp.StatusCode)
	}
	if !strings.Contains(string(body), "//ui") {
		t.Fatalf("the frame did not carry the installed bundle: %s", body)
	}

	// And the panel list, from inside a room, which is the other half of the
	// feature and the other reader of the same field.
	sessionID := openRoom(t, client, srv.URL)
	panels := readPanelNames(t, client, srv.URL, sessionID)
	if len(panels) == 0 {
		t.Fatalf("the room listed no plugin panels — the app main builds cannot see the plugin directory")
	}
	found := false
	for _, p := range panels {
		if p == name {
			found = true
		}
	}
	if !found {
		t.Fatalf("the installed plugin is missing from the panel list: %v", panels)
	}

	// Last, and deliberately last: the mapping itself. The two checks above
	// are the ones that fail first when the wire is cut, because they are the
	// symptom an operator sees. This one only names the cause.
	if opts.PluginDir != dir {
		t.Fatalf("apiOptions dropped PluginDir: got %q, want %q", opts.PluginDir, dir)
	}
}

// migratedPool hands back a pool against a migrated test database.
func migratedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := db.Migrate(context.Background(), pool, log, db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

// seedPluginInstall records an enabled install of name in the default org,
// with the grant the panel list reports.
func seedPluginInstall(t *testing.T, pool *pgxpool.Pool, name string) {
	t.Helper()
	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx, "select id from orgs where slug = $1", store.DefaultOrgSlug).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	var installID string
	if err := pool.QueryRow(ctx,
		`insert into plugin_installs (org_id, name, version, enabled, kv_quota_bytes)
		 values ($1, $2, '1.0.0', true, 1024) returning id`, orgID, name).Scan(&installID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into plugin_grants (install_id, capability) values ($1, 'session:read')`, installID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "delete from plugin_installs where id = $1", installID)
	})
}

// openRoom signs someone up, gives them a space and opens a poker room in it,
// which is the context the panel list is scoped to.
func openRoom(t *testing.T, client *http.Client, baseURL string) string {
	t.Helper()
	postJSON(t, client, baseURL+"/api/me", `{"name":"Wiring Tester"}`, http.StatusCreated)

	spaceName := fmt.Sprintf("Wiring %d", os.Getpid())
	space := postJSON(t, client, baseURL+"/api/spaces", `{"name":"`+spaceName+`"}`, http.StatusCreated)
	slug, _ := space["slug"].(string)
	if slug == "" {
		t.Fatalf("no slug in the created space: %v", space)
	}

	room := postJSON(t, client,
		baseURL+"/api/orgs/default/spaces/"+slug+"/sessions",
		`{"kind":"poker","title":"Wiring","config":{}}`, http.StatusCreated)
	id, _ := room["id"].(string)
	if id == "" {
		t.Fatalf("no id in the created room: %v", room)
	}
	return id
}

func readPanelNames(t *testing.T, client *http.Client, baseURL, sessionID string) []string {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/sessions/" + sessionID + "/plugins/panels")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET panels: got %d, want 200", resp.StatusCode)
	}
	var panels []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&panels); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(panels))
	for _, p := range panels {
		names = append(names, p.Name)
	}
	return names
}

func postJSON(t *testing.T, client *http.Client, url, body string, want int) map[string]any {
	t.Helper()
	req, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != want {
		t.Fatalf("POST %s: got %d, want %d (%v)", url, resp.StatusCode, want, out)
	}
	return out
}

// PluginDir was not special: every exported field of api.Options is a wire
// from configuration to the HTTP layer, and the one that shipped dead was
// simply absent from the literal. Nothing about the type made that visible —
// a missing field is a zero value, and a zero value is a legal struct. This
// enumerates them instead: hand apiOptions a config in which nothing is a
// zero value, and require that nothing survives as one on the far side.
//
// A field that genuinely should default belongs in the exemption list below,
// with the reason. Silence is not an exemption.
func TestEveryOptionMainCanSetIsActuallySet(t *testing.T) {
	// sessionRevalidationInterval is unexported and cannot be reached from
	// here at all — it is a test-only shortening of a hub interval that
	// defaults safely when left zero. reflect still walks it, so it is named.
	exempt := map[string]string{
		"sessionRevalidationInterval": "unexported; a test-only seam with a safe default in the hub",
	}

	base, _ := url.Parse("https://example.test")
	_, cidr, _ := net.ParseCIDR("10.0.0.0/8")
	prefix, _ := netip.ParsePrefix(cidr.String())
	cfg := config{
		BaseURL:  base,
		AuthMode: api.ModeOIDC,
		OIDC: auth.Config{
			Issuer:       "https://idp.example.test",
			ClientID:     "client",
			ClientSecret: "secret",
			RedirectURL:  "https://example.test/auth/callback",
			Scopes:       []string{"profile"},
		},
		BootstrapAdmin:    api.BootstrapAdmin{Issuer: "https://idp.example.test", Subject: "admin"},
		TrustProxy:        true,
		TrustedProxyCIDRs: []netip.Prefix{prefix},
		Limits: api.Limits{
			IdentityIPHourly: 1, IdentityGlobalHourly: 1, LinkRedemptionIPHourly: 1,
			SpacesPerIdentity: 1, SessionsPerSpace: 1, DecksPerSpace: 1,
			KudosPerSpace: 1, StoriesPerSession: 1, LinksPerSession: 1,
		},
		SessionIdleTTL: time.Hour,
		SessionMaxTTL:  time.Hour,
		PluginDir:      t.TempDir(),
	}
	opts := apiOptions(t.Context(), cfg, true, &plugin.Store{}, &plugin.Host{})

	v := reflect.ValueOf(opts)
	for i := 0; i < v.NumField(); i++ {
		field := v.Type().Field(i)
		if _, ok := exempt[field.Name]; ok {
			continue
		}
		if v.Field(i).IsZero() {
			t.Errorf("api.Options.%s is never set by main — a feature gated on it is dead in the shipped binary, "+
				"and no handler test that builds its own Options can tell you that", field.Name)
		}
	}
}
