import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

test("the install package declares the retrospective kind and the grants it needs", () => {
  assert.equal(pkg.manifest, 1);
  assert.equal(pkg.kind, "plugin");
  assert.equal(pkg.name, "retrospective");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const caps = pkg.capabilities.map((c) => c.capability).sort();
  assert.deepEqual(caps, ["kv", "session:act", "session:read"]);
  assert.equal(pkg.capabilities.find((c) => c.capability === "kv").scope, "board");
  assert.equal(pkg.kinds.length, 1);
  assert.equal(pkg.kinds[0].kind, "retrospective");
  const actions = Object.fromEntries(pkg.kinds[0].actions.map((a) => [a.name, a]));
  assert.equal(actions["add-card"].verb, "POST");
  assert.equal(actions["group-cards"].verb, "POST");
  assert.equal(actions["vote"].verb, "POST");
  assert.equal(actions.reveal.verb, "POST");
  assert.equal(actions.reveal.facilitatorOnly, true);
  assert.equal(actions["add-action"].verb, "POST");
});
