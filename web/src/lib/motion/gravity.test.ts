import { describe, expect, it } from "vitest";
import { SINK_DT, makeSink, sinkAtRest, sinkDepth, sinkOffsets, stepSink } from "./gravity";

const fib = ["0", "1", "2", "3", "5", "8", "13", "21", "?", "coffee"];

describe("sinkDepth", () => {
  it("maps rank to depth at a 1280 layout (860 px felt)", () => {
    // Eight numeric values, ranks 0..7: 6 × rank / 7.
    expect(sinkDepth("0", fib, 860)).toBe(0);
    expect(sinkDepth("21", fib, 860)).toBe(6);
    expect(sinkDepth("3", fib, 860)).toBeCloseTo(18 / 7);
  });

  it("puts 1 at 0 px and the top at 6 px when 1 is the lowest card", () => {
    const deck = ["1", "2", "3", "5", "8", "13", "?", "coffee"];
    expect(sinkDepth("1", deck, 860)).toBe(0);
    expect(sinkDepth("13", deck, 860)).toBe(6);
  });

  it("scales with the felt", () => {
    expect(sinkDepth("21", fib, 430)).toBe(3);
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
    expect(sinkOffsets(true, votes, fib, 860).get("a")).toBe(6);
  });
});

describe("stepSink", () => {
  it("falls one semi-implicit Euler step under its weight", () => {
    // m = 1, depth 6: g = 400·6 = 2400. v = 2400·0.01 = 24; y = 24·0.01 = 0.24.
    const s = stepSink(makeSink(6, 0), 0.01);
    expect(s.v).toBeCloseTo(24);
    expect(s.y).toBeCloseTo(0.24);
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

  it("overshoots slightly, then settles at its depth", () => {
    // ζ = 20 / 2√400 = 0.5: overshoot e^(−πζ/√(1−ζ²)) ≈ 16%, envelope e^(−10t).
    const { s, t, low } = settle(6, 0);
    expect(low).toBeGreaterThan(6.6);
    expect(low).toBeLessThan(7.2);
    expect(Math.abs(s.y - 6)).toBeLessThan(0.01);
    expect(t).toBeLessThan(1);
  });

  it("settles a heavier card slower", () => {
    // m = 2: envelope e^(−5t), so about twice as long, still under two seconds.
    const light = settle(6, 0).t;
    const heavy = settle(6, 1).t;
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBeLessThan(2);
  });
});
