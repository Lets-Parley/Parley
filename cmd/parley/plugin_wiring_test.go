package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
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

// MetricsEnabled is the same class of wire PluginDir was: every handler test
// can set api.Options itself and pass, while main's mapping leaves the field
// false and the binary serves no /metrics. Drive the real apiOptions path.
func TestMainsOptionsMountMetrics(t *testing.T) {
	base, _ := url.Parse("http://example.test")
	cfg := config{
		BaseURL:        base,
		AuthMode:       api.ModeOpen,
		MetricsEnabled: true,
	}
	opts := apiOptions(t.Context(), cfg, false, nil, nil)
	handler := api.Router(nil, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics through apiOptions: got %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), "parley_ws_connections") {
		t.Fatal("apiOptions did not mount the Prometheus exposition")
	}
}

// EmbedProviders is another feature gate: absent from the mapping, every
// embed route answers 404 in the binary however the operator configured it.
func TestMainsOptionsEnableEmbedProviders(t *testing.T) {
	base, _ := url.Parse("https://example.test")
	providers, err := api.ParseEmbedProviders("meet", "123456789012")
	if err != nil {
		t.Fatal(err)
	}
	opts := apiOptions(t.Context(), config{BaseURL: base, AuthMode: api.ModeOpen, EmbedProviders: providers}, true, nil, nil)
	handler := api.Router(nil, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})
	resp, err := srv.Client().Get(srv.URL + "/api/auth")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"name":"meet"`) {
		t.Fatalf("GET /api/auth through apiOptions does not list meet: %s", body)
	}
}

// The share card's canonical and og:url are only as good as the address the
// operator configured: absolute when BASE_URL was set, absent when it was not,
// never the localhost default dressed up as a public address.
func TestMainsOptionsPutTheBaseURLInTheShell(t *testing.T) {
	shell := func(t *testing.T, cfg config, path string) string {
		t.Helper()
		handler := api.Router(nil, apiOptions(t.Context(), cfg, true, nil, nil))
		srv := httptest.NewServer(handler)
		t.Cleanup(func() {
			handler.Shutdown()
			srv.Close()
		})
		resp, err := srv.Client().Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !strings.Contains(string(body), `<div id="root">`) {
			t.Fatalf("did not get the app shell: %s", body)
		}
		return string(body)
	}

	base, _ := url.Parse("https://parley.example.test/")
	set := shell(t, config{BaseURL: base, BaseURLSet: true, AuthMode: api.ModeOpen}, "/o/acme/s/platform?secret=1")
	for _, want := range []string{
		`<link rel="canonical" href="https://parley.example.test/o/acme/s/platform"`,
		`<meta property="og:url" content="https://parley.example.test/o/acme/s/platform"`,
		`<meta property="og:image" content="https://parley.example.test/og.png"`,
		`<meta property="og:image:width" content="1200"`,
		`<meta property="og:image:height" content="630"`,
		`<meta property="og:image:alt" content=`,
		`<meta name="twitter:image" content="https://parley.example.test/og.png"`,
		`<meta name="twitter:card" content="summary_large_image"`,
	} {
		if !strings.Contains(set, want) {
			t.Errorf("shell with BASE_URL set lacks %s", want)
		}
	}
	if strings.Contains(set, "secret") {
		t.Error("shell reflects the query string")
	}

	def, _ := url.Parse("http://localhost:8080")
	unset := shell(t, config{BaseURL: def, AuthMode: api.ModeOpen}, "/some/client/route")
	for _, bad := range []string{`rel="canonical"`, `og:url`, `localhost:8080`, `og:image`, `twitter:image`, `summary_large_image`} {
		if strings.Contains(unset, bad) {
			t.Errorf("shell with BASE_URL unset contains %s", bad)
		}
	}
	if !strings.Contains(unset, `<meta name="twitter:card" content="summary"`) {
		t.Error("shell with BASE_URL unset lost its summary twitter card")
	}
}

// The og:image the shell names has to be a file the binary actually serves,
// or every share card points at the SPA shell instead of a picture.
func TestMainsOptionsServeTheShareImage(t *testing.T) {
	base, _ := url.Parse("https://parley.example.test/")
	handler := api.Router(nil, apiOptions(t.Context(), config{BaseURL: base, BaseURLSet: true, AuthMode: api.ModeOpen}, true, nil, nil))
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})
	resp, err := srv.Client().Get(srv.URL + "/og.png")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("GET /og.png = %d %q, want 200 image/png", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if !bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("GET /og.png did not return a PNG")
	}
}

func TestMainsOptionsLeaveMetricsUnmounted(t *testing.T) {
	base, _ := url.Parse("http://example.test")
	cfg := config{BaseURL: base, AuthMode: api.ModeOpen}
	opts := apiOptions(t.Context(), cfg, false, nil, nil)
	handler := api.Router(nil, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK && strings.Contains(string(body), "# HELP") {
		t.Fatal("GET /metrics through apiOptions with MetricsEnabled unset returned a Prometheus exposition")
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
		BaseURL:    base,
		BaseURLSet: true,
		AuthMode:   api.ModeOIDC,
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
			WSMaxPerToken: 1,
		},
		SessionIdleTTL:      time.Hour,
		SessionMaxTTL:       time.Hour,
		PluginDir:           t.TempDir(),
		MetricsEnabled:      true,
		StandupWebhookHosts: []string{"hooks.example.test"},
		EmbedProviders:      []api.EmbedProvider{{Name: "meet"}},
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

// A normal boot must leave a legacy secret exactly as it was: during a rolling
// deploy an older replica can still only open that form.
func TestBootLeavesALegacySecretInItsLegacyForm(t *testing.T) {
	pool := migratedPool(t)
	ctx := context.Background()
	seedPluginInstall(t, pool, "legacy-secret")
	var installID string
	if err := pool.QueryRow(ctx, "select id::text from plugin_installs where name = 'legacy-secret'").Scan(&installID); err != nil {
		t.Fatal(err)
	}
	// Sealed the way a pre-0048 binary did: the previous key, no additional data.
	prevKey, _ := base64.StdEncoding.DecodeString("ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=")
	block, _ := aes.NewCipher(prevKey)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	legacy := gcm.Seal(nil, nonce, []byte("hunter2"), nil)
	if _, err := pool.Exec(ctx, `insert into plugin_secrets (install_id, name, nonce, ciphertext) values ($1, 'token', $2, $3)`, installID, nonce, legacy); err != nil {
		t.Fatal(err)
	}
	cfg := config{PluginSecretKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", PluginSecretKeyPrevious: "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="}
	if _, err := pluginSecrets(ctx, pool, cfg, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	var keyID *string
	var ct []byte
	if err := pool.QueryRow(ctx, "select key_id, ciphertext from plugin_secrets where install_id = $1", installID).Scan(&keyID, &ct); err != nil {
		t.Fatal(err)
	}
	if keyID != nil || !bytes.Equal(ct, legacy) {
		t.Fatalf("boot rewrote a legacy secret: key_id=%v ciphertext=%x", keyID, ct)
	}
}
