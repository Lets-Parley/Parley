import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
// The guest as the build makes it: board.js, then guest.js, in one script.
// RETRO_GUEST_SRC points at another copy of guest.js, for checking that a
// test can fail. The tracked file is never edited for that.
const source = readFileSync(join(dir, "board.js"), "utf8") + "\n" + readFileSync(process.env.RETRO_GUEST_SRC || join(dir, "guest.js"), "utf8");

const QUOTA = 'writing plugin key "board\u0000s1": plugin storage quota exceeded';

// One call into the guest with a fake host. `stored` is the document the
// store holds, as text; `setError` is what parley_kv_set refuses with.
function call(fn, input, { stored, setError, getError } = {}) {
  const sets = [];
  const blocks = [];
  const Memory = {
    fromString: (text) => ({ offset: blocks.push(text) - 1 }),
    find: (offset) => ({ readString: () => blocks[offset] }),
  };
  const answer = (env) => blocks.push(JSON.stringify(env)) - 1;
  const host = {
    parley_kv_get: () => answer(getError ? { ok: false, error: getError } : { ok: true, data: stored === undefined ? { found: false } : { found: true, value: Buffer.from(stored, "utf8").toString("base64") } }),
    parley_kv_set(offset) {
      const req = JSON.parse(blocks[offset]);
      sets.push({ ...req, value: Buffer.from(req.value, "base64").toString("utf8") });
      return answer(setError ? { ok: false, error: setError } : { ok: true, data: { written: 1 } });
    },
  };
  let output;
  const Host = { getFunctions: () => host, inputString: () => JSON.stringify(input), outputString: (text) => (output = text) };
  const module = { exports: {} };
  runInContext(source, createContext({ module, Host, Memory, TextEncoder, TextDecoder, btoa, atob, Date }));
  module.exports[fn]();
  return { output: JSON.parse(output), sets };
}

const act = (action, body, more) => call("on_session_action", { session: "s1", action, user: "alice", body }, more);

test("an accepted action is saved once and answered with nothing", () => {
  const { output, sets } = act("add-card", { columnId: "went-well", text: "saved" });
  assert.deepEqual(output, {});
  assert.equal(sets.length, 1);
  assert.deepEqual([sets[0].scope, sets[0].key], ["board", "s1"]);
  assert.equal(JSON.parse(sets[0].value).cards[0].text, "saved");
});

test("a declined action is answered with its code and the store is never written", () => {
  for (const [action, body, code] of [
    ["add-card", { columnId: "went-well", text: "" }, "invalid"],
    ["vote", { cardId: "c404" }, "not-found"],
    ["explode", {}, "invalid"],
  ]) {
    const { output, sets } = act(action, body);
    assert.deepEqual(output, { refused: code }, action);
    assert.equal(sets.length, 0, action);
  }
  const stored = JSON.stringify(JSON.parse(act("add-card", { columnId: "went-well", text: "bob's" }).sets[0].value)).replace('"alice"', '"bob"');
  const { output, sets } = act("delete-card", { cardId: "c1" }, { stored });
  assert.deepEqual(output, { refused: "forbidden" });
  assert.equal(sets.length, 0);
});

test("a store that is full declines the action; any other refusal by the host is a fault", () => {
  const { output, sets } = act("add-card", { columnId: "went-well", text: "one too many" }, { setError: QUOTA });
  assert.deepEqual(output, { refused: "conflict" });
  assert.equal(sets.length, 1, "the write was tried once");
  assert.throws(() => act("add-card", { columnId: "went-well", text: "x" }, { setError: "kv in scope \"board\": capability not granted" }), /capability not granted/);
  assert.throws(() => act("add-card", { columnId: "went-well", text: "x" }, { getError: "plugin is disabled" }), /plugin is disabled/);
});

test("a stored document that cannot be read is a fault, not an empty board", () => {
  assert.throws(() => act("vote", { cardId: "c1" }, { stored: "{not json" }), { name: "SyntaxError" });
  assert.throws(() => call("on_session_state", { session: "s1" }, { stored: "{not json" }), { name: "SyntaxError" });
  assert.throws(() => act("vote", { cardId: "c1" }, { stored: '{"columns":[]}' }), { name: "TypeError" });
});

test("the state is the redacted board, and reading it writes nothing", () => {
  const saved = act("add-card", { columnId: "went-well", text: "mine" }).sets[0].value;
  const { output, sets } = call("on_session_state", { session: "s1" }, { stored: saved });
  assert.equal(output.cards[0].text, "mine");
  assert.equal(JSON.stringify(output).includes("alice"), false);
  assert.equal(sets.length, 0);
});
