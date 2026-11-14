// Fails the production frontend build if Vite inlined a font as a data: URL.
// Production CSP is default-src 'self' with no font-src, so data:font is blocked.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function walk(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

const cssFiles = walk(dist).filter(
  (p) => extname(p).toLowerCase() === ".css",
);
if (cssFiles.length === 0) {
  console.error("check-no-inlined-fonts: no CSS files in web/dist");
  process.exit(1);
}

let failed = false;
for (const file of cssFiles) {
  const text = readFileSync(file, "utf8");
  const idx = text.toLowerCase().indexOf("data:font");
  if (idx === -1) {
    continue;
  }
  const mimeEnd = text.indexOf(";", idx);
  const mime = mimeEnd === -1 ? "data:font" : text.slice(idx, mimeEnd);
  const lookBehind = text.slice(Math.max(0, idx - 240), idx);
  const family = lookBehind.match(/font-family:\s*([^;}{]+)/i);
  const named = family ? family[1].trim() : mime;
  console.error(
    `check-no-inlined-fonts: ${relative(dist, file)} inlined ${named} as ${mime}`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}
