#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { keyID, keygen, loadKey, pack, readBundle, sign } from "./bundle.js";
import { generateSettingsTypes } from "./settings.js";

const commands = ["scaffold", "dev", "build", "verify", "keygen", "pack", "sign", "types"];

function usage() {
  return `parley-plugin <${commands.join("|")}> [dir|file] [options]

scaffold  write a JavaScript guest plugin
build     copy UI into dist/<name>-<version>.ui.js
verify    check the manifest, exports, and that no Python guest is present
keygen    write <path>.key (secret) and <path>.pub, print the key id
pack      write dist/<name>-<version>.parley from manifest.json, plugin.wasm,
          ui.js and slots.json (--key <file> signs it, --out <file>)
sign      sign a .parley in place (--key <file>, --out <file>)
types     print TypeScript for the manifest's settings schema
dev       pack, sign with a local dev key (--key, or ~/.config/parley/dev.key,
          created on first use; --unsigned skips signing), upload to
          $BASE_URL/api/catalog/bundles as $PARLEY_SESSION, print the install link
`;
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { key: { type: "string" }, out: { type: "string" }, unsigned: { type: "boolean" } },
});
const [cmd, dirArg] = positionals;
const dir = dirArg || process.cwd();

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  process.stdout.write(usage());
  process.exit(0);
}

if (!commands.includes(cmd)) {
  process.stderr.write(usage());
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});

async function main() {
  if (cmd === "scaffold") scaffold(dir);
  else if (cmd === "verify") verify(dir);
  else if (cmd === "build") build(dir);
  else if (cmd === "dev") await dev(dir);
  else if (cmd === "keygen") keygenCmd(dirArg || "parley-signing");
  else if (cmd === "pack") packCmd(dir);
  else if (cmd === "sign") signCmd(dirArg);
  else if (cmd === "types") process.stdout.write(generateSettingsTypes(readPkg(dir)));
}

function writeKey(path) {
  const k = keygen();
  mkdirSync(dirname(path + ".key"), { recursive: true });
  writeFileSync(path + ".key", k.key, { mode: 0o600, flag: "wx" });
  writeFileSync(path + ".pub", k.pub);
  return k;
}

function keygenCmd(path) {
  const k = writeKey(path);
  process.stdout.write(`${path}.key  keep secret\n${path}.pub  ${k.pub.trim()}\nkey id ${keyID(loadKey(k.key))}\n`);
}

function seedFrom(path) {
  return path ? loadKey(readFileSync(path, "utf8")) : undefined;
}

function report(out, archive) {
  const b = readBundle(archive);
  process.stdout.write(`${out}\ndigest ${b.digest}\nkey id ${b.keyID || "(unsigned)"}\n`);
  return b;
}

// A manifest.json is packed as its exact bytes; a legacy package.json is re-serialized.
function packArchive(root, seed) {
  const pkg = readPkg(root);
  const m = join(root, "manifest.json");
  const manifest = existsSync(m) ? readFileSync(m) : Buffer.from(JSON.stringify(pkg));
  const files = {};
  for (const n of ["plugin.wasm", "ui.js", "slots.json"]) {
    if (existsSync(join(root, n))) files[n] = readFileSync(join(root, n));
  }
  if (!files["plugin.wasm"]) throw new Error(`${join(root, "plugin.wasm")} is missing; build the guest first`);
  return { pkg, archive: pack(manifest, files, seed) };
}

function packCmd(root) {
  const { pkg, archive } = packArchive(root, seedFrom(opts.key));
  const out = opts.out || join(root, "dist", `${pkg.name}-${pkg.version}.parley`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, archive);
  report(out, archive);
}

function signCmd(file) {
  if (!file || !opts.key) throw new Error("usage: parley-plugin sign <bundle.parley> --key <file>");
  const out = opts.out || file;
  const bytes = sign(readFileSync(file), seedFrom(opts.key));
  writeFileSync(out, bytes);
  report(out, bytes);
}

function scaffold(root) {
  mkdirSync(root, { recursive: true });
  const name = "example";
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        manifest: 1,
        kind: "plugin",
        name,
        version: "0.1.0",
        quotaBytes: 1048576,
        capabilities: [{ capability: "kv", scope: "board" }],
        kinds: [
          {
            kind: name,
            display: "Example",
            actions: [{ name: "ping", verb: "POST" }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(root, "guest.js"),
    `function on_session_state() {
  Host.outputString(JSON.stringify({ ok: true }));
}
function on_session_action() {
  Host.outputString("{}");
}
module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
`,
  );
  writeFileSync(
    join(root, "guest.d.ts"),
    `declare module "main" {
  export function on_session_state(): I32;
  export function on_session_action(): I32;
}
`,
  );
  writeFileSync(
    join(root, "ui.js"),
    `document.body.className = "parley-panel";
document.body.textContent = "example plugin";
`,
  );
}

function readPkg(root) {
  const m = join(root, "manifest.json");
  return JSON.parse(readFileSync(existsSync(m) ? m : join(root, "package.json"), "utf8"));
}

function verify(root) {
  const pkg = readPkg(root);
	if (pkg.manifest !== 1) throw new Error("the manifest version must be 1");
	if (pkg.kind !== "plugin") throw new Error('the kind must be "plugin"');
	const allowed = new Set(["panel", "room", "toolbar", "nav", "export-menu"]);
	for (const slot of pkg.slots || []) {
		if (!allowed.has(slot)) {
			throw new Error(`${slot} is not a UI slot; must be panel, room, toolbar, nav or export-menu`);
		}
	}
  const names = readdirSync(root);
  if (names.some((n) => n.endsWith(".py"))) {
    throw new Error("Python is not an Extism guest PDK");
  }
  if (!existsSync(join(root, "guest.js")) && !existsSync(join(root, "guest.go")) &&
      !existsSync(join(root, "guest.rs")) && !existsSync(join(root, "guest.zig"))) {
    throw new Error("a guest source file is missing");
  }
}

function build(root) {
  verify(root);
  const pkg = readPkg(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const stem = `${pkg.name}-${pkg.version}`;
  if (existsSync(join(root, "ui.js"))) {
    writeFileSync(join(dist, stem + ".ui.js"), readFileSync(join(root, "ui.js")));
  }
  if (Array.isArray(pkg.slots)) {
    writeFileSync(join(dist, stem + ".slots.json"), JSON.stringify(pkg.slots) + "\n");
  }
}

async function dev(root) {
  verify(root);
  let seed;
  if (!opts.unsigned) {
    const keyPath = opts.key || join(homedir(), ".config", "parley", "dev.key");
    if (!existsSync(keyPath)) {
      const k = writeKey(keyPath.replace(/\.key$/, ""));
      process.stderr.write(`created a dev key; trust it with PLUGIN_TRUSTED_KEYS=${k.pub.trim()}\n`);
    }
    seed = seedFrom(keyPath);
  }
  const { archive } = packArchive(root, seed);
  const base = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  const org = process.env.PARLEY_ORG || "default";
  const headers = { "Content-Type": "application/vnd.parley.bundle" };
  if (process.env.PARLEY_SESSION) headers.Cookie = `parley_session=${process.env.PARLEY_SESSION}`;
  const res = await fetch(`${base}/api/catalog/bundles`, { method: "POST", headers, body: archive });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `upload ${res.status}: ${text}\n` +
        "sign in as an instance curator and set PARLEY_SESSION to your parley_session cookie; " +
        "the instance must trust the dev key (PLUGIN_TRUSTED_KEYS) or, locally, run with PLUGIN_ALLOW_UNSIGNED=true and --unsigned",
    );
  }
  const b = readBundle(archive);
  process.stdout.write(`uploaded ${b.digest} (key ${b.keyID || "unsigned"})\ninstall: ${base}/o/${org}/admin/plugins?install=${b.digest}/${b.keyID}\n`);
}
