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
  for (const cmd of ["scaffold", "dev", "build", "verify", "keygen", "pack", "sign", "types"]) {
    assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
  }
});

test("scaffold writes a manifest at protocol 1 and verify accepts it", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    const sc = run("scaffold", dir);
    assert.equal(sc.status, 0, sc.stderr + sc.stdout);
    const pkg = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
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

test("verify refuses an unknown UI slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    run("scaffold", dir);
    const pkg = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    pkg.slots = ["notifications"];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(pkg, null, 2) + "\n");
    const verified = run("verify", dir);
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr + verified.stdout, /notifications/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build writes declared chrome slots beside the UI bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    run("scaffold", dir);
    const pkg = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    pkg.slots = ["toolbar", "nav", "export-menu"];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(pkg, null, 2) + "\n");
    const built = run("build", dir);
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const slots = JSON.parse(readFileSync(join(dir, "dist", `${pkg.name}-${pkg.version}.slots.json`), "utf8"));
    assert.deepEqual(slots, ["toolbar", "nav", "export-menu"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify refuses any Python source, not only guest.py", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-plugin-"));
  try {
    run("scaffold", dir);
    writeFileSync(join(dir, "helper.py"), "print('no')\n");
    const verified = run("verify", dir);
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr + verified.stdout, /python/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev packs, signs with the given key, uploads to the catalog and prints the install link", async () => {
  const { createServer } = await import("node:http");
  const { readBundle } = await import("../src/bundle.js");
  const dir = mkdtempSync(join(tmpdir(), "parley-dev-"));
  let got;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got = { url: req.url, type: req.headers["content-type"], cookie: req.headers.cookie, body: Buffer.concat(chunks) };
      res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(run("scaffold", dir).status, 0);
    writeFileSync(join(dir, "plugin.wasm"), "\0asm");
    const key = join(dirname(cli), "..", "..", "abi", "bundle-v1", "TEST-ONLY-signing.key");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [cli, "dev", dir, "--key", key], {
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, PARLEY_SESSION: "tok" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, out);
    assert.equal(got.url, "/api/catalog/bundles");
    assert.equal(got.type, "application/vnd.parley.bundle");
    assert.equal(got.cookie, "parley_session=tok");
    const b = readBundle(got.body);
    assert.ok(b.entries["plugin.wasm"]);
    assert.match(out, new RegExp(`/o/default/admin/plugins\\?install=${b.digest}/${b.keyID}`));
    assert.notEqual(b.keyID, "");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
