// Renders the portrait legibility contact sheet: all thirty portraits at the
// two sizes Parley actually draws them — 38px in the picker preview, 46px in a
// seat — inside the identity-hue disc, on --color-surface, once per theme.
//
//   cd web
//   npm install --no-save @resvg/resvg-js
//   node scripts/portrait-contact-sheet.mjs
//
// Writes site/src/assets/portrait-legibility-{light,dark}.png. resvg is not a
// dependency and not a build step: this runs by hand when the art changes.
//
// Pass --scale=4 to get an oversampled copy for close inspection; the committed
// sheets are 1:1, because a portrait that only reads when magnified does not
// pass.

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const artDir = join(repo, "web", "src", "assets", "avatars");
const outDir = join(repo, "site", "src", "assets");

const scale = Number(process.argv.find((a) => a.startsWith("--scale="))?.slice(8) ?? 1);

/** The two themes' token values, read from the stylesheet rather than guessed. */
function tokens() {
  const css = readFileSync(join(repo, "web", "src", "tokens.css"), "utf8");
  const block = (start) => {
    const at = css.indexOf(start);
    return css.slice(at, css.indexOf("}", at));
  };
  const pick = (text, name) => text.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
  const light = block(":root {");
  const dark = block(':root[data-theme="dark"] {');
  return {
    light: { surface: pick(light, "surface"), ink: pick(light, "ink"), line: pick(light, "line") },
    dark: { surface: pick(dark, "surface"), ink: pick(dark, "ink"), line: pick(dark, "line") },
  };
}

/** oklch(0.52 0.09 H) — the chip background from Avatar.tsx — as sRGB hex. */
function chipHue(hueDeg) {
  const [l, c, h] = [0.52, 0.09, (hueDeg * Math.PI) / 180];
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
    -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
    -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
  ];
  return (
    "#" +
    lin
      .map((v) => {
        const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, s)) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

/** Inline one portrait, namespacing its single-letter ids so thirty can share a document. */
function portrait(id, x, y, px) {
  const raw = readFileSync(join(artDir, `${id}.svg`), "utf8");
  const inner = raw
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/id="([^"]+)"/g, `id="${id}-$1"`)
    .replace(/href="#([^"]+)"/g, `href="#${id}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${id}-$1)`);
  const clip = `${id}-clip${px}`;
  return `<clipPath id="${clip}"><circle cx="${x + px / 2}" cy="${y + px / 2}" r="${px / 2}"/></clipPath>
    <g clip-path="url(#${clip})">
      <circle cx="${x + px / 2}" cy="${y + px / 2}" r="${px / 2}" fill="${chipHue(185 + (hueOf(id) / 360) * 105)}"/>
      <svg x="${x}" y="${y}" width="${px}" height="${px}" viewBox="22 10 92 92">${inner}</svg>
    </g>`;
}

/** A stable per-id hue, so the sheet spreads the whole 185°–290° arc rather than one colour. */
function hueOf(id) {
  return (ids.indexOf(id) * 360) / ids.length;
}

const ids = readdirSync(artDir)
  .filter((f) => f.endsWith(".svg"))
  .map((f) => f.replace(/\.svg$/, ""))
  .sort();

const COLS = 6;
const CELL_W = 132;
const CELL_H = 102;
const PAD = 20;
const HEAD = 46;
const rows = Math.ceil(ids.length / COLS);
const W = PAD * 2 + COLS * CELL_W;
const H = PAD + HEAD + rows * CELL_H;

function sheet(theme, t) {
  const cells = ids.map((id, i) => {
    const x = PAD + (i % COLS) * CELL_W;
    const y = PAD + HEAD + Math.floor(i / COLS) * CELL_H;
    return `<text x="${x}" y="${y + 10}" font-family="monospace" font-size="11" fill="${t.ink}">${id}</text>
      ${portrait(id, x, y + 18, 46)}
      ${portrait(id, x + 58, y + 26, 38)}
      <text x="${x}" y="${y + 78}" font-family="monospace" font-size="9" fill="${t.line}">46</text>
      <text x="${x + 58}" y="${y + 78}" font-family="monospace" font-size="9" fill="${t.line}">38</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${t.surface}"/>
    <text x="${PAD}" y="${PAD + 14}" font-family="monospace" font-size="13" fill="${t.ink}">Parley portraits — ${theme} theme, on --color-surface ${t.surface}</text>
    <text x="${PAD}" y="${PAD + 30}" font-family="monospace" font-size="11" fill="${t.line}">left 46px (seat) · right 38px (picker preview) · 1:1</text>
    ${cells.join("\n")}
  </svg>`;
}

const t = tokens();
for (const theme of ["light", "dark"]) {
  const png = new Resvg(sheet(theme, t[theme]), {
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  const name = `portrait-legibility-${theme}${scale === 1 ? "" : `@${scale}x`}.png`;
  const dest = scale === 1 ? join(outDir, name) : join(process.cwd(), name);
  writeFileSync(dest, png);
  console.log(`${dest} — ${png.length} bytes`);
}
