import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateGuestHookTypes } from "../src/hooks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const abi = JSON.parse(readFileSync(join(root, "abi", "v1.json"), "utf8"));

test("guest hook types are generated from the v1 ABI schemas", () => {
  const dts = generateGuestHookTypes(abi);
  assert.match(dts, /export type OnSessionState/);
  assert.match(dts, /export type OnSessionAction/);
  assert.match(dts, /export type OnEvent/);
  assert.match(dts, /export type OnJob/);
  assert.match(dts, /on_session_state/);
  assert.match(dts, /on_session_action/);
});
