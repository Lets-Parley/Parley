package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// routeParam matches one chi route parameter, braces included.
var routeParam = regexp.MustCompile(`\{[^}]*\}`)

// pluginFrameServer starts a server whose plugin directory holds one UI
// bundle, so the frame route has something to serve.
func pluginFrameServer(t *testing.T, ui string) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	if ui != "" {
		if err := os.WriteFile(filepath.Join(dir, "demo-1.0.0.ui.js"), []byte(ui), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})
	return srv, dir
}

func get(t *testing.T, srv *httptest.Server, path string) (*http.Response, string) {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return resp, string(body)
}

// The whole sandbox rests on the frame being embeddable. X-Frame-Options: DENY
// has no frame-ancestors counter-directive to lose to, so a plugin frame that
// carries it is blocked by every browser before a single byte of CSP is read.
func TestThePluginFrameIsNotDeniedByXFrameOptions(t *testing.T) {
	srv, _ := pluginFrameServer(t, "window.parley.ready();")

	resp, body := get(t, srv, "/plugin-ui/demo/1.0.0")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("plugin frame: got %d, want 200 (body %q)", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Frame-Options"); got != "" {
		t.Fatalf("the plugin frame carries X-Frame-Options: %q — no browser will render it", got)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	for _, directive := range []string{
		"default-src 'none'",
		"connect-src 'none'",
		"frame-ancestors 'self'",
		"form-action 'none'",
		"base-uri 'none'",
	} {
		if !strings.Contains(csp, directive) {
			t.Fatalf("frame CSP %q is missing %q", csp, directive)
		}
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("the plugin frame does not send nosniff")
	}
}

// The carve-out is a route group, so the only way it can widen is if a route
// moves into that group. This walks the real routing tree and holds every
// other route to DENY, which is what makes "the carve-out cannot widen
// unnoticed" a fact rather than a hope.
func TestEveryNonPluginRouteStillSendsXFrameOptionsDeny(t *testing.T) {
	srv, _ := pluginFrameServer(t, "")

	h, ok := srv.Config.Handler.(*Handler)
	if !ok {
		t.Fatalf("test server is not serving an api.Handler")
	}
	router, ok := h.Handler.(chi.Router)
	if !ok {
		t.Fatalf("the api handler is not a chi router")
	}

	var checked int
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.HasPrefix(route, pluginFramePrefix) {
			return nil
		}
		// Route params have no meaning to a header check; any value reaches
		// the same middleware chain. Only the braced spans are substituted —
		// rewriting bare substrings would silently retarget a literal segment
		// at the catch-all, which sends DENY and would score a widened route
		// as a pass.
		path := routeParam.ReplaceAllString(route, "x")
		path = strings.ReplaceAll(path, "/*", "/x")
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader("{}"))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := srv.Client().Do(req)
		if err != nil {
			return nil
		}
		resp.Body.Close()
		checked++
		if got := resp.Header.Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("%s %s: X-Frame-Options %q, want DENY — the plugin carve-out has widened", method, route, got)
		}
		return nil
	}
	if err := chi.Walk(router, walk); err != nil {
		t.Fatalf("walking the routes: %v", err)
	}
	if checked < 20 {
		t.Fatalf("only walked %d routes — the walk is not covering the router", checked)
	}
}

// The frame can make no network request at all, so the plugin's UI has to
// arrive inside the document the host serves.
func TestThePluginFrameInlinesTheUIBundle(t *testing.T) {
	srv, _ := pluginFrameServer(t, "window.__demo = 41 + 1;")

	resp, body := get(t, srv, "/plugin-ui/demo/1.0.0")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "window.__demo = 41 + 1;") {
		t.Fatalf("the plugin UI bundle was not inlined into the frame document:\n%s", body)
	}
	if !strings.Contains(body, "parleyBridgeReady") {
		t.Fatalf("the frame document does not carry the bridge bootstrap:\n%s", body)
	}
}

// A UI bundle is operator-supplied, but it is not the host's own markup: a
// bundle containing a script close tag must not be able to end the host's
// script element and start an element of its own.
func TestAScriptCloseTagInAUIBundleCannotBreakOutOfTheFrameScript(t *testing.T) {
	srv, _ := pluginFrameServer(t, "var x = '</script><script>window.__escaped = true;</script>';")

	_, body := get(t, srv, "/plugin-ui/demo/1.0.0")
	if strings.Contains(body, "</script><script>") {
		t.Fatalf("a UI bundle broke out of the host's script element:\n%s", body)
	}
	if !strings.Contains(body, `<\/script>`) {
		t.Fatalf("the close tag was not neutralised:\n%s", body)
	}
}

// A bundle path is operator input and there is no legitimate separator in
// either field — the same rule DirBundles holds the wasm to.
func TestThePluginFrameRefusesANameThatClimbsOutOfThePluginDirectory(t *testing.T) {
	srv, dir := pluginFrameServer(t, "")
	outside := filepath.Join(filepath.Dir(dir), "escape-1.0.0.ui.js")
	if err := os.WriteFile(outside, []byte("window.__escaped = true;"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(outside) })

	// Routing alone would refuse most of these, but routing is not the guard:
	// the screen is asserted where it lives, so it stays asserted if the route
	// pattern ever changes.
	for _, field := range []string{"../escape", "..", `..\escape`, "sub/escape", ""} {
		if _, err := readPluginUI(dir, field, "1.0.0"); err == nil {
			t.Fatalf("name %q was accepted", field)
		}
		if _, err := readPluginUI(dir, "demo", field); err == nil {
			t.Fatalf("version %q was accepted", field)
		}
	}
	// The control: a legitimate pair still loads, so the screen is refusing
	// the climb rather than refusing everything.
	if err := os.WriteFile(filepath.Join(dir, "demo-1.0.0.ui.js"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPluginUI(dir, "demo", "1.0.0"); err != nil {
		t.Fatalf("a legitimate bundle was refused: %v", err)
	}
	// And over HTTP the traversal is refused too.
	for _, name := range []string{"..%2Fescape", "..", "%2e%2e%2fescape"} {
		resp, body := get(t, srv, "/plugin-ui/"+name+"/1.0.0")
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("name %q was served: %s", name, body)
		}
	}
}

// No plugin directory means no plugin frames: an instance that runs no
// plugins must not expose a route whose whole purpose is embedding untrusted
// code.
func TestThePluginFrameRouteIsClosedWithoutAPluginDirectory(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	resp, _ := get(t, srv, "/plugin-ui/demo/1.0.0")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("plugin frame with no PLUGIN_DIR: got %d, want 404", resp.StatusCode)
	}
}

// An unknown plugin is a 404, not the app shell: falling through to the SPA
// would hand a would-be embedder a 200 with the real application in it.
func TestAnUnknownPluginIsNotServedTheAppShell(t *testing.T) {
	srv, _ := pluginFrameServer(t, "")

	resp, body := get(t, srv, "/plugin-ui/nosuch/9.9.9")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown plugin: got %d, want 404 (body %q)", resp.StatusCode, body)
	}
}
