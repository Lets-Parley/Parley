import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * A weight the app asks for but never imports is a silent failure: the browser
 * synthesizes it by smearing the nearest face, and nothing in the type system,
 * the test suite or the build says a word. That shipped — every `font-bold` in
 * the app was a faux bold over Instrument Sans 600, and the card faces fell
 * back to ui-monospace because mono 400 was never loaded.
 *
 * These are source-level guards because the imports are side-effecting CSS
 * that jsdom does not execute. Crude, and still the cheapest thing that would
 * have caught it.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
const main = readFileSync(path.join(here, "main.tsx"), "utf-8");
const pkgRoot = path.join(here, "..", "node_modules", "@fontsource");

describe("font faces the app actually asks for", () => {
  it("loads the bold Instrument Sans that every font-bold needs", () => {
    expect(main).toContain("@fontsource/instrument-sans/700.css");
  });

  it("loads the regular JetBrains Mono that card faces and labels use", () => {
    expect(main).toContain("@fontsource/jetbrains-mono/400.css");
  });

  it("never asks for a weight the packaged family does not ship", () => {
    // Instrument Sans has no 800, which is why the design's display weight is
    // 700. If a future family does ship one, widen this deliberately.
    const available = new Set(
      readdirSync(path.join(pkgRoot, "instrument-sans"))
        .filter((f) => /^\d+\.css$/.test(f))
        .map((f) => f.replace(".css", "")),
    );
    expect(available.has("800")).toBe(false);
    for (const weight of main.matchAll(/@fontsource\/instrument-sans\/(\d+)\.css/g)) {
      expect(available.has(weight[1])).toBe(true);
    }
  });
});
