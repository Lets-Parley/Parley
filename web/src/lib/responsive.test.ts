import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOUCH_HIT } from "./breakpoints";

/**
 * Static guardrails for the mobile contract in #379. These read source text —
 * jsdom has no layout — and catch regressions when someone shrinks a control
 * the pass deliberately enlarged.
 */
const root = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(root, rel), "utf-8");
}

function usesTouchHit(rel: string): void {
  const text = src(rel);
  expect(text, rel).toContain("TOUCH_HIT");
}

describe("responsive touch contract", () => {
  it("uses TOUCH_HIT on modal dismiss, sidebar toggle, and seat remove", () => {
    usesTouchHit("components/Modal.tsx");
    usesTouchHit("components/AppShell.tsx");
    usesTouchHit("components/Table.tsx");
  });

  it("uses TOUCH_HIT on session chrome that must work on a phone", () => {
    for (const file of [
      "components/Hand.tsx",
      "components/ConnectionBanner.tsx",
      "components/StoryQueue.tsx",
      "pages/SpacePage.tsx",
    ]) {
      usesTouchHit(file);
    }
  });

  it("exports the class name the utility applies in CSS", () => {
    expect(TOUCH_HIT).toBe("touch-hit");
    expect(readFileSync(path.join(root, "tokens.css"), "utf-8")).toContain(`.${TOUCH_HIT}`);
  });

  it("gates card hover lift to fine pointers only", () => {
    const css = readFileSync(path.join(root, "tokens.css"), "utf-8");
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.hand-card:hover:not\(:disabled\)/);
  });

  it("pins the hand to the viewport on phones", () => {
    const poker = src("pages/PokerRoom.tsx");
    expect(poker).toMatch(/fixed inset-x-0 bottom-0/);
    expect(poker).toMatch(/lg:sticky lg:bottom-0/);
    expect(poker).toMatch(/pb-44 lg:pb-0/);
  });
});
