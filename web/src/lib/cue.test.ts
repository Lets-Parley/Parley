import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CUE_LIGHT_ENABLED, CUE_STATES, arcStep, cueFor, cueRank, type Theme } from "./cue";

// Read off disk rather than imported: vitest stubs CSS imports to an empty
// string, and the whole point is the literal hex as it is written in the file.
const css = readFileSync(resolve(process.cwd(), "src/tokens.css"), "utf8");

/** The custom properties declared in one block of tokens.css, as literal hex. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector} block in tokens.css`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2].toUpperCase();
  return out;
}

const themes: Record<Theme, Record<string, string>> = {
  light: block(":root {"),
  dark: block(':root[data-theme="dark"]'),
};

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the cue arc", () => {
  // Criterion 1. This is a TOKEN-FREEZE REGRESSION GUARD, not an AA floor: AA
  // is 4.5:1 and the whole arc clears it by miles. The numbers below are the
  // measured minimum of the arc as shipped, so a typo'd hex, a dropped theme
  // branch or a re-pointed endpoint fails here loudly.
  it.each(["light", "dark"] as Theme[])("clears its measured floor in %s", (theme) => {
    const t = themes[theme];
    for (const state of CUE_STATES) {
      const ground = t[`--cue-${state}`];
      expect(ground, `--cue-${state} missing from ${theme}`).toBeTruthy();
      expect(contrast(ground, t["--color-ink"])).toBeGreaterThanOrEqual(11.5);
      expect(contrast(ground, t["--color-ink-soft"])).toBeGreaterThanOrEqual(5.0);
    }
  });

  // The test never restates the interpolation: arcStep is the only place it
  // lives, and tokens.css is checked against it.
  it.each(["light", "dark"] as Theme[])("matches tokens.css literally in %s", (theme) => {
    CUE_STATES.forEach((state, i) => {
      expect(themes[theme][`--cue-${state}`]).toBe(arcStep(theme, i));
    });
  });

  it("starts and ends on existing ground tokens", () => {
    expect(arcStep("dark", 0)).toBe(themes.dark["--color-felt"]);
    expect(arcStep("dark", 3)).toBe(themes.dark["--color-surface-hi"]);
    expect(arcStep("light", 0)).toBe(themes.light["--color-felt-deep"]);
    expect(arcStep("light", 3)).toBe(themes.light["--color-surface-hi"]);
  });

  it("brightens monotonically in both themes", () => {
    for (const theme of ["light", "dark"] as Theme[]) {
      const ls = CUE_STATES.map((_, i) => luminance(arcStep(theme, i)));
      for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    }
  });
});

describe("cueFor", () => {
  it("sits at overcast with nobody voted", () => {
    expect(cueFor(0, 5, false)).toBe("overcast");
  });

  it("reaches first light on the first vote of a big table", () => {
    expect(cueFor(1, 5, false)).toBe("first-light");
  });

  it("reaches daybreak at a third of the table", () => {
    expect(cueFor(2, 5, false)).toBe("daybreak");
  });

  it("holds a fully voted but unrevealed table at daybreak", () => {
    // The bug this replaces wrote DAYBREAK as `0.34 <= r < 1`, so r=1 with
    // revealed=false fell through every branch and matched nothing.
    expect(cueFor(5, 5, false)).toBe("daybreak");
  });

  it("reaches day only through the reveal", () => {
    expect(cueFor(0, 5, true)).toBe("day");
    expect(cueRank(cueFor(5, 5, false))).toBeLessThan(cueRank("day"));
  });

  it("does not divide by an empty table", () => {
    expect(cueFor(0, 0, false)).toBe("overcast");
  });
});

describe("the cut", () => {
  it("is one constant, and it is currently on", () => {
    // Flip CUE_LIGHT_ENABLED to false and the field collapses to one static
    // token; the accumulator returns null and the count text loses its suffix.
    expect(CUE_LIGHT_ENABLED).toBe(true);
  });
});
