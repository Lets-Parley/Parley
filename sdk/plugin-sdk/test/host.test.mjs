import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost } from "../src/host.js";

test("kvSet fails fast without a kv grant and does not call the bridge", () => {
  let calls = 0;
  const host = createHost([], (name, req) => {
    calls += 1;
    return { name, req };
  });
  assert.throws(() => host.kvSet({ scope: "board", key: "s1", value: "x" }), /kv/);
  assert.equal(calls, 0);
});

test("kvSet still calls the bridge when the grant is present", () => {
  let calls = 0;
  const host = createHost([{ capability: "kv", scope: "board" }], (name, req) => {
    calls += 1;
    return { name, req };
  });
  const out = host.kvSet({ scope: "board", key: "s1", value: "x" });
  assert.equal(calls, 1);
  assert.equal(out.name, "parley_kv_set");
});

test("fetch fails fast without a fetch grant", () => {
  let calls = 0;
  const host = createHost([{ capability: "kv" }], () => {
    calls += 1;
  });
  assert.throws(() => host.fetch({ url: "https://example.com" }), /fetch/);
  assert.equal(calls, 0);
});
