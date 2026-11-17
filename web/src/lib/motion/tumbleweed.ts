/**
 * A tumbleweed as a rigid body: a light hollow sphere (I = ⅔mr²) under
 * gravity and wind drag, bouncing off the felt with restitution and rolling
 * on it with Coulomb friction. Integrated at a fixed timestep with
 * semi-implicit Euler, so a run is the same on every client for a seed.
 *
 * Coordinates: x is the center's horizontal position, y is the height of the
 * body's lowest point above the felt's baseline, angle/w are clockwise.
 */

export type Weed = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Angular velocity, rad/s, clockwise. Rolling right without slip: vx = w·r. */
  w: number;
  angle: number;
  r: number;
  m: number;
  I: number;
  g: number;
  /** Coefficient of restitution against the felt. */
  e: number;
  /** Coulomb friction coefficient at the contact. */
  mu: number;
  /** Rolling resistance coefficient. */
  crr: number;
  /** Linear wind drag, per second (force = drag·m·(wind − v)). */
  drag: number;
  grounded: boolean;
};

export type Vec2 = { x: number; y: number };
export type Ground = (x: number) => number;

/** Fixed integrator step. */
export const WEED_DT = 1 / 240;
/** How long an empty, unrevealed table sits before a weed rolls in. */
export const TUMBLEWEED_IDLE_MS = 8000;
/** About 40 px across on a 1280 px felt, scaled with the felt. */
export function weedRadius(feltWidth: number): number {
  return Math.max(12, (20 * feltWidth) / 1280);
}
/** The lane under the card slots the weed runs in, as a multiple of r. */
export const WEED_LANE_RADII = 3.8;

/** Below this closing speed a contact is plastic, so resting does not chatter. */
const REST_SPEED = 1e-6;

export function makeWeed(r: number, over: Partial<Weed> = {}): Weed {
  const m = 1;
  return {
    x: -r,
    y: 0,
    vx: 0,
    vy: 0,
    w: 0,
    angle: 0,
    r,
    m,
    I: (2 / 3) * m * r * r,
    // A 0.6 m weed under 9.8 m/s²: 40 px ≈ 0.6 m, so g ≈ 33 r per s².
    g: 33 * r,
    e: 0.45,
    mu: 0.6,
    crr: 0.035,
    drag: 1.4,
    grounded: true,
    ...over,
  };
}

export const flatGround: Ground = () => 0;

/** Small deterministic bumps in the felt, a few percent of r high. */
export function bumpyGround(r: number): Ground {
  const a = 0.3 * r;
  return (x) => a * Math.max(0, Math.sin(x / (1.3 * r))) ** 8 + 0.7 * a * Math.max(0, Math.sin(x / (2.9 * r) + 1.3)) ** 8;
}

/** One fixed step. Mutates and returns `b`. */
export function stepWeed(b: Weed, dt: number, wind: Vec2, ground: Ground = flatGround): Weed {
  // Forces: gravity and linear drag toward the wind. Spin is untouched in air.
  b.vx += b.drag * (wind.x - b.vx) * dt;
  b.vy += (b.drag * (wind.y - b.vy) - b.g) * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.angle += b.w * dt;

  const h = ground(b.x);
  b.grounded = b.y <= h;
  if (!b.grounded) return b;
  b.y = h;
  const slope = (ground(b.x + 0.5) - ground(b.x - 0.5)) / 1;
  const len = Math.hypot(slope, 1);
  const nx = -slope / len;
  const ny = 1 / len;
  const tx = ny;
  const ty = -nx;

  // Normal impulse (per unit mass): bounce with restitution, plastic when slow.
  const vn = b.vx * nx + b.vy * ny;
  let jn = 0;
  if (vn < 0) {
    jn = -(1 + (-vn > REST_SPEED ? b.e : 0)) * vn;
    b.vx += jn * nx;
    b.vy += jn * ny;
  }

  // Friction at the contact point, which moves at vt − w·r along the tangent.
  // The impulse that stops it slipping, capped by Coulomb (normal impulse plus
  // the support this step gives against gravity).
  const vt = b.vx * tx + b.vy * ty;
  const slip = vt - b.w * b.r;
  let J = -slip / (1 / b.m + (b.r * b.r) / b.I);
  const maxJ = b.mu * b.m * (jn + b.g * ny * dt);
  J = Math.max(-maxJ, Math.min(maxJ, J));
  let vt2 = vt + J / b.m;
  b.w -= (J * b.r) / b.I;

  // Rolling without slip: rolling resistance slows the pair together.
  if (Math.abs(vt2 - b.w * b.r) < 1e-9) {
    const dv = Math.min(Math.abs(vt2), b.crr * b.g * ny * dt);
    vt2 -= Math.sign(vt2) * dv;
    b.w = vt2 / b.r;
  }
  b.vx += (vt2 - vt) * tx;
  b.vy += (vt2 - vt) * ty;
  return b;
}

/** Total mechanical energy relative to the baseline. */
export function weedEnergy(b: Weed): number {
  return 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy) + 0.5 * b.I * b.w * b.w + b.m * b.g * b.y;
}

/** mulberry32: a tiny seeded PRNG, so every client sees the same gusts. */
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

const GUST_EVERY = 0.45;

/** The wind for a seed: gusts around a steady breeze, eased between knots. */
export function gusts(seed: number, r: number): (t: number) => Vec2 {
  const rand = seeded(seed);
  const base = 8 * r;
  const knots = Array.from({ length: 240 }, () => 0.25 + 1.5 * rand());
  return (t) => {
    const i = Math.max(0, Math.min(knots.length - 2, Math.floor(t / GUST_EVERY)));
    const f = Math.min(1, t / GUST_EVERY - i);
    const k = knots[i] + (knots[i + 1] - knots[i]) * (f * f * (3 - 2 * f));
    const wx = base * k;
    // A strong gust lifts a little as well as pushes.
    return { x: wx, y: 5 * Math.max(0, wx - 1.15 * base) };
  };
}

/** At rest on the felt: a stopped weed with the wind gone stays put. */
export function weedAtRest(b: Weed): boolean {
  return b.grounded && Math.abs(b.vx) < 0.5 && Math.abs(b.w * b.r) < 0.5;
}
