import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coveredHeight,
  isBelowAnotherCard,
  arrowLanding,
  dependencyPath,
  inheritedBox,
  permittedScroll,
  scrollClearOfTray,
  scrollRoundBy,
  springSamples,
  tetherPath,
  threadPath,
  type LayoutBox,
} from "./fanMotion";

const boxAt = (left: number): LayoutBox => ({ left, top: 80, width: 180, height: 140 });

function itemWith(attributes: Record<string, string>): HTMLElement {
  const element = document.createElement("li");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

it("samples a spring that starts at rest, overshoots when lightly damped, and always ends on its target", () => {
  const lively = springSamples({ stiffness: 230, damping: 19 });
  expect(lively[0]).toBe(0);
  expect(lively[lively.length - 1]).toBe(1);
  expect(Math.max(...lively)).toBeGreaterThan(1.03);
  expect(Math.max(...lively)).toBeLessThan(1.2);
  const firm = springSamples({ stiffness: 320, damping: 36 });
  expect(Math.max(...firm)).toBeLessThan(1.01);
  expect(lively.length).toBeLessThanOrEqual(86);
});

it("keeps a tether on its strip and on its card however far the thread sways", () => {
  const swaying = tetherPath(400, 50, 120, 130, 40, -12);
  expect(swaying.startsWith("M400,50 ")).toBe(true);
  expect(swaying.endsWith(" 120,130")).toBe(true);
  expect(swaying).not.toBe(tetherPath(400, 50, 120, 130));
});

it("ends a dependency thread in a straight stem so the arrowhead points the way the line travels", () => {
  const path = threadPath({ x: 100, y: 240 }, { x: 320, y: 232 }, 18);
  expect(path.endsWith(" 320,250 L320,232")).toBe(true);
});

it("previews a dragged link on the exact line the saved arc will take", () => {
  const blocker = { centerX: 110, top: 90, bottom: 230, width: 170 };
  const dependent = { centerX: 300, top: 90, bottom: 230, width: 170 };
  const landing = arrowLanding(blocker, dependent, 1, 2);
  expect(landing.y).toBe(232);
  expect(threadPath({ x: 110, y: 238 }, landing, 18)).toBe(dependencyPath(blocker, dependent, 1, 2, 8));
});

it("draws a link down to a story on a lower row, landing on its top edge from a straight stem", () => {
  const blocker = { centerX: 110, top: 90, bottom: 230, width: 170 };
  const dependent = { centerX: 300, top: 294, bottom: 434, width: 170 };
  const path = dependencyPath(blocker, dependent, 0, 1, 8);
  const landingX = arrowLanding(blocker, dependent, 0, 1).x;
  expect(path.startsWith("M110,238 ")).toBe(true);
  expect(path.endsWith(` ${landingX},274 L${landingX},292`)).toBe(true);
});

it("draws a link up to a story on a higher row, leaving the lower card's top edge beside its tether and landing from a straight stem", () => {
  const blocker = { centerX: 300, top: 294, bottom: 434, width: 170 };
  const dependent = { centerX: 110, top: 90, bottom: 230, width: 170 };
  const path = dependencyPath(blocker, dependent, 0, 1, 8);
  const landingX = arrowLanding(blocker, dependent, 0, 1).x;
  expect(path.startsWith(`M${300 - 170 * 0.28},286 `)).toBe(true);
  expect(path.endsWith(` ${landingX},250 L${landingX},232`)).toBe(true);
});

it("hands the card being written to the story it becomes, once, and deals a fresh blank after it", () => {
  const before = new Map([
    ["API", boxAt(0)],
    ["ghost:1", boxAt(200)],
  ]);
  const presentKeys = new Set(["API", "UI", "ghost:2"]);
  const claimedKeys = new Set<string>();
  const story = itemWith({ "data-fan-item": "UI", "data-fan-heir": "ghost:1" });
  const nextBlank = itemWith({ "data-fan-item": "ghost:2", "data-fan-ghost": "" });
  expect(inheritedBox(story, before, presentKeys, claimedKeys)).toEqual(boxAt(200));
  expect(inheritedBox(nextBlank, before, presentKeys, claimedKeys)).toBeUndefined();
  expect(inheritedBox(itemWith({ "data-fan-item": "Late", "data-fan-heir": "ghost:1" }), before, presentKeys, claimedKeys)).toBeUndefined();
});

it("keeps the blank card where it was when a story is removed rather than dealing it again", () => {
  const before = new Map([["ghost:3", boxAt(600)]]);
  const blank = itemWith({ "data-fan-item": "ghost:2", "data-fan-ghost": "" });
  expect(inheritedBox(blank, before, new Set(["ghost:2"]), new Set())).toEqual(boxAt(600));
});

it("draws no strip tether to a card that sits under another card, because the line would cross it", () => {
  const firstRow = [{ top: 100, bottom: 240 }, { top: 100, bottom: 240 }];
  expect(isBelowAnotherCard(firstRow[0], firstRow)).toBe(false);
  expect(isBelowAnotherCard({ top: 254 }, firstRow)).toBe(true);
  expect(isBelowAnotherCard({ top: 100 }, [])).toBe(false);
});

it("measures how much of the round's controls the hand tray covers, and nothing when they are clear", () => {
  expect(coveredHeight({ bottom: 880 }, { top: 800 })).toBe(80);
  expect(coveredHeight({ bottom: 640 }, { top: 800 })).toBe(0);
});

describe("moving the page for the round", () => {
  const area = { top: 0, bottom: 600 };

  it("never moves a control that must stay in view out of the area above the tray", () => {
    expect(permittedScroll(300, [{ top: 100, bottom: 144 }], area)).toBe(88);
    expect(permittedScroll(300, [{ top: 8, bottom: 52 }], area)).toBe(0);
    expect(permittedScroll(40, [{ top: 100, bottom: 144 }], area)).toBe(40);
    expect(permittedScroll(-300, [{ top: 400, bottom: 520 }], area)).toBe(-68);
    expect(permittedScroll(-300, [{ top: -200, bottom: -156 }], area)).toBe(-300);
    expect(permittedScroll(300, [{ top: 500, bottom: 544 }, { top: 60, bottom: 104 }], area)).toBe(48);
    expect(permittedScroll(300, [], area)).toBe(300);
  });

  describe("in the page", () => {
    let scrolled: ReturnType<typeof vi.fn>;
    const originalScrollBy = window.scrollBy;
    beforeEach(() => {
      scrolled = vi.fn();
      window.scrollBy = scrolled as unknown as typeof window.scrollBy;
    });
    afterEach(() => {
      window.scrollBy = originalScrollBy;
      document.body.innerHTML = "";
      vi.restoreAllMocks();
    });
    function place(element: HTMLElement, top: number, height: number) {
      element.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    }

    it("stops short of pushing the round's primary control out of view", () => {
      document.body.innerHTML = `<span data-round-verdict><button>Save</button></span><div id="results"></div><div data-poker-hand style="position:fixed"></div>`;
      place(document.querySelector("button")!, 120, 44);
      place(document.querySelector("[data-poker-hand]")!, 600, 200);
      scrollRoundBy(400);
      expect(scrolled).toHaveBeenCalledWith({ top: 108 });
    });

    it("keeps whatever has focus in view as well", () => {
      document.body.innerHTML = `<button id="focused">Hide the split</button><span data-round-verdict><button>Save</button></span>`;
      const focused = document.querySelector<HTMLElement>("#focused")!;
      place(focused, 40, 44);
      place(document.querySelector("[data-round-verdict] button")!, 300, 44);
      focused.focus();
      scrollRoundBy(400);
      expect(scrolled).toHaveBeenCalledWith({ top: 28 });
    });

    it("does not move the page at all while someone is typing or a dialog is open", () => {
      document.body.innerHTML = `<input id="field" /><dialog open><button id="inside">Cancel</button></dialog><span data-round-verdict><button>Save</button></span>`;
      place(document.querySelector("[data-round-verdict] button")!, 300, 44);
      place(document.querySelector("#field")!, 400, 44);
      place(document.querySelector("#inside")!, 400, 44);
      document.querySelector<HTMLElement>("#field")!.focus();
      scrollRoundBy(200);
      document.querySelector<HTMLElement>("#inside")!.focus();
      scrollRoundBy(200);
      expect(scrolled).not.toHaveBeenCalled();
    });

    it("does not push a question's own heading off the top when the whole question fits", () => {
      document.body.innerHTML = `<section id="question"></section><div data-poker-hand></div>`;
      place(document.querySelector("#question")!, 40, 590);
      place(document.querySelector("[data-poker-hand]")!, 600, 200);
      scrollClearOfTray(document.querySelector("#question"));
      expect(scrolled).toHaveBeenCalledWith({ top: 28 });
    });

    it("brings a question clear of the tray only as far as the primary control allows", () => {
      document.body.innerHTML = `<span data-round-verdict><button>Next story</button></span><section id="question"></section><div data-poker-hand></div>`;
      place(document.querySelector("[data-round-verdict] button")!, 60, 44);
      place(document.querySelector("#question")!, 500, 200);
      place(document.querySelector("[data-poker-hand]")!, 600, 200);
      scrollClearOfTray(document.querySelector("#question"));
      expect(scrolled).toHaveBeenCalledWith({ top: 48 });
    });
  });
});
