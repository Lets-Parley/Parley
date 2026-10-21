#!/usr/bin/env node
// Renders an SVG to one or more exact-size PNGs using headless Chromium.
//
// Why not ImageMagick: its built-in SVG delegate mis-renders
// `transform="rotate(angle cx cy)"` on a shape — it clipped and
// mispositioned the two playing cards in web/public/favicon.svg, so every
// icon and the card banner came out wrong (verified by eye against the
// same SVG rendered in a real browser). Chromium's SVG rendering is the
// spec-correct one, so it's used instead. See README.md for how to set up
// its two dependencies.
//
// The SVG's own root width/height are overridden to each spec's size, so
// its viewBox scales the whole drawing uniformly.
//
// Usage: node render.mjs <svg-file> <out-file>:<width>x<height>[,...]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const [, , svgFile, specArg] = process.argv;
if (!svgFile || !specArg) {
  console.error("usage: render.mjs <svg-file> <out-file>:<width>x<height>[,...]");
  process.exit(1);
}

const playwrightDir = process.env.PLAYWRIGHT_CORE_DIR;
if (!playwrightDir) {
  console.error("set PLAYWRIGHT_CORE_DIR to a directory with playwright-core installed (see README.md)");
  process.exit(1);
}
const chromiumPath = process.env.CHROMIUM_PATH;
if (!chromiumPath) {
  console.error("set CHROMIUM_PATH to a Chromium executable (see README.md)");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [playwrightDir] }));

const svgSource = readFileSync(svgFile, "utf8");
const specs = specArg.split(",").map((entry) => {
  const [out, dims] = entry.split(":");
  const [width, height] = dims.split("x").map(Number);
  return { out, width, height };
});

const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  for (const { out, width, height } of specs) {
    await page.setViewportSize({ width, height });
    const svg = svgSource
      .replace(/width="[\d.]+"/, `width="${width}"`)
      .replace(/height="[\d.]+"/, `height="${height}"`);
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
      { waitUntil: "load" }
    );
    await page.screenshot({ path: out, omitBackground: true });
    console.error(`rendered ${out} (${width}x${height})`);
  }
} finally {
  await browser.close();
}
