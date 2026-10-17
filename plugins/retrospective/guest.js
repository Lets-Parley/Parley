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

// ErrNotGranted's text (internal/plugin/grants.go). Matching the host's
// English is a stopgap, as with STORE_FULL below.
var NOT_GRANTED = "does not hold this capability";

function notGranted(err) {
  return String(err && err.message).indexOf(NOT_GRANTED) !== -1;
}

function permanent(err) {
  return notGranted(err) || String(err && err.message).indexOf(STORE_FULL) !== -1;
}

// One retry for a blip. A missing grant and a full store will fail the same
// way the second time, so they are not retried.
function attempt(fn, req) {
  try {
    return { data: hostCall(fn, req) };
  } catch (err) {
    if (permanent(err)) return { error: err };
    try {
      return { data: hostCall(fn, req) };
    } catch (again) {
      return { error: again };
    }
  }
}

// The stored hand-off is { session, at, actions }. A bare list is a hand-off
// written before the document carried a session, and it loses to any room
// that has entered Decide.
function carryDoc(value) {
  if (Array.isArray(value)) return { session: "", at: 0, actions: value };
  if (!value || !Array.isArray(value.actions) || typeof value.session !== "string" || typeof value.at !== "number" || !(value.at >= 0)) return null;
  return { session: value.session, at: value.at, actions: value.actions };
}

function readCarry(kvGet, spaceKey) {
  var got = attempt(kvGet, { scope: "carryover", key: spaceKey });
  if (got.error) return got;
  var data = got.data;
  if (!data || !data.found || typeof data.value !== "string") return { data: null };
  try {
    return { data: carryDoc(JSON.parse(b64ToUtf8(data.value))) };
  } catch (err) {
    return { data: null };
  }
}

// A board that does not exist yet starts with the open actions the owning
// retro in its space left behind. Without a space key (an older host) or the
// carryover grant, it simply starts empty. Any other failure to read is a
// fault: saving the empty board would make the miss permanent.
function newBoard(kvGet, spaceKey) {
  var board = emptyBoard();
  if (!spaceKey) return board;
  var got = readCarry(kvGet, spaceKey);
  if (got.error) {
    if (notGranted(got.error)) return board;
    throw got.error;
  }
  if (got.data) seedCarried(board, got.data.actions);
  return board;
}

// The room that most recently entered Decide owns the hand-off. A later change
// in that room updates it, including after the room has left Decide. An older
// room does not. A write that still fails costs the next retro its reminder,
// never this room its action. The host does not say which caller is a
// signed-link guest, so whoever can act in the owning room can change it.
function saveCarryover(kvGet, kvSet, spaceKey, session, board) {
  if (!spaceKey || !session || !(board.decidedAt > 0)) return;
  var got = readCarry(kvGet, spaceKey);
  if (got.error) return;
  var doc = got.data;
  var at = board.decidedAt;
  if (doc && doc.session === session && doc.at > at) at = doc.at;
  if (doc && doc.session !== session && doc.at > board.decidedAt) return;
  attempt(kvSet, {
    scope: "carryover",
    key: spaceKey,
    value: utf8ToB64(JSON.stringify({ session: session, at: at, actions: openActions(board) })),
  });
}

// decidedAt is the clock when this room last entered Decide. Stepping back
// keeps it, so a done mark there still updates the hand-off this room owns.
function touchDecide(board, action, now) {
  if (action === "set-stage" && board.stage === STAGES - 1) board.decidedAt = now;
  else if (board.stage === STAGES - 1 && !(board.decidedAt > 0)) board.decidedAt = now;
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
  var now = Date.now();
  var answer = answerAction(board, {
    action: input.action,
    user: input.user,
    body: input.body || {},
    now: now,
  });
  if (!answer.refused) touchDecide(board, input.action, now);
  if (!answer.refused && !saveBoard(fns.parley_kv_set, input.session, board)) answer = { refused: "conflict" };
  if (!answer.refused) saveCarryover(fns.parley_kv_get, fns.parley_kv_set, input.spaceKey, input.session, board);
  Host.outputString(JSON.stringify(answer));
}

module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
