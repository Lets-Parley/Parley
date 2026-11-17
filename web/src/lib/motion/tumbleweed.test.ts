import { describe, expect, it } from "vitest";
import { planTumbleweed, rollTumbleweed } from "./tumbleweed";

describe("rollTumbleweed", () => {
  // G = 2600: a 13 px hop leaves at √(2·2600·13) = 260 px/s, peaks at 0.1 s,
  // lands at 0.2 s. At 100 px/s it covers 20 px a hop, 40 px in 0.4 s.
  const s = rollTumbleweed({ vx: 100, heights: [13], from: 0, to: 40, radius: 10, dt: 0.05 });

  it("samples the whole crossing", () => {
    expect(s).toHaveLength(9);
    expect(s[8].t).toBeCloseTo(0.4);
    expect(s[8].x).toBeCloseTo(40);
  });

  it("hops on a parabola", () => {
    expect(s[1].y).toBeCloseTo(9.75); // 260·0.05 − 1300·0.0025
    expect(s[2].y).toBeCloseTo(13); // apex
    expect(s[4].y).toBeCloseTo(0); // lands
    expect(s[6].y).toBeCloseTo(13); // the gust lifts it again
  });

  it("rolls without slipping", () => {
    expect(s[2].angle).toBeCloseTo(1); // 10 px over a 10 px radius
    expect(s[8].angle).toBeCloseTo(4);
  });

  it("does nothing for a degenerate path", () => {
    expect(rollTumbleweed({ vx: 0, heights: [13], from: 0, to: 40 })).toEqual([]);
  });
});

describe("planTumbleweed", () => {
  it("is the same weed for the same seed", () => {
    expect(planTumbleweed(7, 600)).toEqual(planTumbleweed(7, 600));
    expect(planTumbleweed(7, 600)).not.toEqual(planTumbleweed(8, 600));
  });

  it("enters off the left edge and leaves off the right", () => {
    const p = planTumbleweed(7, 600);
    expect(p[0].x).toBe(-24);
    expect(p[p.length - 1].x).toBeCloseTo(624);
  });
});
