import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { helloState } from "./hello.js";

const dir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

test("the manifest declares one kind and asks for no capabilities", () => {
  assert.equal(manifest.name, "hello");
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.kinds.map((k) => k.kind), ["hello"]);
  const r = spawnSync(process.execPath, [join(dir, "..", "..", "sdk", "plugin-sdk", "src", "cli.js"), "verify", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the guest answers the room state through the Extism Host", () => {
  let out;
  const Host = { inputString: () => JSON.stringify({ session: "s1" }), outputString: (s) => (out = s) };
  const module = { exports: {} };
  const src = readFileSync(join(dir, "hello.js"), "utf8").replace(/^export /gm, "") + readFileSync(join(dir, "guest.js"), "utf8");
  runInContext(src, createContext({ Host, module }));
  module.exports.on_session_state();
  assert.deepEqual(JSON.parse(out), helloState({ session: "s1" }));
  assert.equal(JSON.parse(out).greeting, "Hello from a plugin");
});

test("the UI draws the greeting from the room state", () => {
  const root = { textContent: "" };
  let draw;
  const window = { parley: { onState: (fn) => (draw = fn), ready() {} } };
  runInContext(readFileSync(join(dir, "ui.js"), "utf8"), createContext({ window, document: { getElementById: () => root } }));
  draw({ state: { greeting: "Hello from a plugin" } });
  assert.equal(root.textContent, "Hello from a plugin");
});
