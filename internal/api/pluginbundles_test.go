package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/bundle"
)

// The frame and the panel list read the same source as the host: a stored
// bundle outranks a file of the same name and version on disk.
func TestAStoredBundleIsServedOverTheDirectory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := "stored" + randomSlugSuffix(t)
	dir := t.TempDir()
	for file, body := range map[string]string{".ui.js": "//from-disk", ".slots.json": `["panel"]`} {
		if err := os.WriteFile(filepath.Join(dir, name+"-1.0.0"+file), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	data, err := bundle.Pack(map[string][]byte{
		"plugin.wasm": []byte("\x00asm"),
		"ui.js":       []byte("//from-table"),
		"slots.json":  []byte(`["room"]`),
	}, []byte(fmt.Sprintf(`{"name":%q,"version":"1.0.0"}`, name)), priv)
	if err != nil {
		t.Fatal(err)
	}
	bundles := &plugin.BundleStore{Pool: pool, Dir: dir, Trusted: []ed25519.PublicKey{pub}}
	if _, err := bundles.Insert(ctx, data, nil); err != nil {
		t.Fatal(err)
	}
	installPlugin(t, pool, name, true)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginBundles: bundles})

	resp, body := get(t, srv, "/plugin-ui/"+name+"/1.0.0")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "//from-table") {
		t.Fatalf("frame: got %d, want the stored ui.js (body %q)", resp.StatusCode, body)
	}

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)
	req, _ := http.NewRequest("GET", srv.URL+panelsPath(sess), nil)
	req.AddCookie(dana)
	presp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer presp.Body.Close()
	var got bytes.Buffer
	got.ReadFrom(presp.Body)
	if want := fmt.Sprintf(`"name":%q`, name); !strings.Contains(got.String(), want) || !strings.Contains(got.String(), `"slots":["room"]`) {
		t.Fatalf("panels: want %s with the stored slots [\"room\"], got %s", want, got.String())
	}
}
