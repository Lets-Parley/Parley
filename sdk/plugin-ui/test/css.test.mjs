import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "parley.css"),
  "utf8",
);

test("plugin-ui primitives are classes on host colour tokens", () => {
  assert.match(css, /\.parley-btn\b/);
  assert.match(css, /\.parley-panel\b/);
  assert.match(css, /\.parley-input\b/);
  assert.match(css, /var\(--color-accent\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--color-ink\)/);
});
