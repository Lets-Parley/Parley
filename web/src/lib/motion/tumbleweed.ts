import { GRAVITY } from "./physics";

/** A weed sample: `y` is height above the felt, `angle` is radians rolled. */
export type WeedSample = { t: number; x: number; y: number; angle: number };

/** How long an empty, unrevealed table sits before a weed rolls in. */
export const TUMBLEWEED_IDLE_MS = 8000;
export const WEED_RADIUS = 12;

/**
 * A weed rolling across the felt in hops. Each hop leaves the ground at the
 * speed that reaches its height under gravity (`vy = √(2Gh)`) and lands after
 * `2·vy/G`; a gust kicks it back up on landing, cycling through `heights`.
 * It rolls without slipping, so the angle is distance over radius. Sampled
 * every `dt` s from `from` until it passes `to`.
 */
export function rollTumbleweed({
  vx,
  heights,
  from,
  to,
  radius = WEED_RADIUS,
  dt = 1 / 60,
}: {
  vx: number;
  heights: number[];
  from: number;
  to: number;
  radius?: number;
  dt?: number;
}): WeedSample[] {
  if (!(vx > 0) || heights.length === 0 || to <= from) return [];
  const total = (to - from) / vx;
  const out: WeedSample[] = [];
  let hop = 0;
  let hopStart = 0;
  let hopT = (2 * Math.sqrt(2 * GRAVITY * heights[0])) / GRAVITY;
  const steps = Math.ceil(total / dt - 1e-9);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(i * dt, total);
    while (hopT > 0 && t > hopStart + hopT + 1e-9) {
      hopStart += hopT;
      hop++;
      hopT = (2 * Math.sqrt(2 * GRAVITY * heights[hop % heights.length])) / GRAVITY;
    }
    const s = t - hopStart;
    const vy = Math.sqrt(2 * GRAVITY * heights[hop % heights.length]);
    const x = from + vx * t;
    out.push({ t, x, y: Math.max(0, vy * s - (GRAVITY * s * s) / 2), angle: (x - from) / radius });
  }
  return out;
}

/** mulberry32: a tiny seeded PRNG, so every client rolls the same weed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The weed for one round: speed and hop heights drawn from `seed`. */
export function planTumbleweed(seed: number, width: number): WeedSample[] {
  const rand = seeded(seed);
  const vx = 110 + 70 * rand();
  const heights = Array.from({ length: 5 }, () => 6 + 22 * rand());
  return rollTumbleweed({ vx, heights, from: -2 * WEED_RADIUS, to: width + 2 * WEED_RADIUS });
}
