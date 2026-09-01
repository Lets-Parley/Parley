import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BREAKPOINTS, TOUCH_TARGET_MIN, minWidthQuery } from "./breakpoints";

const css = readFileSync(path.resolve(__dirname, "../tokens.css"), "utf-8");

function bpVar(name: string): number {
  const m = css.match(new RegExp(`--bp-${name}:\\s*(\\d+)px`));
  if (!m) throw new Error(`--bp-${name} not found in tokens.css`);
  return Number(m[1]);
}

describe("breakpoints contract", () => {
  it("exports the same min widths as tokens.css", () => {
    expect(BREAKPOINTS.sm.min).toBe(bpVar("sm"));
    expect(BREAKPOINTS.md.min).toBe(bpVar("md"));
    expect(BREAKPOINTS.lg.min).toBe(bpVar("lg"));
  });

  it("documents a 44px touch floor in tokens.css", () => {
    expect(TOUCH_TARGET_MIN).toBe(44);
    expect(css).toMatch(/--touch-min:\s*44px/);
  });

  it("declares safe-area inset variables", () => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(`--safe-${edge}:`);
    }
  });

  it("builds min-width media queries from pixel values", () => {
    expect(minWidthQuery(BREAKPOINTS.md.min)).toBe("(min-width: 768px)");
  });
});
