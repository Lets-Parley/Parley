import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const pkg = require("./manifest.json");

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

// The host refuses a facilitator-only action for anyone else before the guest
// runs, and the guest is never told who the facilitator is: for these seven,
// this list is the whole of the check.
test("the actions only the facilitator may call are marked so, and no others are", () => {
  const only = pkg.kinds[0].actions.filter((a) => a.facilitatorOnly).map((a) => a.name);
  assert.deepEqual(only, ["moderate-card", "reveal", "conceal", "set-stage", "timer", "order-by-votes", "moderate-stamp"]);
  const open = pkg.kinds[0].actions.filter((a) => !a.facilitatorOnly).map((a) => a.name);
  assert.deepEqual(open, ["add-card", "delete-card", "group-cards", "vote", "move-card", "move-group", "stamp", "move-stamp", "remove-stamp", "add-action", "set-owner", "delete-action", "link-action"]);
  assert.ok(pkg.kinds[0].actions.every((a) => a.verb === "POST"));
});

test("package.json, still read by the host's consent-copy test, matches manifest.json", () => {
  assert.deepEqual(require("./package.json"), pkg);
});
