import { afterEach, describe, expect, it, vi } from "vitest";
import { flipDeltas, releaseFlip } from "./flip";
import { measureSeats, translationOf } from "./measure";

/*
 * jsdom has no layout, so every rect here is stubbed. That is the point: the
 * seam being pinned is not "does the row lay out correctly" — it is that a
 * seat measured while an earlier FLIP is still running must report the
 * position it is laid out at, not the one it is momentarily painted at.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** A rank container of seats at known layout lefts, optionally mid-flight. */
function rank(seats: { id: string; layoutLeft: number; transform?: string }[]) {
  const container = document.createElement("div");
  const styles = new Map<Element, string>();
  for (const s of seats) {
    const el = document.createElement("div");
    el.dataset.seatUser = s.id;
    const shift = translationOf(s.transform);
    el.getBoundingClientRect = () =>
      ({ left: s.layoutLeft + shift.x, top: shift.y }) as DOMRect;
    styles.set(el, s.transform ?? "none");
    container.append(el);
  }
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (el: Element) => ({ transform: styles.get(el) ?? "none" }) as CSSStyleDeclaration,
  );
  document.body.append(container);
  return container;
}

describe("translationOf", () => {
  it("reads a 2D matrix's translation", () => {
    expect(translationOf("matrix(1, 0, 0, 1, -43, 7)")).toEqual({ x: -43, y: 7 });
  });

  it("reads a 3D matrix's translation", () => {
    expect(
      translationOf("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, -43,7,0,1)"),
    ).toEqual({ x: -43, y: 7 });
  });

  it("treats no transform, and anything unparseable, as no translation", () => {
    for (const t of ["none", "", null, undefined, "rotate(4deg)", "matrix(a,b)"])
      expect(translationOf(t)).toEqual({ x: 0, y: 0 });
  });
});

describe("measureSeats", () => {
  it("reports where a seat is laid out, not where it is painted", () => {
    // u0 is laid out at 466.5 but is 43px to the right of that on this frame,
    // because its own release animation has barely started.
    const el = rank([{ id: "u0", layoutLeft: 466.5, transform: "matrix(1, 0, 0, 1, 43, 0)" }]);
    expect(el.querySelector("[data-seat-user]")!.getBoundingClientRect().left).toBe(509.5);
    expect(measureSeats(el).get("u0")).toEqual({ left: 466.5, top: 0 });
  });
});

describe("a second render inside one FLIP window", () => {
  it("does not relaunch a moving seat from the far side of its destination", () => {
    // The join: three seats shift 43px left to make room for a fourth.
    const before = rank([
      { id: "u0", layoutLeft: 509.5 },
      { id: "u1", layoutLeft: 595.5 },
    ]);
    let boxes = measureSeats(before);

    const after = rank([
      { id: "u0", layoutLeft: 466.5 },
      { id: "u1", layoutLeft: 552.5 },
      { id: "u2", layoutLeft: 724.5 },
    ]);
    const first = flipDeltas(boxes, measureSeats(after));
    // A seat that moved LEFT is pushed back to the RIGHT to start from.
    expect(first.get("u0")).toEqual({ dx: 43, dy: 0 });
    releaseFlip(after, first, 260);
    const u0 = after.querySelector<HTMLElement>('[data-seat-user="u0"]')!;
    expect(u0.style.getPropertyValue("--flip-dx")).toBe("43.00px");
    boxes = measureSeats(after);

    // The very next render, five milliseconds later, with u0 still animating
    // and therefore still painted at 509.5.
    const midFlight = rank([
      { id: "u0", layoutLeft: 466.5, transform: "matrix(1, 0, 0, 1, 43, 0)" },
      { id: "u1", layoutLeft: 552.5, transform: "matrix(1, 0, 0, 1, 43, 0)" },
      { id: "u2", layoutLeft: 724.5 },
    ]);
    expect(flipDeltas(boxes, measureSeats(midFlight)).size).toBe(0);
  });
});

describe("releaseFlip", () => {
  it("hands a seat that moved left a positive --flip-dx", () => {
    const el = rank([{ id: "u0", layoutLeft: 466.5 }]);
    releaseFlip(el, flipDeltas(new Map([["u0", { left: 509.5, top: 0 }]]), measureSeats(el)), 260);
    const u0 = el.querySelector<HTMLElement>('[data-seat-user="u0"]')!;
    expect(u0.style.getPropertyValue("--flip-dx")).toBe("43.00px");
    expect(u0.style.animation).toContain("seat-flip-release 260ms");
  });

  it("hands a seat that moved right a negative --flip-dx", () => {
    const el = rank([{ id: "u0", layoutLeft: 552.5 }]);
    releaseFlip(el, flipDeltas(new Map([["u0", { left: 509.5, top: 0 }]]), measureSeats(el)), 260);
    expect(
      el.querySelector<HTMLElement>('[data-seat-user="u0"]')!.style.getPropertyValue("--flip-dx"),
    ).toBe("-43.00px");
  });
});
