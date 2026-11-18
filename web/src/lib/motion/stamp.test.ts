import { describe, expect, it } from "vitest";
import { simulateStamp, stepStamp } from "./stamp";

// Every expectation below is worked by hand, not read back from the code.
describe("stepStamp", () => {
  it("falls under the hinge's cos-weighted gravity", () => {
    // w = 0 - 10·cos(0.5)·0.1 = -0.0877583·10 = -0.877583; a = 0.5 - 0.0877583
    const { s, hit } = stepStamp({ a: 0.5, w: 0 }, 10, 0.1);
    expect(hit).toBe(false);
    expect(s.w).toBeCloseTo(-0.877583, 5);
    expect(s.a).toBeCloseTo(0.412242, 5);
  });

  it("strikes the card and rebounds with 40% of its speed", () => {
    // w = -2 - 10·cos(0.01)·0.1 = -2.99995; a goes below 0 → a = 0, w = 0.4·2.99995
    const { s, hit } = stepStamp({ a: 0.01, w: -2 }, 10, 0.1);
    expect(hit).toBe(true);
    expect(s.a).toBe(0);
    expect(s.w).toBeCloseTo(1.19998, 5);
  });

  it("stays down when the rebound is too slow to lift it", () => {
    // w = -0.11, rebound 0.044 < 0.5 rad/s → rest
    const { s, hit } = stepStamp({ a: 0.001, w: -0.1 }, 1, 0.01);
    expect(hit).toBe(true);
    expect(s).toEqual({ a: 0, w: 0 });
  });
});

describe("simulateStamp", () => {
  // L = 156 px → k = 3·2600 / 312 = 25 rad/s². From a lift of 0.08 (cos ≈ 1):
  // strike 1 at √(2·0.08/25) = 80 ms at √(2·25·0.08) = 2 rad/s; rebound 0.8 → aloft
  // 2·0.8/25 = 64 ms; strike 2 at 144 ms, rebound 0.32 < 0.5 → rest. One 4 ms step of slack.
  const swing = simulateStamp(0.08, 156);

  it("bounces once, shorter than the drop, and ends on the second strike", () => {
    expect(swing.impactsMs).toHaveLength(2);
    expect(Math.abs(swing.impactsMs[0] - 80)).toBeLessThan(5);
    expect(Math.abs(swing.impactsMs[1] - 144)).toBeLessThan(5);
    expect(Math.abs(swing.durationMs - 144)).toBeLessThan(5);
  });

  it("starts lifted and finishes flat on the card at full opacity", () => {
    // 0.08 rad = 4.58°, lifted counterclockwise
    expect(swing.frames[0]).toEqual({ offset: 0, transform: "rotate(-4.58deg)" });
    expect(swing.frames.at(-1)).toEqual({ offset: 1, transform: "rotate(0deg)" });
    expect(swing.frames.every((f) => !("opacity" in f))).toBe(true);
  });
});
