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
 * have caught it — but a plain substring match would also be satisfied by the
 * import sitting inside a comment or a string, so it has to be matched as a
 * real statement at the start of a line.
 */
function imports(specifier: string): boolean {
  // Matched line by line against a fixed pattern rather than by building a
  // regex out of the specifier. Escaping a string into a pattern is its own
  // small bug surface: the first version's replacement collapsed to a no-op,
  // so every character stood for itself and `.` still matched anything. An
  // exact string comparison cannot go wrong that way, and is stricter.
  return main.split("\n").some((line) => {
    const m = line.match(/^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/);
    return m?.[1] === specifier;
  });
}

const here = path.dirname(new URL(import.meta.url).pathname);
const main = readFileSync(path.join(here, "main.tsx"), "utf-8");
const pkgRoot = path.join(here, "..", "node_modules", "@fontsource");

describe("font faces the app actually asks for", () => {
  it("loads the bold Instrument Sans that every font-bold needs", () => {
    expect(imports("@fontsource/instrument-sans/700.css")).toBe(true);
  });

  it("loads the regular JetBrains Mono that card faces and labels use", () => {
    expect(imports("@fontsource/jetbrains-mono/400.css")).toBe(true);
  });

  it("is not satisfied by a commented-out or quoted import", () => {
    // The hole a plain substring match would leave: this is the same class of
    // mistake as a test that derives its expectation from the code under test.
    expect(imports("@fontsource/instrument-sans/700.css")).toBe(true);
    expect(
      /^\s*\/\/\s*import\s+['"]@fontsource/m.test(main),
    ).toBe(false);
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
