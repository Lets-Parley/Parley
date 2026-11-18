import { describe, expect, it } from "vitest";
import { SINK_DT, makeSink, sinkAtRest, sinkDepth, sinkOffsets, stepSink } from "./gravity";

const fib = ["0", "1", "2", "3", "5", "8", "13", "21", "?", "coffee"];

describe("sinkDepth", () => {
  it("maps rank to depth at a 1280 layout (860 px felt)", () => {
    // Eight numeric values, ranks 0..7: 14 × rank / 7 = 2 px a rank.
    expect(sinkDepth("0", fib, 860)).toBe(0);
    expect(sinkDepth("21", fib, 860)).toBe(14);
    expect(sinkDepth("3", fib, 860)).toBe(6);
  });

  it("puts 1 at 0 px and the top at 14 px when 1 is the lowest card", () => {
    const deck = ["1", "2", "3", "5", "8", "13", "?", "coffee"];
    expect(sinkDepth("1", deck, 860)).toBe(0);
    expect(sinkDepth("13", deck, 860)).toBe(14);
  });

  it("scales with the felt", () => {
    expect(sinkDepth("21", fib, 430)).toBe(7);
  });

  it("leaves specials and strangers on the surface", () => {
    expect(sinkDepth("?", fib, 860)).toBe(0);
    expect(sinkDepth("coffee", fib, 860)).toBe(0);
    expect(sinkDepth("40", fib, 860)).toBe(0);
    expect(sinkDepth(undefined, fib, 860)).toBe(0);
  });
});

describe("sinkOffsets", () => {
  const votes = new Map([
    ["a", "21"],
    ["b", "3"],
  ]);

  it("sinks nothing before the reveal", () => {
    expect([...sinkOffsets(false, votes, fib, 860).values()]).toEqual([0, 0]);
  });

  it("sinks revealed cards", () => {
    expect(sinkOffsets(true, votes, fib, 860).get("a")).toBe(14);
  });
});

describe("stepSink", () => {
  it("falls one semi-implicit Euler step under its weight", () => {
    // m = 1, depth 14: g = 900·14 = 12600. v = 12600·0.01 = 126; y = 1.26.
    const s = stepSink(makeSink(14, 0), 0.01);
    expect(s.v).toBeCloseTo(126);
    expect(s.y).toBeCloseTo(1.26);
  });

  function settle(depth: number, weight: number) {
    const s = makeSink(depth, weight);
    let t = 0;
    let low = 0;
    while (!sinkAtRest(s) && t < 5) {
      stepSink(s, SINK_DT);
      t += SINK_DT;
      low = Math.max(low, s.y);
    }
    return { s, t, low };
  }

  it("lands a light card with a small overshoot", () => {
    // m = 1: ζ = 30 / 2√900 = 0.5, overshoot e^(−π·0.5/√0.75) = 16.3%, so
    // the peak is ≈ 16.3 px; envelope e^(−15t), at rest in ≈ 0.5 s.
    const { s, t, low } = settle(14, 0);
    expect(low).toBeGreaterThan(15.9);
    expect(low).toBeLessThan(16.7);
    expect(Math.abs(s.y - 14)).toBeLessThan(0.01);
    expect(t).toBeLessThan(1);
  });

  it("thunks a heavy card 25–35% past its depth, then settles slower", () => {
    // m = 2: ζ = 30 / 2√1800 = 0.354, overshoot e^(−π·0.354/√0.875) = 30.4%,
    // a peak ≈ 18.3 px (bounds are 25% and 35%: 17.5 and 18.9).
    // Envelope e^(−7.5t): ln(14/0.01)/7.5 ≈ 0.97 s.
    const { s, t, low } = settle(14, 1);
    expect(low).toBeGreaterThan(17.5);
    expect(low).toBeLessThan(18.9);
    expect(Math.abs(s.y - 14)).toBeLessThan(0.01);
    expect(t).toBeGreaterThan(settle(14, 0).t);
    expect(t).toBeLessThan(1.5);
  });
});
