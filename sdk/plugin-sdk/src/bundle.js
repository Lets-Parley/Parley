// The .parley bundle format, version 1 (sdk/abi/bundle-v1.md). Output must be
// byte-identical to internal/plugin/bundle; the golden vectors prove it.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { crc32, gunzipSync } from "node:zlib";

const PAYLOAD = new Set(["manifest.json", "plugin.wasm", "ui.js", "slots.json"]);
const SUMS = "MANIFEST.sha256";
const SIG = "MANIFEST.sig";
const CONTEXT = Buffer.from("parley-bundle-v1\n");
const MAX_WASM = 10 << 20;
// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed.
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const byName = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function loadKey(text) {
  const seed = Buffer.from(text.trim(), "base64");
  if (seed.length !== 32) throw new Error("a signing key is the base64 of a 32-byte Ed25519 seed");
  return seed;
}

function privateKey(seed) {
  return createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
}

function publicKey(seed) {
  return Buffer.from(createPublicKey(privateKey(seed)).export({ format: "jwk" }).x, "base64url");
}

export function keyID(seed) {
  return sha256(publicKey(seed)).slice(0, 16);
}

export function keygen() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return {
    key: Buffer.from(jwk.d, "base64url").toString("base64") + "\n",
    pub: Buffer.from(jwk.x, "base64url").toString("base64") + "\n",
  };
}

function octal(n, digits) {
  return n.toString(8).padStart(digits, "0");
}

function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  for (const off of [100, 108, 116, 329, 337]) h.write("0000000", off);
  h.write(octal(size, 11), 124);
  h.write("00000000000", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 6) + "\0 ", 148, "latin1");
  return h;
}

function tar(entries) {
  const parts = [];
  for (const name of Object.keys(entries).sort(byName)) {
    const body = entries[name];
    parts.push(header(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// Stored deflate blocks only, which zlib cannot be told to emit.
function gzip(data) {
  const parts = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])];
  for (let off = 0; off < data.length; off += 65535) {
    const chunk = data.subarray(off, off + 65535);
    const h = Buffer.alloc(5);
    h.writeUInt16LE(chunk.length, 1);
    h.writeUInt16LE(~chunk.length & 0xffff, 3);
    parts.push(h, chunk);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length % 2 ** 32, 4);
  parts.push(Buffer.from([1, 0, 0, 0xff, 0xff]), trailer);
  return Buffer.concat(parts);
}

/** Pack manifest plus files ({name: bytes}); a seed signs it. */
export function pack(manifest, files, seed) {
  const all = { "manifest.json": Buffer.from(manifest) };
  for (const [n, body] of Object.entries(files)) {
    if (!PAYLOAD.has(n) || n === "manifest.json") throw new Error(`${n} is not a bundle file`);
    all[n] = Buffer.from(body);
  }
  if ((all["plugin.wasm"]?.length ?? 0) > MAX_WASM) throw new Error("plugin.wasm is over 10 MiB");
  const sums = Buffer.from(
    Object.keys(all).sort(byName).map((n) => `${sha256(all[n])}  ${n}\n`).join(""),
  );
  const entries = { ...all, [SUMS]: sums };
  if (seed) {
    const sig = edSign(null, Buffer.concat([CONTEXT, sums]), privateKey(seed));
    entries[SIG] = Buffer.concat([publicKey(seed), sig]);
  }
  return gzip(tar(entries));
}

/** Unpack a bundle's entries; no signature check (the server verifies). */
export function readBundle(archive) {
  const t = gunzipSync(archive);
  const entries = {};
  for (let off = 0; off + 512 <= t.length; ) {
    const h = t.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("latin1").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("latin1"), 8);
    entries[name] = Buffer.from(t.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (!entries[SUMS]) throw new Error("not a parley bundle: MANIFEST.sha256 is missing");
  const sig = entries[SIG];
  return {
    entries,
    digest: sha256(entries[SUMS]),
    keyID: sig ? sha256(sig.subarray(0, 32)).slice(0, 16) : "",
  };
}

/** Re-sign a bundle (signed or not) with seed; the result is what pack would write. */
export function sign(archive, seed) {
  const { entries } = readBundle(archive);
  const files = {};
  for (const n of Object.keys(entries)) if (PAYLOAD.has(n) && n !== "manifest.json") files[n] = entries[n];
  return pack(entries["manifest.json"], files, seed);
}
