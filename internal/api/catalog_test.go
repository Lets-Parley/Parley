package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/bundle"
)

func packBundle(t *testing.T, priv ed25519.PrivateKey, name, version string) []byte {
	t.Helper()
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(fmt.Sprintf(`{"name":%q,"version":%q,"capabilities":[{"capability":"log"}],"settings":{"type":"object"}}`, name, version)), priv)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func uploadBundle(t *testing.T, srv *httptest.Server, data []byte, cookie *http.Cookie) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+bundleUploadPath, bytes.NewReader(data))
	req.Header.Set("Content-Type", bundleContentType)
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(cookie)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func catalogServer(t *testing.T) (*httptest.Server, *pgxpool.Pool, ed25519.PrivateKey) {
	t.Helper()
	pool := testPool(t)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin,
		PluginBundles: &plugin.BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pub}}})
	return srv, pool, priv
}

func TestOnlyADefaultOrgAdminCanUploadABundle(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	name := "cat" + randomKindSuffix(t)
	data := packBundle(t, priv, name, "1.0.0")

	member := signup(t, srv, "Member")
	if code, body := uploadBundle(t, srv, data, member); code != http.StatusForbidden {
		t.Fatalf("an ordinary member: got %d %s, want 403", code, body)
	}

	// An admin of another org, and of no role in the default one.
	other, otherID := signupWithID(t, srv, "Other Admin")
	org2 := newOrgRow(t, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "delete from org_members where user_id = $1", otherID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')", org2, otherID); err != nil {
		t.Fatal(err)
	}
	if code, body := uploadBundle(t, srv, data, other); code != http.StatusForbidden {
		t.Fatalf("another org's admin: got %d %s, want 403", code, body)
	}

	curator, curatorID := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, curatorID)
	code, body := uploadBundle(t, srv, data, curator)
	if code != http.StatusCreated || !strings.Contains(body, `"name":"`+name+`"`) {
		t.Fatalf("the curator: got %d %s, want 201 naming %s", code, body, name)
	}
	var n int
	if err := pool.QueryRow(ctx, "select count(*) from org_audit_log where action = 'plugin.catalog.upload' and detail like $1", name+"%").Scan(&n); err != nil || n != 1 {
		t.Fatalf("upload audit rows: %d (%v), want 1", n, err)
	}

	// The same bytes again are not a conflict; a different bundle is.
	if code, _ := uploadBundle(t, srv, data, curator); code != http.StatusOK {
		t.Fatalf("re-upload of the same bundle: got %d, want 200", code)
	}
	_, priv2, _ := ed25519.GenerateKey(rand.Reader)
	if code, _ := uploadBundle(t, srv, packBundle(t, priv, name, "1.0.0")[:20], curator); code != http.StatusBadRequest {
		t.Fatalf("a truncated bundle: got %d, want 400", code)
	}
	if code, body := uploadBundle(t, srv, packBundle(t, priv2, name, "1.0.0"), curator); code != http.StatusUnprocessableEntity || strings.Contains(body, "/") {
		t.Fatalf("an untrusted signer: got %d %s, want 422 with a generic message", code, body)
	}
	if err := pool.QueryRow(ctx, "select count(*) from org_audit_log where action = 'plugin.catalog.refused' and actor_id = $1", curatorID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("refusal audit rows: %d (%v), want 1", n, err)
	}

	// The other org's admin still browses it.
	resp, got := doJSON(t, srv, "GET", "/api/catalog", "", other)
	if resp.StatusCode != http.StatusOK || got["can_upload"] != false || !strings.Contains(fmt.Sprint(got["plugins"]), name) {
		t.Fatalf("browse as another org's admin: %d %v", resp.StatusCode, got)
	}
}

func TestAConflictingBundleIs409(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	name := "cat" + randomKindSuffix(t)
	if code, _ := uploadBundle(t, srv, packBundle(t, priv, name, "1.0.0"), curator); code != http.StatusCreated {
		t.Fatalf("first upload: %d", code)
	}
	if code, body := uploadBundle(t, srv, packBundle(t, priv, name, "1.0.0"), curator); code != http.StatusOK || !strings.Contains(body, `"version":"1.0.0"`) {
		t.Fatalf("an identical re-upload: got %d %s, want 200 with the projection", code, body)
	}
	other, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm2")},
		[]byte(fmt.Sprintf(`{"name":%q,"version":"1.0.0"}`, name)), priv)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := uploadBundle(t, srv, other, curator); code != http.StatusConflict {
		t.Fatalf("a second bundle for the same name and version: got %d %s, want 409", code, body)
	}
}

// The exemption is the exact type on the exact route: anything else on that
// route is still held to JSON, and the type is not honoured anywhere else.
func TestTheBundleTypeIsExemptOnlyOnTheUploadRoute(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	data := packBundle(t, priv, "cat"+randomKindSuffix(t), "1.0.0")
	for _, c := range []struct{ path, ct string }{
		{"/api/catalog/bundles", "application/octet-stream"},
		{"/api/catalog/bundles/", bundleContentType},
		{"/api/spaces", bundleContentType},
	} {
		req, _ := http.NewRequest("POST", srv.URL+c.path, bytes.NewReader(data))
		req.Header.Set("Content-Type", c.ct)
		req.Header.Set("Origin", testOrigin)
		req.AddCookie(curator)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("POST %s as %s: got %d, want 415", c.path, c.ct, resp.StatusCode)
		}
	}
	// A body past the JSON cap reaches the handler on the upload route.
	big := make([]byte, 200<<10)
	if code, _ := uploadBundle(t, srv, big, curator); code != http.StatusBadRequest {
		t.Fatalf("a 200 KiB non-bundle: got %d, want 400 from verification", code)
	}
	if code, _ := uploadBundle(t, srv, make([]byte, bundle.MaxUpload+1), curator); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a body past MaxUpload: got %d, want 413", code)
	}
}

func TestTheCatalogNeedsAnOrgMembership(t *testing.T) {
	srv, pool, _ := catalogServer(t)
	loner, id := signupWithID(t, srv, "Loner")
	if _, err := pool.Exec(context.Background(), "update org_members set revoked_at = now() where user_id = $1", id); err != nil {
		t.Fatal(err)
	}
	if resp, _ := doJSON(t, srv, "GET", "/api/catalog", "", loner); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no membership: got %d, want 403", resp.StatusCode)
	}
}

// Gotcha 26b's pattern: the response is read as raw JSON and every key is
// checked against the allow-list, so a handler that grew a field fails here.
func TestTheCatalogProjectionIsAllowListed(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	name := "cat" + randomKindSuffix(t)
	if code, body := uploadBundle(t, srv, packBundle(t, priv, name, "1.0.0"), curator); code != http.StatusCreated {
		t.Fatalf("upload: %d %s", code, body)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/catalog", nil)
	req.AddCookie(curator)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{
		"can_upload": true, "plugins": true, "name": true, "versions": true, "version": true,
		"digest": true, "key_id": true, "grants": true, "settings": true,
		"capability": true, "scope": true, "permits": true, "allows": true, "refuses": true,
		"published_at": true, "provides": true,
	}
	var walk func(v any, under string)
	walk = func(v any, under string) {
		switch v := v.(type) {
		case map[string]any:
			for k, child := range v {
				if !allowed[k] {
					t.Errorf("key %q is not in the catalog allow-list", k)
				}
				if k != "settings" { // the plugin's own schema, not ours
					walk(child, k)
				}
			}
		case []any:
			for _, child := range v {
				walk(child, under)
			}
		}
	}
	walk(raw, "")
	if !strings.Contains(fmt.Sprint(raw), "published_at") || !strings.Contains(fmt.Sprint(raw), "provides") {
		t.Fatalf("a version names no publish date or kinds: %v", raw)
	}
	if !strings.Contains(fmt.Sprint(raw), "Can write lines into this server's log") {
		t.Fatalf("capability copy missing: %v", raw)
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n += k
	return k, err
}

// An anonymous upload is refused before its body is buffered past the JSON
// cap: the larger read happens only behind the curator gate.
func TestAnAnonymousUploadIsNotBufferedPastTheJSONCap(t *testing.T) {
	srv, _, _ := catalogServer(t)
	body := &countingReader{r: bytes.NewReader(make([]byte, 1<<20))}
	req := httptest.NewRequest("POST", bundleUploadPath, body)
	req.Header.Set("Content-Type", bundleContentType)
	req.Header.Set("Origin", testOrigin)
	rec := httptest.NewRecorder()
	srv.Config.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("anonymous upload: got %d, want 401 or 413", rec.Code)
	}
	if body.n > httprequest.MaxJSONBody+1 {
		t.Fatalf("anonymous upload: %d bytes read, want at most the JSON cap", body.n)
	}
}

func TestABundleWithNoVersionIs400(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(`{"name":"cat`+randomKindSuffix(t)+`"}`), priv)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := uploadBundle(t, srv, data, curator); code != http.StatusBadRequest {
		t.Fatalf("a manifest with no version: got %d %s, want 400", code, body)
	}
}
