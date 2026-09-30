import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost, generateSettingsTypes } from "../src/index.js";

const schema = {
  type: "object",
  properties: {
    greeting: { type: "string", default: "hi" },
    loud: { type: "boolean" },
    mood: { type: "string", enum: ["calm", "busy"] },
    limit: { type: "integer", minimum: 1 },
    apiToken: { type: "string", format: "secret" },
  },
  required: ["greeting", "mood"],
  additionalProperties: false,
};

test("getSettings calls parley_settings_get when the manifest declares settings", () => {
  const calls = [];
  const host = createHost([], (name, req) => (calls.push([name, req]), { greeting: "yo" }), { settings: schema });
  assert.deepEqual(host.getSettings(), { greeting: "yo" });
  assert.equal(calls[0][0], "parley_settings_get");
});

test("getSettings fails fast in the guest when the manifest declares no settings", () => {
  let called = false;
  const host = createHost([], () => (called = true), { name: "x" });
  assert.throws(() => host.getSettings(), /declares no settings/);
  assert.throws(() => createHost([], () => {}).getSettings(), /declares no settings/);
  assert.equal(called, false);
});

test("getSecret reads a secret settings field through parley_secret_get", () => {
  const calls = [];
  const host = createHost([], (name, req) => (calls.push([name, req]), "s3cret"), { settings: schema });
  assert.equal(host.getSecret("apiToken"), "s3cret");
  assert.deepEqual(calls, [["parley_secret_get", { name: "apiToken" }]]);
  assert.throws(() => host.getSecret("greeting"), /secrets is not granted/);
});

test("generateSettingsTypes types non-secret fields and names secret ones separately", () => {
  const ts = generateSettingsTypes({ settings: schema });
  assert.match(ts, /greeting: string;/);
  assert.match(ts, /loud\?: boolean;/);
  assert.match(ts, /mood: "calm" \| "busy";/);
  assert.match(ts, /limit\?: number;/);
  assert.doesNotMatch(ts, /apiToken:|apiToken\?:/);
  assert.match(ts, /export type SecretName = "apiToken";/);
  // The host applies defaults, so a defaulted field is always present.
  const withDefault = generateSettingsTypes({ settings: { type: "object", properties: { n: { type: "integer", default: 3 } }, additionalProperties: false } });
  assert.match(withDefault, /  n: number;/);
  assert.match(generateSettingsTypes({}), /export type Settings = Record<string, never>;/);
});
