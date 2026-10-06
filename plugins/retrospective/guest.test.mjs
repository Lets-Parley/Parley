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
function call(fn, input, { stored, setError, getError, carry, carryError } = {}) {
  const sets = [];
  const blocks = [];
  const Memory = {
    fromString: (text) => ({ offset: blocks.push(text) - 1 }),
    find: (offset) => ({ readString: () => blocks[offset] }),
  };
  const answer = (env) => blocks.push(JSON.stringify(env)) - 1;
  const host = {
    parley_kv_get: (offset) => JSON.parse(blocks[offset]).scope === "carryover"
      ? answer(carryError ? { ok: false, error: carryError } : carry === undefined ? { ok: true, data: { found: false } } : { ok: true, data: { found: true, value: Buffer.from(carry, "utf8").toString("base64") } })
      : answer(getError ? { ok: false, error: getError } : { ok: true, data: stored === undefined ? { found: false } : { found: true, value: Buffer.from(stored, "utf8").toString("base64") } }),
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

// ---- carry-over

test("a retro at Decide leaves its open actions for the next retro in its space", () => {
  const board = JSON.parse(act("add-action", { text: "fix CI", owner: "Cy" }).sets[0].value);
  board.actionItems.push({ id: "a9", text: "done one", owner: "", done: true, sourceIds: [] });
  board.stage = 3;
  const { sets } = call("on_session_action", { session: "s1", spaceKey: "k1", action: "set-owner", user: "alice", body: { actionId: "a1", owner: "Di" } }, { stored: JSON.stringify(board) });
  const carry = sets.filter((s) => s.scope === "carryover");
  assert.equal(carry.length, 1);
  assert.equal(carry[0].key, "k1");
  assert.deepEqual(JSON.parse(carry[0].value), [{ text: "fix CI", owner: "Di" }]);
});

test("before Decide, or with no space key, nothing is carried", () => {
  assert.equal(call("on_session_action", { session: "s1", spaceKey: "k1", action: "add-action", user: "alice", body: { text: "x" } }).sets.some((s) => s.scope === "carryover"), false);
  const board = JSON.parse(act("add-action", { text: "x" }).sets[0].value);
  board.stage = 3;
  assert.equal(act("set-owner", { actionId: "a1", owner: "Di" }, { stored: JSON.stringify(board) }).sets.some((s) => s.scope === "carryover"), false);
});

test("a new board in the space starts with the last retro's open actions", () => {
  const carry = JSON.stringify([{ text: "fix CI", owner: "Di" }]);
  const state = call("on_session_state", { session: "s2", spaceKey: "k1" }, { carry });
  assert.deepEqual(state.output.actionItems.map((a) => [a.text, a.owner, a.done, a.carried]), [["fix CI", "Di", false, true]]);
  assert.equal(state.sets.length, 0);
  const { sets } = call("on_session_action", { session: "s2", spaceKey: "k1", action: "set-done", user: "alice", body: { actionId: state.output.actionItems[0].id, done: true } }, { carry });
  const saved = JSON.parse(sets.find((s) => s.scope === "board").value);
  assert.deepEqual(saved.actionItems.map((a) => [a.text, a.done, a.carried]), [["fix CI", true, true]]);
  // A board that exists already is never seeded again.
  const again = call("on_session_state", { session: "s2", spaceKey: "k1" }, { carry, stored: JSON.stringify(saved) });
  assert.equal(again.output.actionItems.length, 1);
});

test("a carry-over that cannot be read or written never costs the room its action", () => {
  const notGranted = 'kv in scope "carryover": capability not granted';
  const state = call("on_session_state", { session: "s2", spaceKey: "k1" }, { carryError: notGranted });
  assert.equal(state.output.actionItems.length, 0);
  const board = JSON.parse(act("add-action", { text: "x" }).sets[0].value);
  board.stage = 3;
  const real = call("on_session_action", { session: "s1", spaceKey: "k1", action: "set-owner", user: "alice", body: { actionId: "a1", owner: "Di" } }, { stored: JSON.stringify(board), carry: "{not json" });
  assert.deepEqual(real.output, {});
});
