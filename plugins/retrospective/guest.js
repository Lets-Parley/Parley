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

// A board that does not exist yet starts with the open actions the last retro
// in its space left behind. Without a space key (an older host) or the
// carryover grant, it simply starts empty.
function newBoard(kvGet, spaceKey) {
  var board = emptyBoard();
  if (!spaceKey) return board;
  try {
    var data = hostCall(kvGet, { scope: "carryover", key: spaceKey });
    if (data && data.found && typeof data.value === "string") seedCarried(board, JSON.parse(b64ToUtf8(data.value)));
  } catch (err) {
    return emptyBoard();
  }
  return board;
}

// Best effort: a carry-over that is not written costs the next retro its
// reminder, never this room its action.
function saveCarryover(kvSet, spaceKey, board) {
  if (!spaceKey || board.stage !== STAGES - 1) return;
  try {
    hostCall(kvSet, { scope: "carryover", key: spaceKey, value: utf8ToB64(JSON.stringify(openActions(board))) });
  } catch (err) {}
}

function loadBoard(kvGet, session, spaceKey) {
  var data = hostCall(kvGet, { scope: "board", key: session });
  if (!data || !data.found || !data.value) return newBoard(kvGet, spaceKey);
  var raw = typeof data.value === "string" ? b64ToUtf8(data.value) : "";
  if (!raw) return newBoard(kvGet, spaceKey);
  var board = JSON.parse(raw);
  if (!board || !board.columns) return emptyBoard();
  return board;
}

// The store is one quota for every room of the org. When it is full the host
// function says so in words (internal/plugin/kv.go, ErrQuotaExceeded), and
// that is the room's to hear as "no", not a fault of the plugin: false means
// the board did not fit. Anything else the host refuses is thrown on.
// Matching the host's English message is a stopgap until the host returns a
// typed error for a full store; do not copy it as good practice.
var STORE_FULL = "plugin storage quota exceeded";

function saveBoard(kvSet, session, board) {
  try {
    hostCall(kvSet, {
      scope: "board",
      key: session,
      value: utf8ToB64(JSON.stringify(board)),
    });
  } catch (err) {
    // Stopgap: string match on the host's message (see STORE_FULL).
    if (String(err && err.message).indexOf(STORE_FULL) !== -1) return false;
    throw err;
  }
  return true;
}

function on_session_state() {
  var fns = Host.getFunctions();
  var input = JSON.parse(Host.inputString() || "{}");
  var board = loadBoard(fns.parley_kv_get, input.session, input.spaceKey);
  Host.outputString(JSON.stringify(redactBoard(board, Date.now())));
}

// A refused action is answered with its code and nothing is saved: the host
// tells the caller no and counts nothing against the plugin. Anything thrown
// from here on is a fault, and is the host's to count.
function on_session_action() {
  var fns = Host.getFunctions();
  var input = JSON.parse(Host.inputString() || "{}");
  var board = loadBoard(fns.parley_kv_get, input.session, input.spaceKey);
  var answer = answerAction(board, {
    action: input.action,
    user: input.user,
    body: input.body || {},
    now: Date.now(),
  });
  if (!answer.refused && !saveBoard(fns.parley_kv_set, input.session, board)) answer = { refused: "conflict" };
  if (!answer.refused) saveCarryover(fns.parley_kv_set, input.spaceKey, board);
  Host.outputString(JSON.stringify(answer));
}

module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
