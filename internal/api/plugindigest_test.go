package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
// is one.
func TestALegacyPackageResolvesToTheStoredBundle(t *testing.T) {
	f := digestServer(t)
	name := newPluginName(t)
	f.store(t, name, "1.0.0", `[{"capability":"log"}]`)
	code, view := f.post(t, "", `{"grantsAccepted":true,"package":`+pluginPkg(name, "1.0.0")+`}`)
	if code != http.StatusCreated || pinnedDigest(view) == "" {
		t.Fatalf("legacy install = %d %v, want it pinned to the stored bundle", code, view)
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

// /readyz?verbose names what this pod has loaded, by digest.
func TestReadyzVerboseListsTheLoadedBundles(t *testing.T) {
	pool := testPool(t)
	store := &plugin.Store{Pool: pool}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: store, PluginHost: plugin.NewHost(store, plugin.HostConfig{})})
	waitReady(t, srv, true, 10*time.Second)
	resp, err := srv.Client().Get(srv.URL + "/readyz?verbose")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "plugin bundles loaded on this pod:") {
		t.Fatalf("readyz verbose = %q", body)
	}
}
