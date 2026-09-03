package api

import (
	"context"
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
// other route to the whole header profile, which is what makes "the carve-out
// cannot widen unnoticed" a fact rather than a hope.
//
// It checks all four headers rather than X-Frame-Options alone: a carve-out
// that leaked only the CSP is still a carve-out. And it probes a *disallowed*
// method on every route as well as the registered one, because chi answers
// those from its own handler, outside the route tree — the one response a walk
// over registered method+path pairs cannot otherwise reach.
func TestEveryNonPluginRouteStillSendsTheSecurityHeaders(t *testing.T) {
	srv, _ := pluginFrameServer(t, "")

	h, ok := srv.Config.Handler.(*Handler)
	if !ok {
		t.Fatalf("test server is not serving an api.Handler")
	}
	router, ok := h.Handler.(chi.Router)
	if !ok {
		t.Fatalf("the api handler is not a chi router")
	}

	probe := func(method, route, path, why string) {
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader("{}"))
		if err != nil {
			t.Fatalf("%s %s (%s): building the request: %v — the floor below counts "+
				"routes walked, so a route that was never probed must not pass quietly",
				method, route, why, err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Errorf("%s %s (%s): %v — this route was counted toward the coverage "+
				"floor but never actually answered", method, route, why, err)
			return
		}
		resp.Body.Close()
		for header, want := range securityHeaderProfile {
			if got := resp.Header.Get(header); got != want {
				t.Errorf("%s %s (%s): %s = %q, want %q — the plugin carve-out has widened",
					method, route, why, header, got, want)
			}
		}
	}

	var checked int
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.HasPrefix(route, pluginFramePrefix) {
			return nil
		}
		// Route params have no meaning to a header check; any value reaches
		// the same middleware chain. Only the braced spans are substituted —
		// rewriting bare substrings would silently retarget a literal segment
		// at the catch-all, which sends the headers and would score a widened
		// route as a pass.
		path := routeParam.ReplaceAllString(route, "x")
		path = strings.ReplaceAll(path, "/*", "/x")
		checked++
		probe(method, route, path, "registered method")
		// A method this route does not answer on. chi resolves it to its own
		// method-not-allowed handler, which is where the headers went missing.
		probe(notThisMethod(method), route, path, "disallowed method")
		return nil
	}
	if err := chi.Walk(router, walk); err != nil {
		t.Fatalf("walking the routes: %v", err)
	}
	// The floor tracks the router rather than trailing far behind it: a walk
	// that silently stopped covering two thirds of the tree would still have
	// cleared the floor of 20 this replaced. 77 routes are registered today,
	// and the margin is for routes retired between here and the next time
	// somebody reads this line, not for a walk that has stopped working.
	if checked < 70 {
		t.Fatalf("only walked %d routes — the walk is not covering the router", checked)
	}
}

// notThisMethod picks a verb the route under test is not registered for. The
// pair is deliberately narrow: every route here answers on at most a handful
// of verbs, and both of these are ones the API uses somewhere, so the request
// travels the same middleware as a real one.
func notThisMethod(method string) string {
	if method == http.MethodDelete {
		return http.MethodPatch
	}
	return http.MethodDelete
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

// The frame's handshake is exercised where it can actually run: the bootstrap
// is a real .js file this package embeds, and
// web/src/lib/pluginFrameBootstrap.test.ts loads those same bytes into jsdom
// and drives real message events at them — a sender that is not the embedder,
// a message without the host's marker, a handshake with no port, and a second
// handshake after the first. That is behaviour rather than text, which the
// assertion that used to stand here was not: it checked that two condition
// expressions were present and in order, so a guard whose body had been
// emptied still passed it, while a rephrasing of the same condition failed.
//
// What remains here is the seam between the two runners: the source the Go
// handler serves has to be the source the vitest test executes.
func TestTheFrameBootstrapServedIsTheSourceTheFrontendTests(t *testing.T) {
	onDisk, err := os.ReadFile("pluginframe_bootstrap.js")
	if err != nil {
		t.Fatalf("reading the bootstrap source the frontend test loads: %v", err)
	}
	if string(onDisk) != pluginFrameBootstrap {
		t.Fatalf("the embedded bootstrap and pluginframe_bootstrap.js have drifted apart")
	}

	srv, _ := pluginFrameServer(t, "window.parley.ready();")
	_, body := get(t, srv, "/plugin-ui/demo/1.0.0")
	if !strings.Contains(body, escapeForScript(string(onDisk))) {
		t.Fatalf("the frame does not serve the bootstrap the frontend test executes:\n%s", body)
	}
}

// A design token's value is written into a style declaration. The name was
// screened and the value was not. connect-src 'none' means a CSS url() has
// nowhere to reach, so this was never an exfiltration hole — but the value is
// only ever a colour, and screening it is cheaper to keep true than the
// argument for why an unscreened declaration is safe.
func TestTheFrameBootstrapScreensATokenValueAndNotOnlyItsName(t *testing.T) {
	js := pluginFrameBootstrap

	if !strings.Contains(js, "COLOR.test(value)") {
		t.Fatalf("a token value reaches setProperty unscreened:\n%s", js)
	}
	// The name screen is still there too: this is an addition, not a swap.
	if !strings.Contains(js, "/^[a-z-]+$/.test(key)") {
		t.Fatalf("the token name screen is gone:\n%s", js)
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

// The panel list is what makes the frame reachable from a room. An install
// with no UI bundle is not a panel: framing it would render a 404.
func TestPluginPanelsListsOnlyEnabledInstallsThatShipUI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "retro-1.0.0.ui.js"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, PluginDir: dir})

	ctx := context.Background()
	for _, row := range []struct {
		name, version string
		enabled       bool
	}{
		{"retro", "1.0.0", true},
		{"headless", "2.0.0", true},
		{"retro-off", "1.0.0", false},
	} {
		if _, err := pool.Exec(ctx,
			`insert into plugin_installs (org_id, name, version, enabled, kv_quota_bytes)
			 values ($1, $2, $3, $4, 1024)`,
			defaultOrgID(t, pool), row.name, row.version, row.enabled); err != nil {
			t.Fatal(err)
		}
	}
	// The disabled one also ships UI, so its absence is about `enabled` and
	// not about the file.
	if err := os.WriteFile(filepath.Join(dir, "retro-off-1.0.0.ui.js"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	names := readPanels(t, srv, sess, dana)
	if !contains(names, "retro") {
		t.Fatalf("the installed plugin with UI is missing: %v", names)
	}
	if contains(names, "headless") {
		t.Fatalf("an install with no UI bundle was listed as a panel: %v", names)
	}
	if contains(names, "retro-off") {
		t.Fatalf("a disabled install was listed: %v", names)
	}
}
