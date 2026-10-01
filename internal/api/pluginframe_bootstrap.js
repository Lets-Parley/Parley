(function () {
  "use strict";
  var port = null, queue = [], state = null, tokens = null, scheme = null;
  // Actions waiting on the host's answer, by the id this frame chose. A host
  // that predates results never answers, so the oldest entry is dropped as a
  // new one is added rather than the table growing for the life of the frame.
  var pending = {}, nextId = 0, MAX_PENDING = 64;
  var REASON = /^[a-z-]{1,32}$/;
  var handlers = { state: [], tokens: [] };
  var MAX_BYTES = 65536;

  function emit(kind, value) {
    for (var i = 0; i < handlers[kind].length; i++) {
      try { handlers[kind][i](value); } catch (e) { /* a plugin's own bug */ }
    }
  }

  // A token value goes straight into a style declaration. connect-src 'none'
  // means a CSS url() has nowhere to egress to, so this is not an exfiltration
  // hole — but "the value is screened as well as the name" is a cheaper thing
  // to keep true than "no CSS feature will ever make an unscreened declaration
  // matter". Color-shaped is all a design token here ever is.
  var COLOR = /^(#[0-9a-fA-F]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([0-9a-fA-F.,%\/ +-]{1,64}\))$/;

  function applyTokens(t) {
    var root = document.documentElement;
    for (var key in t) {
      if (Object.prototype.hasOwnProperty.call(t, key) && /^[a-z-]+$/.test(key)) {
        var value = String(t[key]);
        if (COLOR.test(value)) { root.style.setProperty("--color-" + key, value); }
      }
    }
  }

  // color-scheme decides how the browser draws native controls and scrollbars.
  // It is one of two words or it is not applied: the value goes into a style
  // declaration, exactly as a token does.
  function applyScheme(value) {
    if (value === "light" || value === "dark") { scheme = value; document.documentElement.style.setProperty("color-scheme", value); }
  }

  function settle(message) {
    if (!Object.prototype.hasOwnProperty.call(pending, message.id)) { return; }
    var resolve = pending[message.id];
    delete pending[message.id];
    if (message.ok === true) { resolve({ ok: true }); return; }
    resolve({ ok: false, reason: typeof message.reason === "string" && REASON.test(message.reason) ? message.reason : "failed" });
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
    scheme: function () { return scheme; },
    act: function (action, payload) {
      var id = ++nextId;
      send({ type: "act", id: id, action: action, payload: payload || {} });
      delete pending[id - MAX_PENDING];
      return new Promise(function (resolve) { pending[id] = resolve; });
    },
    ready: function () { send({ type: "ready" }); }
  };

  function onPort(event) {
    var message;
    try { message = JSON.parse(event.data); } catch (e) { return; }
    if (!message || typeof message !== "object") { return; }
    if (message.type === "state") { state = message.state; emit("state", state); }
    else if (message.type === "tokens") { tokens = message.tokens; applyTokens(tokens); applyScheme(message.scheme); emit("tokens", tokens); }
    else if (message.type === "result") { settle(message); }
  }

  function onHandshake(event) {
    // The port is the credential — but only once it is in hand. This listener
    // is the single moment the frame reads the window, and any frame on the
    // page can postMessage to it: a sibling plugin's frame, racing the host,
    // could hand this one a channel it controls, then feed it forged state and
    // read every action it proposes. Origin settles nothing, because every
    // sandboxed frame reports "null", so the sender is checked structurally
    // instead: it must be the embedder, and it must carry the host's own
    // marker.
    if (event.source !== window.parent) { return; }
    if (!event.data || event.data.parley !== "bridge") { return; }
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
