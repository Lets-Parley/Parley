import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site", "src", "content", "docs");

test("frozen-protocol docs name CAS, one kv document, and guest PDKs", () => {
  const text = readFileSync(join(site, "reference", "plugin-protocol.mdx"), "utf8");
  assert.match(text, /frozen at version 1/i);
  assert.match(text, /compare-and-swap/);
  assert.match(text, /one key-value document per session/i);
  assert.match(text, /Rust/);
  assert.match(text, /TinyGo/);
  assert.match(text, /AssemblyScript/);
  assert.match(text, /\.NET/);
  assert.match(text, /Python is \*\*not\*\* a guest PDK/);
});

test("SDK docs quote describe.go rather than inventing grant copy", () => {
  const text = readFileSync(join(site, "reference", "plugin-sdk.mdx"), "utf8");
  assert.match(text, /internal\/plugin\/describe\.go/);
  assert.match(text, /Can store and read back data of its own on this server/);
  assert.match(text, /-tags plugindev/);
});
