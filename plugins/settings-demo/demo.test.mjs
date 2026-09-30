import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHost, generateSettingsTypes } from "../../sdk/plugin-sdk/src/index.js";
import { roomState } from "./demo.js";

const dir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

function fakeHost(settings, secret) {
  const calls = [];
  const host = createHost([], (name, req) => {
    calls.push(name);
    if (name === "parley_settings_get") return settings;
    if (name === "parley_secret_get" && req.name === "apiToken") {
      if (secret === undefined) throw new Error("secret not set");
      return { value: secret };
    }
    throw new Error("unexpected " + name);
  }, manifest);
  return { host, calls };
}

test("the settings schema has a string, a boolean, an enum and one secret", () => {
  const p = manifest.settings.properties;
  assert.equal(p.greeting.type, "string");
  assert.equal(p.loud.type, "boolean");
  assert.deepEqual(p.mood.enum, ["calm", "busy", "celebrating"]);
  assert.equal(p.apiToken.format, "secret");
  assert.equal(manifest.settings.additionalProperties, false);
});

test("the room state reads every setting and never exposes the token", () => {
  const { host, calls } = fakeHost({ greeting: "Hi", loud: true, mood: "busy" }, "tok-123");
  const state = roomState(host);
  assert.deepEqual(state, { message: "HI, THE TEAM IS BUSY", tokenConfigured: true });
  assert.doesNotMatch(JSON.stringify(state), /tok-123/);
  assert.deepEqual(calls, ["parley_settings_get", "parley_secret_get"]);
});

test("an unset token reads as not configured", () => {
  const { host } = fakeHost({ greeting: "Hello", loud: false, mood: "calm" });
  assert.deepEqual(roomState(host), { message: "Hello, the team is calm", tokenConfigured: false });
});

test("settings.d.ts is generated from the manifest and leaves the secret out", () => {
  const ts = readFileSync(join(dir, "settings.d.ts"), "utf8");
  assert.equal(ts, generateSettingsTypes(manifest));
  assert.doesNotMatch(ts, /apiToken\??:/);
});

test("the concatenated guest runs through the Extism Host with the SDK's host.js", () => {
  const sdk = readFileSync(join(dir, "..", "..", "sdk", "plugin-sdk", "src", "host.js"), "utf8");
  const src = [sdk, `var MANIFEST = ${JSON.stringify(manifest)};`, readFileSync(join(dir, "demo.js"), "utf8"), readFileSync(join(dir, "guest.js"), "utf8")]
    .join("\n")
    .replace(/^export /gm, "");
  const replies = { 1: { ok: true, data: { greeting: "Hey", loud: false, mood: "celebrating" } }, 2: { ok: false, error: "not set" } };
  let out;
  const Memory = { fromString: () => ({ offset: 0 }), find: (n) => ({ readString: () => JSON.stringify(replies[n]) }) };
  const Host = { getFunctions: () => ({ parley_settings_get: () => 1, parley_secret_get: () => 2 }), outputString: (s) => (out = s) };
  const module = { exports: {} };
  runInContext(src, createContext({ Host, Memory, module }));
  module.exports.on_session_state();
  assert.deepEqual(JSON.parse(out), { message: "Hey, the team is celebrating", tokenConfigured: false });
});

test("the UI shows the message and whether a token is set", () => {
  const root = { textContent: "" };
  let draw;
  const window = { parley: { onState: (fn) => (draw = fn), ready() {} } };
  runInContext(readFileSync(join(dir, "ui.js"), "utf8"), createContext({ window, document: { getElementById: () => root } }));
  draw({ state: { message: "Hello, the team is calm", tokenConfigured: true } });
  assert.equal(root.textContent, "Hello, the team is calm (token configured)");
});
