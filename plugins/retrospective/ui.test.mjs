import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "ui.js"), "utf8");

test("the UI talks only over the host bridge", () => {
  assert.match(src, /parley\.onState/);
  assert.match(src, /parley\.onTokens/);
  assert.match(src, /parley\.act\(/);
  assert.match(src, /parley\.ready\(/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /\bWebSocket\b/);
});

test("the UI fills the room and covers the ceremony", () => {
  assert.match(src, /Went well/);
  assert.match(src, /vote/);
  assert.match(src, /Reveal/);
  assert.match(src, /Action items/);
  assert.match(src, /authorId/);
});
