import { describe, expect, it } from "vitest";
import { WEED_DT, WEED_CEILING_RADII, bumpyGround, gusts, makeWeed, stepWeed, weedAtRest, weedEnergy } from "./tumbleweed";

const still = { x: 0, y: 0 };

describe("stepWeed", () => {
  it("falls one semi-implicit Euler step", () => {
    // v = 0 − 1000·0.01 = −10; y = 100 + (−10)·0.01 = 99.9.
    const b = stepWeed(makeWeed(10, { y: 100, g: 1000, drag: 0 }), 0.01, still);
    expect(b.vy).toBeCloseTo(-10);
    expect(b.y).toBeCloseTo(99.9);
    expect(b.grounded).toBe(false);
  });

  it("bounces with restitution e", () => {
    // 0.05 − 200·0.001 < 0, so it lands: vy = −e·(−200) = 100 at e = 0.5.
    const b = stepWeed(makeWeed(10, { y: 0.05, vy: -200, g: 0, drag: 0, e: 0.5 }), 0.001, still);
    expect(b.y).toBe(0);
    expect(b.vy).toBeCloseTo(100);
  });

  it("grips a sliding weed into rolling, v = ωr", () => {
    // Hollow sphere, I = ⅔mr²: J = −100 / (1/m + 1.5/m) = −40m, so v = 60
    // and ω = 40·r/(⅔r²) = 60/r. Rolling resistance off to keep it exact.
    // It lands (vy = −50, e = 0) so the contact has a normal impulse to grip with.
    const c = stepWeed(makeWeed(10, { vx: 100, vy: -50, g: 0, drag: 0, crr: 0, mu: 10, e: 0 }), 0.001, still);
    expect(c.vx).toBeCloseTo(60);
    expect(c.w * c.r).toBeCloseTo(60);
  });

  it("stays rolling, v = ωr, while grounded", () => {
    const b = makeWeed(10, { vx: 60, w: 6, drag: 0 });
    for (let i = 0; i < 240; i++) {
      stepWeed(b, WEED_DT, still);
      expect(b.grounded).toBe(true);
      expect(b.vx).toBeCloseTo(b.w * b.r, 9);
    }
    // Rolling resistance alone: crr·g·dt = 0.035·330/240 = 0.048125 a step,
    // 11.55 over 240 steps.
    expect(b.vx).toBeCloseTo(48.45, 6);
  });

  it("never gains energy without wind", () => {
    const b = makeWeed(20, { y: 60, vx: 150, w: 2 });
    let e = weedEnergy(b);
    for (let i = 0; i < 2400; i++) {
      stepWeed(b, WEED_DT, still);
      const next = weedEnergy(b);
      expect(next).toBeLessThanOrEqual(e + 1e-9);
      e = next;
    }
    expect(weedAtRest(b)).toBe(true);
  });
});

function run(seed: number, r = 20, width = 1280, calmAt = Infinity) {
  const b = makeWeed(r);
  const wind = gusts(seed, r);
  const ground = bumpyGround(r);
  const path: number[] = [];
  let maxTop = 0;
  let maxHop = 0;
  for (let t = 0; t < 60 && b.x - r < width; t += WEED_DT) {
    stepWeed(b, WEED_DT, t < calmAt ? wind(t) : still, ground);
    path.push(b.x, b.y, b.angle);
    maxTop = Math.max(maxTop, b.y + 2 * r);
    if (!b.grounded) maxHop = Math.max(maxHop, b.y);
    if (t >= calmAt && weedAtRest(b)) break;
  }
  return { b, path, maxTop, maxHop };
}

describe("a seeded run", () => {
  it("is the same weed for the same seed", () => {
    expect(run(7).path).toEqual(run(7).path);
    expect(run(7).path).not.toEqual(run(8).path);
  });

  it("rolls off the far edge on the wind", () => {
    expect(run(7).b.x).toBeGreaterThan(1280 + 20);
  });

  it("stays inside the felt", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { maxTop, path } = run(seed);
      expect(maxTop).toBeLessThan(WEED_CEILING_RADII * 20);
      for (let i = 1; i < path.length; i += 3) expect(path[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("throws at least one big hop, 2.5r or more, across seeds 1..20", () => {
    const hops = Array.from({ length: 20 }, (_, i) => run(i + 1, 20, 860).maxHop);
    // ~860 px is the felt at a 1280 px layout.
    expect(Math.max(...hops)).toBeGreaterThanOrEqual(2.5 * 20);
  });

  it("slows and stops once the wind dies", () => {
    const { b } = run(7, 20, 1280, 4);
    expect(weedAtRest(b)).toBe(true);
    expect(b.x).toBeLessThan(1280);
  });
});
