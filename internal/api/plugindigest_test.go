package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/bundle"
)

type digestFixture struct {
	srv    *httptest.Server
	pool   *pgxpool.Pool
	admin  *http.Cookie
	id     string
	priv   ed25519.PrivateKey
	bundle *plugin.BundleStore
}

func digestServer(t *testing.T) digestFixture {
	t.Helper()
	pool := testPool(t)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bs := &plugin.BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pub}}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: &plugin.Store{Pool: pool}, PluginBundles: bs})
	admin, adminID := signupWithID(t, srv, "Operator")
	makeOrgAdmin(t, pool, adminID)
	return digestFixture{srv: srv, pool: pool, admin: admin, id: adminID, priv: priv, bundle: bs}
}

// store puts a signed bundle in the catalogue and returns its choice body.
func (f digestFixture) store(t *testing.T, name, version, caps string) string {
	t.Helper()
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(fmt.Sprintf(`{"manifest":1,"kind":"plugin","name":%q,"version":%q,"capabilities":%s}`, name, version, caps)), f.priv)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.bundle.Insert(context.Background(), data, nil)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf(`"digest":%q,"key_id":%q`, b.Digest, b.KeyID)
}

func (f digestFixture) post(t *testing.T, path, body string) (int, map[string]any) {
	t.Helper()
	resp, out := doJSON(t, f.srv, "POST", pluginsPath+path, body, f.admin)
	return resp.StatusCode, out
}

func pinnedDigest(view map[string]any) string {
	b, _ := view["bundle"].(map[string]any)
	d, _ := b["digest"].(string)
	return d
}

func TestInstallFromTheCatalogueUsesTheVerifiedManifest(t *testing.T) {
	f := digestServer(t)
	name := newPluginName(t)
	choice := f.store(t, name, "1.0.0", `[{"capability":"log"}]`)

	if code, _ := f.post(t, "", `{"grantsAccepted":true,"digest":"nope","key_id":""}`); code != http.StatusNotFound {
		t.Fatalf("a digest not in the catalogue = %d, want 404", code)
	}
	code, view := f.post(t, "", `{"grantsAccepted":true,`+choice+`}`)
	if code != http.StatusCreated {
		t.Fatalf("install by digest = %d: %v", code, view)
	}
	if view["version"] != "1.0.0" || pinnedDigest(view) == "" || view["inCatalogue"] != true {
		t.Fatalf("install is not pinned to the catalogue bundle: %v", view)
	}
	if grants, _ := view["grants"].([]any); len(grants) != 1 {
		t.Fatalf("grants = %v, want the manifest's one", view["grants"])
	}
}

// The deprecated package.json path resolves to the stored bundle when there
// is one, but only the bundle that was previewed: consent is bound to a digest.
func TestALegacyPackageResolvesToThePreviewedStoredBundle(t *testing.T) {
	f := digestServer(t)
	name := newPluginName(t)
	f.store(t, name, "1.0.0", `[{"capability":"log"}]`)
	pkg := pluginPkg(name, "1.0.0")
	code, preview := f.post(t, "/preview", pkg)
	digest := pinnedDigest(preview)
	if code != http.StatusOK || digest == "" {
		t.Fatalf("preview = %d %v, want it to name the stored bundle", code, preview)
	}
	if code, _ := f.post(t, "", `{"grantsAccepted":true,"package":`+pkg+`}`); code != http.StatusConflict {
		t.Fatalf("an alias install with no previewed digest = %d, want 409", code)
	}
	code, view := f.post(t, "", `{"grantsAccepted":true,"previewedDigest":"`+digest+`","package":`+pkg+`}`)
	if code != http.StatusCreated || pinnedDigest(view) != digest {
		t.Fatalf("legacy install = %d %v, want it pinned to the previewed bundle", code, view)
	}
	// Pinned now: an alias upgrade with no stored bundle must not unpin it.
	if code, _ := f.post(t, "", `{"grantsAccepted":true,"package":`+pluginPkg(name, "1.1.0")+`}`); code != http.StatusConflict {
		t.Fatalf("an alias upgrade of a pinned install to an unstored version = %d, want 409", code)
	}
	var got string
	if err := f.pool.QueryRow(context.Background(), `select bundle_digest from plugin_installs where id = $1`, view["id"]).Scan(&got); err != nil || got != digest {
		t.Fatalf("pin = %q %v, want %s unchanged", got, err, digest)
	}
}

func TestRollbackReturnsOnlyToABundleTheInstallRan(t *testing.T) {
	f := digestServer(t)
	name := newPluginName(t)
	v1 := f.store(t, name, "1.0.0", `[{"capability":"log"},{"capability":"kv"}]`)
	v2 := f.store(t, name, "2.0.0", `[{"capability":"log"}]`)
	v3 := f.store(t, name, "3.0.0", `[{"capability":"log"}]`)

	_, view := f.post(t, "", `{"grantsAccepted":true,`+v1+`}`)
	id, _ := view["id"].(string)
	first := pinnedDigest(view)
	if code, view := f.post(t, "", `{"grantsAccepted":true,`+v2+`}`); code != http.StatusOK || view["version"] != "2.0.0" {
		t.Fatalf("narrowing upgrade = %d %v", code, view)
	}
	if code, _ := f.post(t, "", `{"grantsAccepted":true,`+v1+`}`); code != http.StatusConflict {
		t.Fatalf("a downgrade through install = %d, want 409", code)
	}
	if code, _ := f.post(t, "/"+id+"/rollback", `{`+v3+`}`); code != http.StatusConflict {
		t.Fatalf("rollback to a bundle it never ran = %d, want 409", code)
	}
	// v1 asks for kv, which v2 gave up: the rollback widens and waits.
	code, view := f.post(t, "/"+id+"/rollback", `{`+v1+`}`)
	if code != http.StatusAccepted || view["version"] != "2.0.0" {
		t.Fatalf("widening rollback = %d %v, want 202 and still 2.0.0", code, view)
	}
	assertAudited(t, f.pool, "plugin.rollback_requested", f.id)
	if code, view = f.post(t, "/"+id+"/upgrade", `{"approve":true}`); code != http.StatusOK ||
		view["version"] != "1.0.0" || pinnedDigest(view) != first {
		t.Fatalf("approving the rollback = %d %v, want 1.0.0 pinned to %s", code, view, first)
	}
	if hist, _ := view["history"].([]any); len(hist) != 2 {
		t.Fatalf("history = %v, want the two bundles it ran", view["history"])
	}
}

// Which bundles a pod has loaded is for curators, never the public /readyz.
func TestLoadedBundlesAreForCuratorsOnly(t *testing.T) {
	pool := testPool(t)
	store := &plugin.Store{Pool: pool}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: store, PluginHost: plugin.NewHost(store, plugin.HostConfig{})})
	member := signup(t, srv, "Member")
	if resp, _ := doJSON(t, srv, "GET", "/api/catalogue/loaded", "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a member = %d, want 403", resp.StatusCode)
	}
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	resp, body := doJSON(t, srv, "GET", "/api/catalogue/loaded", "", curator)
	if _, ok := body["loaded"].([]any); resp.StatusCode != http.StatusOK || !ok {
		t.Fatalf("a curator = %d %v, want 200 and a loaded list", resp.StatusCode, body)
	}
}

// A pinned install never gets UI from a loose file: not in the panel list, and
// not from the public frame route.
func TestAPinnedInstallGetsNoLooseUI(t *testing.T) {
	dir := t.TempDir()
	name := newPluginName(t)
	if err := os.WriteFile(filepath.Join(dir, name+"-1.0.0.ui.js"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	data, _ := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(fmt.Sprintf(`{"name":%q,"version":"0.9.0"}`, name)), priv)
	b, err := (&plugin.BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pub}}).Insert(context.Background(), data, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`insert into plugin_installs (org_id, name, version, enabled, kv_quota_bytes, bundle_digest, bundle_key_id)
		 values ($1, $2, '1.0.0', true, 1024, $3, $4)`, defaultOrgID(t, pool), name, b.Digest, b.KeyID); err != nil {
		t.Fatal(err)
	}
	if resp, body := get(t, srv, "/plugin-ui/"+name+"/1.0.0"); resp.StatusCode == http.StatusOK && strings.Contains(body, "parleyBridgeReady") && body != "" {
		t.Fatalf("the frame route served a loose ui.js for a pinned install: %.300s", body)
	}
	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	if names := readPanels(t, srv, newPokerSession(t, srv, dana), dana); contains(names, name) {
		t.Fatalf("a pinned install was listed from a loose ui.js: %v", names)
	}
}
