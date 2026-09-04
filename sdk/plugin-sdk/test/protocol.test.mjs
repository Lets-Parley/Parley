import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WIRE_PROTOCOL_VERSION } from "../src/protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const abi = JSON.parse(readFileSync(join(root, "abi", "v1.json"), "utf8"));

test("the wire protocol is frozen at version 1", () => {
  assert.equal(WIRE_PROTOCOL_VERSION, 1);
  assert.equal(abi.protocol, 1);
  assert.equal(abi.frozen, true);
});

test("kv_set keeps a compare-and-swap field open rather than freezing it away", () => {
  const kvSet = abi.hostFunctions.find((fn) => fn.name === "parley_kv_set");
  assert.ok(kvSet);
  assert.ok(kvSet.notFrozenAway.includes("expected"));
});

test("job_enqueue keeps cron as a compatible extension of protocol 1", () => {
  const enqueue = abi.hostFunctions.find((fn) => fn.name === "parley_job_enqueue");
  assert.ok(enqueue);
  assert.equal(enqueue.request.cron, "string");
  assert.ok(enqueue.notFrozenAway.includes("cron"));
});
