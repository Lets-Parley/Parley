import { describe, expect, it } from "vitest";
import { flipDeltas } from "./flip";

/*
 * Hand-built rects, never real layout: jsdom returns all-zero boxes, so a FLIP
 * tested against a rendered row would pass without testing anything.
 */
const box = (left: number, top: number) => ({ left, top });

describe("flipDeltas", () => {
  it("inverts a seat's move, so it starts where it used to be", () => {
    const first = new Map([["dana", box(100, 0)]]);
    const last = new Map([["dana", box(186, 0)]]);
    expect(flipDeltas(first, last).get("dana")).toEqual({ dx: -86, dy: 0 });
  });

  it("carries a wrap onto the next rank in both axes", () => {
    const first = new Map([["priya", box(500, 0)]]);
    const last = new Map([["priya", box(20, 140)]]);
    expect(flipDeltas(first, last).get("priya")).toEqual({ dx: 480, dy: -140 });
  });

  it("leaves a seat that did not move alone", () => {
    const first = new Map([["dana", box(10, 10)]]);
    const last = new Map([["dana", box(10.2, 9.8)]]);
    expect(flipDeltas(first, last).size).toBe(0);
  });

  it("has nothing to say about a seat that is new or gone", () => {
    const first = new Map([["gone", box(0, 0)]]);
    const last = new Map([["joiner", box(200, 0)]]);
    expect(flipDeltas(first, last).size).toBe(0);
  });
});
