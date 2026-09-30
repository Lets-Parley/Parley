import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pack, sign, readBundle, keygen, keyID, loadKey } from "../src/bundle.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = join(here, "..", "..", "abi", "bundle-v1");
const cli = join(here, "..", "src", "cli.js");
const seed = loadKey(readFileSync(join(vectors, "TEST-ONLY-signing.key"), "utf8"));

function inputs(dir) {
  const files = {};
  for (const n of ["plugin.wasm", "ui.js", "slots.json"]) {
    if (existsSync(join(dir, n))) files[n] = readFileSync(join(dir, n));
  }
  return { manifest: readFileSync(join(dir, "manifest.json")), files };
}

for (const [name, dir] of [["small", vectors], ["large", join(vectors, "large")]]) {
  test(`pack reproduces the ${name} golden vector byte for byte`, () => {
    const { manifest, files } = inputs(join(dir, "input"));
    const out = pack(manifest, files, seed);
    const want = readFileSync(join(dir, "expected.parley"));
    assert.ok(out.equals(want), "packed bytes differ from expected.parley");
    assert.equal(readBundle(out).digest, readFileSync(join(dir, "expected.digest"), "utf8").trim());
  });

  test(`sign turns the unsigned ${name} bundle into the golden vector`, () => {
    const { manifest, files } = inputs(join(dir, "input"));
    const unsigned = pack(manifest, files);
    assert.equal(readBundle(unsigned).keyID, "");
    assert.ok(sign(unsigned, seed).equals(readFileSync(join(dir, "expected.parley"))));
  });
}

test("the key id is the first 8 bytes of sha256(public key)", () => {
  const pub = Buffer.from(readFileSync(join(vectors, "TEST-ONLY-signing.pub"), "utf8").trim(), "base64");
  assert.equal(keyID(seed), createHash("sha256").update(pub).digest("hex").slice(0, 16));
  assert.equal(readBundle(readFileSync(join(vectors, "expected.parley"))).keyID, keyID(seed));
});

test("keygen writes a seed and public key in the reference encoding", () => {
  const k = keygen();
  assert.match(k.key, /^[A-Za-z0-9+/]{43}=\n$/);
  assert.match(k.pub, /^[A-Za-z0-9+/]{43}=\n$/);
  const s = loadKey(k.key);
  const signed = readBundle(pack(Buffer.from("{}"), { "plugin.wasm": Buffer.from("x") }, s));
  assert.equal(signed.keyID, createHash("sha256").update(Buffer.from(k.pub.trim(), "base64")).digest("hex").slice(0, 16));
});

test("pack refuses a name the format does not define", () => {
  assert.throws(() => pack(Buffer.from("{}"), { "evil.sh": Buffer.from("") }), /not a bundle file/);
});

test("cli keygen, pack --key and sign reproduce the golden vector", () => {
  const dir = mkdtempSync(join(tmpdir(), "parley-pack-"));
  try {
    for (const n of ["manifest.json", "plugin.wasm", "ui.js", "slots.json"]) copyFileSync(join(vectors, "input", n), join(dir, n));
    const key = join(vectors, "TEST-ONLY-signing.key");
    const out = join(dir, "out.parley");
    let r = spawnSync(process.execPath, [cli, "pack", dir, "--key", key, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(out).equals(readFileSync(join(vectors, "expected.parley"))));
    const unsigned = join(dir, "u.parley");
    r = spawnSync(process.execPath, [cli, "pack", dir, "--out", unsigned], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [cli, "sign", unsigned, "--key", key], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(unsigned).equals(readFileSync(join(vectors, "expected.parley"))));
    r = spawnSync(process.execPath, [cli, "keygen", join(dir, "dev")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /[0-9a-f]{16}/);
    assert.ok(existsSync(join(dir, "dev.key")) && existsSync(join(dir, "dev.pub")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pack refuses a tar stream over 16 MiB, like the reference MaxTotal", () => {
  const big = { "plugin.wasm": Buffer.alloc(9 << 20), "ui.js": Buffer.alloc(8 << 20) };
  assert.throws(() => pack(Buffer.from("{}"), big), /over 16 MiB/);
});
