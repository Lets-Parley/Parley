function hostCall(fn, req) {
  var mem = Memory.fromString(JSON.stringify(req));
  var offset = fn(mem.offset);
  var raw = Memory.find(offset).readString();
  var env = JSON.parse(raw);
  if (!env.ok) {
    throw new Error(env.error || "host refused");
  }
  return env.data;
}

function utf8ToB64(str) {
  var bytes = new TextEncoder().encode(str);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToUtf8(b64) {
  if (!b64) return "";
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function loadBoard(kvGet, session) {
  var data = hostCall(kvGet, { scope: "board", key: session });
  if (!data || !data.found || !data.value) return emptyBoard();
  var raw = typeof data.value === "string" ? b64ToUtf8(data.value) : "";
  if (!raw) return emptyBoard();
  var board = JSON.parse(raw);
  if (!board || !board.columns) return emptyBoard();
  return board;
}

function saveBoard(kvSet, session, board) {
  hostCall(kvSet, {
    scope: "board",
    key: session,
    value: utf8ToB64(JSON.stringify(board)),
  });
}

function on_session_state() {
  var fns = Host.getFunctions();
  var input = JSON.parse(Host.inputString() || "{}");
  var board = loadBoard(fns.parley_kv_get, input.session);
  Host.outputString(JSON.stringify(redactBoard(board)));
}

function on_session_action() {
  var fns = Host.getFunctions();
  var input = JSON.parse(Host.inputString() || "{}");
  var board = loadBoard(fns.parley_kv_get, input.session);
  applyAction(board, {
    action: input.action,
    user: input.user,
    body: input.body || {},
  });
  saveBoard(fns.parley_kv_set, input.session, board);
  Host.outputString("{}");
}

module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
