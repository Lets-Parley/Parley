import { describe, expect, it } from "vitest";
import { GRAVITY, offScreenTest, projectileAt, simulateThrow, solveContact, solveThrow } from "./physics";

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

describe("simulateThrow", () => {
  it("ends at the contact point and fades there", () => {
    const p0 = { x: 0, y: 320 };
    const center = { x: 220, y: 300 };
    const { frames, durationMs, impactMs } = simulateThrow({
      p0,
      center,
      hitRadius: 37,
      rise: 84,
      spin: 200,
    });
    expect(impactMs).toBeGreaterThan(0);
    expect(durationMs).toBeGreaterThan(impactMs);
    expect(frames[0].offset).toBe(0);
    expect(frames[frames.length - 1].offset).toBe(1);
    expect(frames[frames.length - 1].opacity).toBe(0);
    // Monotonic offsets, or WAAPI rejects the keyframe list outright.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].offset).toBeGreaterThanOrEqual(frames[i - 1].offset);
    }
  });

  it("keeps the post-contact frames pinned to the impact point", () => {
    const p0 = { x: 0, y: 320 };
    const center = { x: 220, y: 300 };
    const out = simulateThrow({ p0, center, hitRadius: 37, rise: 84, spin: 0 });
    const fading = out.frames.filter((f) => f.opacity < 1);
    expect(fading.length).toBeGreaterThan(0);
    const at = (f: { transform: string }) => f.transform.slice(0, f.transform.indexOf(")") + 1);
    expect(new Set(fading.map(at)).size).toBe(1);
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
