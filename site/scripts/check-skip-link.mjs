// src/components/Hero.astro overrides Starlight's Hero and hardcodes the id
// Starlight's SkipLink points at (PAGE_TITLE_ID, "_top"), because Starlight
// does not export it from a public entry point. If an upgrade changes that id,
// nothing breaks at build time — the "Skip to content" link just silently
// stops landing anywhere. This asserts the built HTML still agrees.
import { readFile } from "node:fs/promises";

const page = new URL("../dist/index.html", import.meta.url);
const html = await readFile(page, "utf8");

const fail = (msg) => {
  console.error(
    `\nskip-link guard failed: ${msg}\n` +
      `  page:     site/dist/index.html\n` +
      `  override: site/src/components/Hero.astro (PAGE_TITLE_ID)\n` +
      `  A @astrojs/starlight upgrade changing PAGE_TITLE_ID is the likely cause.\n` +
      `  Fix: set PAGE_TITLE_ID in Hero.astro to Starlight's current value\n` +
      `  (see node_modules/@astrojs/starlight/constants.ts).\n`,
  );
  process.exit(1);
};

const link = html.match(/<a[^>]*class="[^"]*\bsl-skip-link\b[^"]*"[^>]*href="#([^"]+)"/);
if (!link) fail("no element with class sl-skip-link and an href=\"#…\" was rendered");

const expected = link[1];
const target = html.match(new RegExp(`<(\\w+)[^>]*\\sid="${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
if (!target)
  fail(
    `the skip link targets #${expected}, but no element carries id="${expected}"`,
  );
if (target[1] !== "h1")
  fail(
    `the skip link targets #${expected}, but that id is on <${target[1]}>, not the <h1>`,
  );

console.log(`skip-link guard: ok (#${expected} resolves to the <h1>)`);
