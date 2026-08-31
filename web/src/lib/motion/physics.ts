/**
 * One world, one gravity — and nothing here touches the DOM or imports
 * anything, so every curve in the product can be checked arithmetically.
 *
 * Screen coordinates, so +y is down and an upward launch has a negative vy.
 * Positions come from the closed form rather than an integrator: that is what
 * lets the contact time be solved exactly, and it is why the keyframes are
 * sampled in *time* with `easing: "linear"`. Fast-slow-fast is gravity doing
 * the work, not a bezier imitating it.
 */

export type Vec = { x: number; y: number };
export type Size = { width: number; height: number };
export type Frame = { offset: number; transform: string; opacity: number };
/**
 * Everything the simulation needs to know about the screen: the emoji's own
 * box, the viewport it has to leave, and where the overlay sits inside it.
 * Measured once in `measure.ts` — nothing here reads the DOM.
 */
export type Bounds = { box: Size; viewport: Size; offset: Vec };

export const GRAVITY = 2600; // px/s²

/** The fixed timestep the arcs are sampled at, matching a 60Hz frame. */
const SAMPLE_S = 0.016;
/** How long the emoji spends dissolving as it travels off, at the very end. */
const FADE_MS = 180;
/** How much of the normal component survives the bounce off the avatar. */
const RESTITUTION = 0.45;
/** How much of the scrape along the disc is lost to it. */
const FRICTION = 0.2;
/** A tumbling emoji is cut loose after this long even if it is somehow still on screen. */
const FALL_CAP_MS = 900;

export function projectileAt(p0: Vec, v: Vec, t: number): Vec {
  return { x: p0.x + v.x * t, y: p0.y + v.y * t + 0.5 * GRAVITY * t * t };
}

/**
 * The launch that reaches `p2` from `p0` having risen `rise` px above `p0`.
 *
 * Fixing the apex fixes vy, which fixes the flight time T, which fixes vx —
 * none of the three is a tuned constant.
 */
export function solveThrow(p0: Vec, p2: Vec, rise: number): { vx: number; vy: number; T: number } {
  // A target above the thrower still has to be cleared on the way up.
  const climb = Math.max(rise, p0.y - p2.y + 20);
  const vy = -Math.sqrt(2 * GRAVITY * climb);
  const dy = p2.y - p0.y;
  const T = (-vy + Math.sqrt(vy * vy + 2 * GRAVITY * dy)) / GRAVITY;
  return { vx: (p2.x - p0.x) / T, vy, T };
}

/**
 * First time the thrown circle touches the target circle, to sub-millisecond.
 *
 * Stepping alone would put the impact up to a frame inside or outside the
 * avatar; the bisection is what makes it land *on* it.
 */
export function solveContact(p0: Vec, v: Vec, center: Vec, radius: number, tMax: number): number {
  const gap = (t: number) => {
    const p = projectileAt(p0, v, t);
    return Math.hypot(p.x - center.x, p.y - center.y) - radius;
  };
  let prev = 0;
  for (let t = SAMPLE_S; t <= tMax + 0.001; t += SAMPLE_S) {
    if (gap(t) <= 0) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = t;
  }
  return tMax;
}

/** Where the emoji is, and how it tumbles, the instant after it strikes the disc. */
export function bounceOff({
  hit,
  v,
  center,
  spin,
}: {
  hit: Vec;
  v: Vec;
  center: Vec;
  spin: number;
}): { velocity: Vec; spin: number } {
  // The contact normal points out of the disc, so a glancing blow and a
  // head-on one part ways here rather than sharing one scripted recoil.
  const span = Math.hypot(hit.x - center.x, hit.y - center.y) || 1;
  const n = { x: (hit.x - center.x) / span, y: (hit.y - center.y) / span };
  const vn = v.x * n.x + v.y * n.y;
  const tang = { x: v.x - vn * n.x, y: v.y - vn * n.y };
  return {
    velocity: {
      x: tang.x * (1 - FRICTION) - vn * n.x * RESTITUTION,
      y: tang.y * (1 - FRICTION) - vn * n.y * RESTITUTION,
    },
    // Tangential scrape is what actually changes the tumble.
    spin: spin * 0.6 + Math.hypot(tang.x, tang.y) * 0.35 * Math.sign(tang.x || 1),
  };
}

/**
 * A whole throw: the flight, the bounce off the disc, and the fall away.
 *
 * Nothing is ever held still and dissolved — every frame from release to the
 * last one comes out of the same closed form, and the fade only runs while the
 * emoji is already travelling off the edge.
 */
export function simulateThrow({
  p0,
  center,
  hitRadius,
  rise,
  spin,
  bounds,
}: {
  p0: Vec;
  center: Vec;
  hitRadius: number;
  rise: number;
  spin: number;
  bounds: Bounds;
}): { frames: Frame[]; durationMs: number; impactMs: number } {
  const { vx, vy, T } = solveThrow(p0, center, rise);
  const v0 = { x: vx, y: vy };
  const tHit = solveContact(p0, v0, center, hitRadius, T);
  const hit = projectileAt(p0, v0, tHit);
  const vHit = { x: v0.x, y: v0.y + GRAVITY * tHit };
  const { velocity: vBounce, spin: spinAfter } = bounceOff({ hit, v: vHit, center, spin });

  // The fall ends when the emoji is actually gone, not on a guessed duration.
  const gone = offScreenTest(bounds);
  const left = (p: Vec) =>
    gone({ x: p.x - bounds.box.width / 2, y: p.y - bounds.box.height / 2 });
  let tFall = FALL_CAP_MS / 1000;
  for (let t = SAMPLE_S; t <= FALL_CAP_MS / 1000; t += SAMPLE_S) {
    if (left(projectileAt(hit, vBounce, t))) {
      tFall = t;
      break;
    }
  }

  const impactMs = tHit * 1000;
  const durationMs = impactMs + tFall * 1000;
  // Height above the launch-to-target chord, used only as a depth cue.
  const apexRise = Math.max(1, rise);
  const frames: Frame[] = [];

  const push = (t: number, p: Vec, rot: number, opacity: number) => {
    const lift = Math.max(
      0,
      p0.y + ((p.x - p0.x) / (center.x - p0.x || 1)) * (center.y - p0.y) - p.y,
    );
    const scale = 1 + 0.12 * Math.min(1, lift / apexRise);
    frames.push({
      offset: Math.min(1, Math.max(0, (t * 1000) / durationMs)),
      transform: `translate(${(p.x - p0.x).toFixed(2)}px, ${(p.y - p0.y).toFixed(2)}px) scale(${scale.toFixed(3)}) rotate(${rot.toFixed(1)}deg)`,
      opacity,
    });
  };

  for (let t = 0; t < tHit; t += SAMPLE_S) push(t, projectileAt(p0, v0, t), spin * t, 1);
  push(tHit, hit, spin * tHit, 1);

  const fadeFrom = Math.max(0, tFall - FADE_MS / 1000);
  for (let t = SAMPLE_S; t < tFall; t += SAMPLE_S) {
    const opacity = t <= fadeFrom ? 1 : Math.max(0, 1 - (t - fadeFrom) / (tFall - fadeFrom));
    push(tHit + t, projectileAt(hit, vBounce, t), spin * tHit + spinAfter * t, opacity);
  }
  push(tHit + tFall, projectileAt(hit, vBounce, tFall), spin * tHit + spinAfter * tFall, 0);
  return { frames, durationMs, impactMs };
}

/**
 * Whether a moving box has left the viewport, tested against the circle that
 * circumscribes it rather than its own rect — a tumbling box sweeps wider than
 * its own width, and a beat gated on the rect fires while a corner is still
 * visible.
 */
export function offScreenTest({ box, viewport, offset }: Bounds): (p: Vec) => boolean {
  const reach = Math.hypot(box.width, box.height) / 2;
  return (p) => {
    const cx = offset.x + p.x + box.width / 2;
    const cy = offset.y + p.y + box.height / 2;
    return (
      cx + reach < 0 || cx - reach > viewport.width || cy + reach < 0 || cy - reach > viewport.height
    );
  };
}

/**
 * How much of its speed a seat keeps when it lands. Paired with
 * `@keyframes seat-drop` in tokens.css: change this and the keyframe's stops
 * have to be regenerated, which is what `physics.test.ts` guards.
 */
export const DROP_RESTITUTION = 0.35;

/**
 * The timings of a fall from rest through `d` px plus one bounce.
 *
 * No frames, deliberately. `fallT = √(2d/G)` and `bounceT = 2r·fallT`, so
 * `fallT / totalT = 1/(1+2r)` and the apex is `r²·d` — the *shape* in
 * normalised time is fixed by the restitution alone and the distance is only a
 * scale factor. That is what lets the whole curve be one static CSS keyframe
 * written against `calc(var(--drop-d) * k)`, with JS supplying nothing but the
 * distance and the duration.
 */
export function dropBounce(
  d: number,
  restitution = DROP_RESTITUTION,
): { fallMs: number; bounceMs: number; durationMs: number; apex: number } {
  if (!(d > 0)) return { fallMs: 0, bounceMs: 0, durationMs: 0, apex: 0 };
  const fallT = Math.sqrt((2 * d) / GRAVITY);
  const bounceT = 2 * restitution * fallT;
  return {
    fallMs: fallT * 1000,
    bounceMs: bounceT * 1000,
    durationMs: (fallT + bounceT) * 1000,
    apex: restitution * restitution * d,
  };
}
