import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("scaffold, build, and verify commands exist", () => {
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  for (const cmd of ["scaffold", "dev", "build", "verify"]) {
    assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
  }
});

test("scaffold writes a manifest at protocol 1 and verify accepts it", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    const sc = run("scaffold", dir);
    assert.equal(sc.status, 0, sc.stderr + sc.stdout);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.manifest, 1);
    assert.equal(pkg.kind, "plugin");
    const built = run("build", dir);
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const verified = run("verify", dir);
    assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify refuses a Python guest PDK claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    run("scaffold", dir);
    writeFileSync(join(dir, "guest.py"), "print('no')\n");
    const verified = run("verify", dir);
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr + verified.stdout, /python/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
