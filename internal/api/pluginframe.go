package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// pluginFramePrefix is the one path on this instance that is allowed to be
// framed. Everything else stays behind X-Frame-Options: DENY.
const pluginFramePrefix = "/plugin-ui"

// pluginFrameCSP is the policy the plugin's UI runs under.
//
// default-src 'none' with connect-src 'none' is what makes a capability grant
// enforceable: the frame cannot fetch, cannot open a socket, cannot beacon.
// Every byte it sees arrives over the MessageChannel port, where the host has
// already redacted it. It is also what makes an air-gapped install work.
//
// script-src and style-src are 'unsafe-inline' rather than 'self' on purpose.
// The frame is sandboxed without allow-same-origin, so its origin is opaque
// and 'self' matches nothing at all — an external script or stylesheet is not
// merely discouraged here, it is unreachable. Inline is therefore the only
// way to deliver the UI, and since the document is assembled by the host from
// a bundle an operator installed, "inline" means "what the host put there".
//
// frame-ancestors 'self' is the counter-directive that X-Frame-Options cannot
// express: only this instance may embed the frame.
const pluginFrameCSP = "default-src 'none'; " +
	"script-src 'unsafe-inline'; " +
	"style-src 'unsafe-inline'; " +
	"img-src data:; " +
	"font-src data:; " +
	"connect-src 'none'; " +
	"frame-ancestors 'self'; " +
	"form-action 'none'; " +
	"base-uri 'none'"

// pluginFrameHeaders is the second securityHeaders profile. It is deliberately
// a whole separate middleware rather than a path check inside securityHeaders:
// a path check is a matching rule, and matching rules get evaded. This one is
// reachable only by being in the route group that runs it.
func pluginFrameHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", pluginFrameCSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		// No X-Frame-Options. Framing is the point, and frame-ancestors above
		// is the directive that says who may do it.
		next.ServeHTTP(w, r)
	})
}

// mountPluginFrame registers the framed route group. It is a chi group with
// its own middleware chain, so securityHeaders — and the X-Frame-Options: DENY
// it sets — never runs for it, and cannot be made to run for anything else by
// editing a prefix.
func (a *app) mountPluginFrame(root chi.Router) {
	root.Group(func(g chi.Router) {
		g.Use(pluginFrameHeaders)
		g.Get(pluginFramePrefix+"/{name}/{version}", a.handlePluginFrame)
	})
}

// handlePluginFrame serves the sandbox document for one installed plugin's UI.
func (a *app) handlePluginFrame(w http.ResponseWriter, r *http.Request) {
	if a.pluginDir == "" {
		http.NotFound(w, r)
		return
	}
	name, version := chi.URLParam(r, "name"), chi.URLParam(r, "version")
	ui, err := readPluginUI(a.pluginDir, name, version)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// A plugin's UI changes when its version does, and the version is in the
	// path — but a stale frame is a stale sandbox, so this is not cached.
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, pluginFrameDocument, escapeForScript(pluginFrameBootstrap), escapeForScript(string(ui)))
}

// readPluginUI loads "<name>-<version>.ui.js" from the plugin directory. The
// screening matches plugin.DirBundles: a name or version that could climb out
// of the directory is refused rather than cleaned, because there is no
// legitimate separator in either field.
func readPluginUI(dir, name, version string) ([]byte, error) {
	for _, field := range []string{name, version} {
		if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			return nil, fmt.Errorf("%q is not a usable plugin name or version", field)
		}
	}
	path := filepath.Join(dir, name+"-"+version+".ui.js")
	body, err := os.ReadFile(path) //nolint:gosec // the components are screened above
	if err != nil {
		return nil, fmt.Errorf("reading the UI bundle for %s %s: %w", name, version, err)
	}
	return body, nil
}

// escapeForScript neutralises the two byte sequences that can end an HTML
// script element from inside it. Both replacements are valid JavaScript
// wherever the original could legally appear — in a string, a regular
// expression or a comment — and outside those the original cannot appear at
// all, so this changes no program's meaning.
func escapeForScript(js string) string {
	return strings.NewReplacer("</", `<\/`, "<!--", `<\!--`).Replace(js)
}

// pluginFrameDocument is the whole sandbox. It loads nothing: the policy above
// forbids it, so the bridge bootstrap and the plugin's UI are both inlined.
const pluginFrameDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="` + pluginFrameCSP + `">
<title>Plugin</title>
<style>
html,body{margin:0;padding:0;height:100%%;background:var(--color-surface,#fff);color:var(--color-ink,#111);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}
</style>
</head><body><div id="root"></div>
<script>%s</script>
<script>%s</script>
</body></html>
`

// pluginFrameBootstrap is the frame's half of the bridge.
//
// Authentication is by channel identity. The frame's origin is the string
// "null" because it is sandboxed without allow-same-origin, and every opaque
// frame reports exactly that — so checking event.origin proves nothing. The
// port is the credential instead: it is transferred once, it is unforgeable,
// it is unicast, and after the handshake the window message listener is
// removed so nothing that arrives by any other route is ever read.
const pluginFrameBootstrap = `(function () {
  "use strict";
  var port = null, queue = [], state = null, tokens = null;
  var handlers = { state: [], tokens: [] };
  var MAX_BYTES = 65536;

  function emit(kind, value) {
    for (var i = 0; i < handlers[kind].length; i++) {
      try { handlers[kind][i](value); } catch (e) { /* a plugin's own bug */ }
    }
  }

  function applyTokens(t) {
    var root = document.documentElement;
    for (var key in t) {
      if (Object.prototype.hasOwnProperty.call(t, key) && /^[a-z-]+$/.test(key)) {
        root.style.setProperty("--color-" + key, String(t[key]));
      }
    }
  }

  function send(message) {
    var body = JSON.stringify(message);
    if (body.length > MAX_BYTES) { throw new Error("message too large"); }
    if (!port) { queue.push(body); return; }
    port.postMessage(body);
  }

  window.parley = {
    onState: function (fn) { handlers.state.push(fn); if (state) { fn(state); } },
    onTokens: function (fn) { handlers.tokens.push(fn); if (tokens) { fn(tokens); } },
    state: function () { return state; },
    act: function (action, payload) { send({ type: "act", action: action, payload: payload || {} }); },
    ready: function () { send({ type: "ready" }); }
  };

  function onPort(event) {
    var message;
    try { message = JSON.parse(event.data); } catch (e) { return; }
    if (!message || typeof message !== "object") { return; }
    if (message.type === "state") { state = message.state; emit("state", state); }
    else if (message.type === "tokens") { tokens = message.tokens; applyTokens(tokens); emit("tokens", tokens); }
  }

  function onHandshake(event) {
    if (!event.ports || event.ports.length !== 1) { return; }
    window.removeEventListener("message", onHandshake);
    port = event.ports[0];
    port.onmessage = onPort;
    port.start();
    while (queue.length) { port.postMessage(queue.shift()); }
    send({ type: "hello" });
  }

  window.addEventListener("message", onHandshake);
  window.parleyBridgeReady = true;
})();
`
