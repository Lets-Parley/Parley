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

/**
 * How fast the boot's tip is travelling when it lands, in px/s. It is an
 * initial push, not a speed the arc is forced to hold — gravity takes it from
 * there, which is why the dip and the rise have the shape they do.
 */
export const BOOT_TIP_SPEED = 1600;
/** How much of the boot's contact speed the seat takes: it is the light body. */
export const KICK_TRANSFER = 0.95;
/** The boot stands beside the seat this long before it moves, so it is seen. */
export const BOOT_WINDUP_MS = 200;
/** And keeps swinging this long after, minus what it gave away. */
export const BOOT_FOLLOW_MS = 220;
/** Then it is pulled back out, at most this long: it leaves as it arrived. */
export const BOOT_RETRACT_MS = 200;
/** How far past its rest angle the withdrawal may carry, in radians. */
const BOOT_RETRACT_ARC = Math.PI / 3;
/** A boot that has not reached the avatar by now never will. */
const SWING_CAP_S = 1.2;
/** A launched seat is cut loose after this long even if it is still on screen. */
const LAUNCH_CAP_MS = 1400;

export type BootSwing = {
  frames: Frame[];
  durationMs: number;
  impactMs: number;
  hit: Vec;
  velocity: Vec;
  origin: Vec;
  /** Evidence the motion is real rather than plausible; asserted in the tests. */
  metrics: {
    dip: number;
    riseAfterDip: number;
    closest: number;
    hitRadius: number;
    startOffsetX: number;
  };
};

/**
 * A driven pendulum whose arc passes through both the boot's rest spot and the
 * avatar's edge.
 *
 * The pivot sits above the chord between the two, so the low point of the
 * circle falls between them: the boot dips on the way across and is *rising*
 * when it lands. That is what keeps the contact flat, and a flat contact is
 * what sends the seat sideways instead of lobbing it straight up.
 *
 * Integrated rather than closed-form because a'' = -(G/L)·sin a has no
 * elementary solution — this is the one curve in the module gravity cannot be
 * solved through — but the contact is still *solved*, by bisecting the
 * bracketing samples, not merely timed. Null when the arc never reaches the
 * disc: a caller that cannot swing must draw nothing rather than a boot that
 * misses.
 */
export function swingBoot({
  pivot,
  radius,
  startAngle,
  angularSpeed = BOOT_TIP_SPEED / radius,
  target,
  hitRadius,
  // The boot's glyph points right at rest and is mirrored, which flips the
  // sense of rotation — hence the negated angle.
  pose = (deg: number) => `rotate(${(-deg).toFixed(1)}deg) scaleX(-1)`,
  windupMs = BOOT_WINDUP_MS,
  followMs = BOOT_FOLLOW_MS,
  retractMs = BOOT_RETRACT_MS,
  transfer = KICK_TRANSFER,
}: {
  pivot: Vec;
  radius: number;
  startAngle: number;
  angularSpeed?: number;
  target: Vec;
  hitRadius: number;
  pose?: (deg: number) => string;
  windupMs?: number;
  followMs?: number;
  retractMs?: number;
  transfer?: number;
}): BootSwing | null {
  const dt = SAMPLE_S;
  const posAt = (a: number): Vec => ({
    x: pivot.x + radius * Math.sin(a),
    y: pivot.y + radius * Math.cos(a),
  });
  const gapAt = (a: number) => {
    const p = posAt(a);
    return Math.hypot(p.x - target.x, p.y - target.y) - hitRadius;
  };

  // Semi-implicit Euler on a'' = -(G/L)·sin a. Gravity shapes the timing; the
  // initial push sets how hard it arrives.
  const samples: { t: number; a: number }[] = [{ t: 0, a: startAngle }];
  let a = startAngle;
  let w = -angularSpeed;
  let contact: { t: number; a: number; w: number } | null = null;
  for (let step = 1; step * dt <= SWING_CAP_S; step++) {
    const prev = { a, w };
    w += -(GRAVITY / radius) * Math.sin(a) * dt;
    a += w * dt;
    const t = step * dt;
    samples.push({ t, a });
    if (gapAt(a) <= 0) {
      // Bisect on the interpolated state between the bracketing samples, so
      // the strike lands ON the disc rather than a frame inside it.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (gapAt(prev.a + (a - prev.a) * mid) <= 0) hi = mid;
        else lo = mid;
      }
      contact = {
        t: (step - 1) * dt + hi * dt,
        a: prev.a + (a - prev.a) * hi,
        w: prev.w + (w - prev.w) * hi,
      };
      samples[samples.length - 1] = { t: contact.t, a: contact.a };
      break;
    }
  }
  if (!contact) return null;

  const hit = posAt(contact.a);
  // Tangential velocity: d/dt of the arc, which points up and to the left
  // exactly because the boot is on its way back up.
  const velocity = {
    x: radius * contact.w * Math.cos(contact.a),
    y: -radius * contact.w * Math.sin(contact.a),
  };

  // Follow-through: it keeps swinging, minus what it gave away. Nothing is
  // ever frozen on the contact point and dissolved.
  let fa = contact.a;
  let fw = contact.w * (1 - transfer);
  const follow: { t: number; a: number }[] = [];
  for (let t = contact.t + dt; t <= contact.t + followMs / 1000; t += dt) {
    fw += -(GRAVITY / radius) * Math.sin(fa) * dt;
    fa += fw * dt;
    follow.push({ t, a: fa });
  }

  // Withdrawal: the leg is pulled back out the way it came, at the speed it
  // came in with, still on the same arc and still under gravity. This is the
  // boot's ending — it is off the arc and gone under its own motion, and
  // nothing waits on the seat. Cut short once it is a clear arc past its rest
  // spot, so the withdrawal never carries it over the top of the circle.
  const lead = windupMs / 1000;
  const retract: { t: number; a: number }[] = [];
  const last = follow.length > 0 ? follow[follow.length - 1] : { t: contact.t, a: contact.a };
  let ra = last.a;
  let rw = angularSpeed;
  const retractStart = last.t;
  for (let t = retractStart + dt; t <= retractStart + retractMs / 1000; t += dt) {
    rw += -(GRAVITY / radius) * Math.sin(ra) * dt;
    ra += rw * dt;
    retract.push({ t, a: ra });
    if (ra >= startAngle + BOOT_RETRACT_ARC) break;
  }
  const retractFrom = retractStart + lead;
  const retractSpan = retract.length > 0 ? retract[retract.length - 1].t + lead - retractFrom : 0;

  // A wind-up hold in front, so the boot is seen where it stands before the
  // swing — which at this speed is only a handful of frames.
  const timeline = [
    { t: 0, a: startAngle },
    ...[...samples, ...follow, ...retract].map((s) => ({ t: s.t + lead, a: s.a })),
  ];
  const totalMs = timeline[timeline.length - 1].t * 1000;
  const origin = posAt(startAngle);
  const contactT = contact.t + lead;
  const frameAt = (ang: number) => {
    const p = posAt(ang);
    return `translate(${(p.x - origin.x).toFixed(2)}px, ${(p.y - origin.y).toFixed(2)}px) ${pose((ang * 180) / Math.PI)}`;
  };
  const frames: Frame[] = timeline.map(({ t, a: ang }) => {
    // The opacity only ever runs over a glyph that is already travelling out:
    // it starts when the withdrawal does and finishes with it, so the boot is
    // never held still on the contact point and dissolved.
    const away = retractSpan > 0 && t > retractFrom ? (t - retractFrom) / retractSpan : 0;
    return {
      offset: Math.min(1, Math.max(0, (t * 1000) / totalMs)),
      transform: frameAt(ang),
      opacity: Math.max(0, 1 - away),
    };
  });

  let dip = 0;
  let closest = Infinity;
  for (const { t, a: ang } of samples) {
    if (t > contact.t) continue;
    const p = posAt(ang);
    dip = Math.max(dip, p.y - origin.y);
    closest = Math.min(closest, Math.hypot(p.x - target.x, p.y - target.y));
  }

  return {
    frames,
    durationMs: totalMs,
    impactMs: contactT * 1000,
    hit,
    velocity,
    origin,
    metrics: {
      dip,
      riseAfterDip: dip - (hit.y - origin.y),
      closest,
      hitRadius,
      // How far to one side the glyph waits: an arc, not a straight drop.
      startOffsetX: Math.abs(origin.x - target.x),
    },
  };
}

/**
 * The kicked seat: one launch, the shared gravity, no bounce.
 *
 * Reports the moment it is fully off screen, which is what the row waits for —
 * tested against the seat's circumscribing circle, because a tumbling box
 * sweeps wider than its own width and the row must not start closing while a
 * corner is still visible. Only a launch that never leaves is faded; one that
 * goes is simulated all the way out at full opacity.
 */
export function simulateLaunch({
  p0,
  v,
  bounds,
  spin,
}: {
  p0: Vec;
  v: Vec;
  bounds: Bounds;
  spin: number;
}): { frames: Frame[]; durationMs: number; exitMs: number } {
  const gone = offScreenTest(bounds);
  const path: { t: number; transform: string }[] = [];
  let exitMs: number | null = null;
  for (let t = 0; t <= LAUNCH_CAP_MS / 1000; t += SAMPLE_S) {
    const p = projectileAt(p0, v, t);
    path.push({
      t,
      transform: `translate(${(p.x - p0.x).toFixed(2)}px, ${(p.y - p0.y).toFixed(2)}px) rotate(${(spin * t).toFixed(1)}deg)`,
    });
    if (gone(p)) {
      exitMs = t * 1000;
      break;
    }
  }

  const durationMs = exitMs ?? LAUNCH_CAP_MS;
  // A seat that never leaves has to end somewhere, and the sampled path stops
  // one step short of the cap. The last frame is the real position at the cap,
  // fully dissolved — the only fade in this whole animation.
  if (exitMs === null) {
    const p = projectileAt(p0, v, durationMs / 1000);
    path.push({
      t: durationMs / 1000,
      transform: `translate(${(p.x - p0.x).toFixed(2)}px, ${(p.y - p0.y).toFixed(2)}px) rotate(${((spin * durationMs) / 1000).toFixed(1)}deg)`,
    });
  }
  const fadeFrom = exitMs === null ? Math.max(0, durationMs - FADE_MS) : Infinity;
  const frames = path.map(({ t, transform }) => ({
    offset: Math.min(1, Math.max(0, (t * 1000) / durationMs)),
    transform,
    opacity:
      t * 1000 <= fadeFrom
        ? 1
        : Math.max(0, 1 - (t * 1000 - fadeFrom) / Math.max(1, durationMs - fadeFrom)),
  }));
  return { frames, durationMs, exitMs: exitMs ?? durationMs };
}
