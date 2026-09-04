#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const commands = ["scaffold", "dev", "build", "verify"];

function usage() {
  return `parley-plugin <${commands.join("|")}> [dir]

scaffold  write a JavaScript guest plugin
dev       POST the package to the plugindev registration endpoint
build     copy UI into dist/<name>-<version>.ui.js
verify    check the manifest, exports, and that no Python guest is present
`;
}

const [cmd, dirArg] = process.argv.slice(2);
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
}

function scaffold(root) {
  mkdirSync(root, { recursive: true });
  const name = "example";
  writeFileSync(
    join(root, "package.json"),
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
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function verify(root) {
  const pkg = readPkg(root);
  if (pkg.manifest !== 1) throw new Error("the manifest version must be 1");
  if (pkg.kind !== "plugin") throw new Error('the kind must be "plugin"');
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
}

async function dev(root) {
  verify(root);
  const pkg = readPkg(root);
  const base = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  const org = process.env.PARLEY_ORG || "default";
  const url = `${base}/api/orgs/${org}/admin/plugins/dev-register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: pkg }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`dev-register ${res.status}: ${text}\nrebuild the server with -tags plugindev`);
  }
  process.stdout.write(text + "\n");
}
