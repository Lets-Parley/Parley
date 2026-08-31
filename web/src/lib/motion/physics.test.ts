import { describe, expect, it } from "vitest";
import {
  GRAVITY,
  bounceOff,
  offScreenTest,
  projectileAt,
  simulateThrow,
  solveContact,
  solveThrow,
} from "./physics";

describe("projectileAt", () => {
  it("is the closed form, not an integrator", () => {
    const p = projectileAt({ x: 10, y: 100 }, { x: 50, y: -200 }, 0.5);
    expect(p.x).toBeCloseTo(35, 6);
    expect(p.y).toBeCloseTo(100 - 100 + 0.5 * GRAVITY * 0.25, 6);
  });
});

describe("solveThrow", () => {
  it("lands the projectile on the target at T", () => {
    const p0 = { x: 0, y: 300 };
    const p2 = { x: 260, y: 320 };
    const { vx, vy, T } = solveThrow(p0, p2, 90);
    const hit = projectileAt(p0, { x: vx, y: vy }, T);
    expect(Math.hypot(hit.x - p2.x, hit.y - p2.y)).toBeLessThan(1);
  });

  it("still clears a target sitting above the thrower", () => {
    const p0 = { x: 0, y: 300 };
    const p2 = { x: 200, y: 120 };
    const { vx, vy, T } = solveThrow(p0, p2, 10);
    // Upward launch in screen coordinates is negative vy, and the apex has to
    // be above the target rather than merely above the thrower.
    expect(vy).toBeLessThan(0);
    const apexY = p0.y - (vy * vy) / (2 * GRAVITY);
    expect(apexY).toBeLessThan(p2.y);
    const hit = projectileAt(p0, { x: vx, y: vy }, T);
    expect(Math.hypot(hit.x - p2.x, hit.y - p2.y)).toBeLessThan(1);
  });
});

describe("solveContact", () => {
  it("finds the first touch of the two circles, not the centre crossing", () => {
    const p0 = { x: 0, y: 300 };
    const center = { x: 240, y: 300 };
    const radius = 40;
    const { vx, vy, T } = solveThrow(p0, center, 80);
    const t = solveContact(p0, { x: vx, y: vy }, center, radius, T);
    expect(t).toBeLessThan(T);
    const hit = projectileAt(p0, { x: vx, y: vy }, t);
    // On the circle to sub-pixel: the impact lands ON the avatar, not near it.
    expect(Math.abs(Math.hypot(hit.x - center.x, hit.y - center.y) - radius)).toBeLessThan(0.5);
  });

  it("falls back to tMax when the path never reaches the disc", () => {
    expect(solveContact({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 999, y: 0 }, 5, 0.4)).toBe(0.4);
  });
});

describe("bounceOff", () => {
  const center = { x: 0, y: 0 };

  it("reflects a head-on hit straight back out along the normal", () => {
    // Struck dead centre from the left: the normal is -x, and nothing is
    // tangential, so the recoil is pure normal and reversed.
    const { velocity } = bounceOff({
      hit: { x: -10, y: 0 },
      v: { x: 400, y: 0 },
      center,
      spin: 0,
    });
    expect(velocity.x).toBeCloseTo(-400 * 0.45, 6);
    expect(velocity.y).toBeCloseTo(0, 6);
  });

  it("sends a glancing blow somewhere else entirely", () => {
    // Same incoming velocity, struck near the top of the disc instead: the
    // normal is now +y, so the throw scrapes over it rather than rebounding.
    const { velocity } = bounceOff({
      hit: { x: 0, y: -10 },
      v: { x: 400, y: 0 },
      center,
      spin: 0,
    });
    expect(velocity.x).toBeCloseTo(400 * 0.8, 6);
    expect(velocity.y).toBeCloseTo(0, 6);
    // And the two recoils are not the same vector, which is the whole point.
    expect(velocity.x).toBeGreaterThan(0);
  });

  it("drives the new tumble off the tangential scrape", () => {
    const scraped = bounceOff({ hit: { x: 0, y: -10 }, v: { x: 400, y: 0 }, center, spin: 100 });
    const headOn = bounceOff({ hit: { x: -10, y: 0 }, v: { x: 400, y: 0 }, center, spin: 100 });
    // Nothing tangential, nothing added: the head-on hit only bleeds spin.
    expect(headOn.spin).toBeCloseTo(60, 6);
    expect(scraped.spin).toBeCloseTo(60 + 400 * 0.35, 6);
    expect(scraped.spin).not.toBeCloseTo(100, 3);
  });
});

const bounds = {
  box: { width: 24, height: 24 },
  viewport: { width: 800, height: 600 },
  offset: { x: 0, y: 0 },
};

/** The translate() of a frame, back as a point in the layer's coordinates. */
const at = (f: { transform: string }, p0: { x: number; y: number }) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(f.transform);
  if (!m) throw new Error(`no translate in ${f.transform}`);
  return { x: p0.x + Number(m[1]), y: p0.y + Number(m[2]) };
};

describe("simulateThrow", () => {
  const p0 = { x: 0, y: 320 };
  const center = { x: 220, y: 300 };
  const throwIt = (spin = 200) =>
    simulateThrow({ p0, center, hitRadius: 37, rise: 84, spin, bounds });

  it("keeps a monotonic, complete keyframe list", () => {
    const { frames, durationMs, impactMs } = throwIt();
    expect(impactMs).toBeGreaterThan(0);
    expect(durationMs).toBeGreaterThan(impactMs);
    expect(frames[0].offset).toBe(0);
    expect(frames[frames.length - 1].offset).toBe(1);
    expect(frames[frames.length - 1].opacity).toBe(0);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].offset).toBeGreaterThanOrEqual(frames[i - 1].offset);
    }
  });

  it("never holds the emoji still — it bounces off and keeps moving", () => {
    const { frames, durationMs, impactMs } = throwIt();
    const after = frames.filter((f) => f.offset > impactMs / durationMs);
    expect(after.length).toBeGreaterThan(4);
    // Every post-contact frame is somewhere new: nothing is parked on the disc.
    const points = after.map((f) => at(f, p0));
    for (let i = 1; i < points.length; i++) {
      expect(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)).toBeGreaterThan(0);
    }
    expect(new Set(after.map((f) => f.transform)).size).toBe(after.length);
  });

  it("reverses direction at contact", () => {
    const { frames, durationMs, impactMs } = throwIt();
    const hitAt = impactMs / durationMs;
    const before = frames.filter((f) => f.offset <= hitAt).map((f) => at(f, p0));
    const post = frames.filter((f) => f.offset > hitAt).map((f) => at(f, p0));
    const inX = before[before.length - 1].x - before[before.length - 2].x;
    const outX = post[0].x - before[before.length - 1].x;
    expect(inX).toBeGreaterThan(0);
    expect(outX).toBeLessThan(0);
  });

  it("falls until offScreenTest says it is gone, and only fades on the way out", () => {
    const { frames } = throwIt();
    const gone = offScreenTest(bounds);
    const last = at(frames[frames.length - 1], p0);
    expect(gone({ x: last.x - 12, y: last.y - 12 })).toBe(true);
    // The dissolve belongs to the exit: it starts while the emoji is already
    // travelling off, never while it is sitting in the middle of the felt.
    const fading = frames.filter((f) => f.opacity < 1);
    expect(fading.length).toBeGreaterThan(0);
    expect(new Set(fading.map((f) => f.transform)).size).toBe(fading.length);
    // It is well past the disc and falling away by the time it starts to go,
    // and the whole dissolve is the last 180ms of a much longer flight.
    const { durationMs } = throwIt();
    const firstFade = at(fading[0], p0);
    expect(firstFade.y).toBeGreaterThan(center.y + 100);
    expect(fading[0].offset * durationMs).toBeGreaterThan(durationMs - 200);
  });
});

describe("offScreenTest", () => {
  it("reports not gone while the sweep circle still overlaps the viewport", () => {
    const gone = offScreenTest({
      box: { width: 40, height: 40 },
      viewport: { width: 100, height: 100 },
      offset: { x: 0, y: 0 },
    });
    // The box's own rect (-45..-5) has left the viewport entirely, but a
    // tumbling box sweeps its circumscribing circle, which has not.
    expect(gone({ x: -45, y: 0 })).toBe(false);
    expect(gone({ x: -80, y: 0 })).toBe(true);
  });

  it("tests every edge", () => {
    const gone = offScreenTest({
      box: { width: 10, height: 10 },
      viewport: { width: 100, height: 100 },
      offset: { x: 0, y: 0 },
    });
    expect(gone({ x: 50, y: 50 })).toBe(false);
    expect(gone({ x: 200, y: 50 })).toBe(true);
    expect(gone({ x: 50, y: 200 })).toBe(true);
    expect(gone({ x: 50, y: -50 })).toBe(true);
  });
});
