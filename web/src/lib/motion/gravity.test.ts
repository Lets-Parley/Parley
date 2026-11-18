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
    // m = 1, depth 14: g = 145·14 = 2030. v = 2030·0.01 = 20.3; y = 0.203.
    const s = stepSink(makeSink(14, 0), 0.01);
    expect(s.v).toBeCloseTo(20.3);
    expect(s.y).toBeCloseTo(0.203);
  });

  function settle(depth: number, weight: number) {
    const s = makeSink(depth, weight);
    const ys: number[] = [];
    while (!sinkAtRest(s) && ys.length < 5 / SINK_DT) ys.push(stepSink(s, SINK_DT).y);
    const peak = Math.max(...ys);
    const at = ys.indexOf(peak);
    const trough = ys.indexOf(Math.min(...ys.slice(at)), at);
    return { s, t: ys.length * SINK_DT, peak, tPeak: (at + 1) * SINK_DT, after: Math.max(...ys.slice(trough)) };
  }

  it("drops the heaviest card slowly, overshoots 5–10%, and lies still", () => {
    // m = 1.5: ωn = √(145/1.5) = 9.83, ζ = 17.7 / 2√(145·1.5) = 0.6.
    // First peak at π/ωd = π/(9.83·0.8) = 0.40 s, e^(−π·0.6/0.8) = 9.5% over
    // (≈ 15.3 px). Envelope e^(−5.9t): inside 0.1 px of rest by ≈ 0.73 s.
    const { s, t, peak, tPeak, after } = settle(14, 1);
    expect(peak).toBeGreaterThan(14.7);
    expect(peak).toBeLessThan(15.4);
    expect(tPeak).toBeGreaterThan(0.35);
    expect(tPeak).toBeLessThan(0.5);
    expect(t).toBeGreaterThan(0.7);
    expect(t).toBeLessThan(0.9);
    // No second swing a pixel past rest; friction leaves it exactly at rest.
    expect(after).toBeLessThan(15);
    expect(s.y).toBe(14);
    expect(s.v).toBe(0);
  });

  it("settles a lighter card faster and with less overshoot", () => {
    // m = 1: ζ = 0.735, e^(−π·0.735/0.678) = 3.3% over.
    const light = settle(14, 0);
    expect(light.peak).toBeLessThan(14.7);
    expect(light.t).toBeLessThan(settle(14, 1).t);
  });
});
