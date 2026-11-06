import {
  KICK_TRANSFER,
  dropBounce,
  simulateLaunch,
  swingBoot,
  type BootSwing,
  type Bounds,
  type Frame,
  type Vec,
} from "./physics";

/* --- The reveal beat sheet ----------------------------------------------
 *
 * The turn is one authored moment, so it gets one clock. Every delay in it —
 * the flip stagger, the hop, the result numeral, and everything that waits for
 * the table to clear — is derived here and imported, because the previous
 * arrangement had the same moment timed by four literals in four files
 * (`70` and `620 + i*40` in Table, `560` in ResultsPanel, and this function)
 * and they had already drifted apart: the 6.5rem result stamped in at 560ms
 * while a table of six still had cards turning over until 650ms.
 *
 * If you are adding a beat to the reveal, add it here and import it. A literal
 * millisecond value in a component is the bug this section exists to prevent.
 */

/** Between one card starting to turn and the next. */
export const FLIP_STAGGER_MS = 70;
/** One card's turn. Mirrors --dur-flip. */
export const CARD_FLIP_MS = 300;
/** One card's landing bounce. Mirrors the stops in the card-hop keyframe. */
export const CARD_HOP_MS = 420;
/** The coffee and question-mark cards' one wobble on landing. Equal to the hop, so the settle beat does not move. */
export const CARD_WOBBLE_MS = 420;
/** One card being dealt onto the felt. Mirrors the stops in the deal-in keyframe. */
export const CARD_DEAL_MS = 260;
/** Between one card being dealt and the next. Slower than the flip stagger: a
 *  deal is one card at a time, a reveal is the whole table turning at once. */
export const DEAL_STAGGER_MS = 90;
/** A beat of air after the last card is face-up, before the number lands. */
export const RESULT_BEAT_MS = 90;
/** A beat of air after everything has stopped moving. */
const SETTLE_BEAT_MS = 60;

/** When the card in seat `index` starts to turn. */
export function flipStartsAt(index: number): number {
  return index * FLIP_STAGGER_MS;
}

/** When every card on a table of `seatCount` is face-up. */
export function flipEndsAt(seatCount: number): number {
  return flipStartsAt(Math.max(0, seatCount - 1)) + CARD_FLIP_MS;
}

/**
 * When the card in seat `index` hops.
 *
 * Exactly as it lands, not on a separate clock — the hop *is* the landing, and
 * a gap between the two reads as the card being nudged a second time.
 */
export function hopStartsAt(index: number): number {
  return flipStartsAt(index) + CARD_FLIP_MS;
}

/**
 * When the result numeral stamps in.
 *
 * After the last card is face-up, never during: the payoff of the moment does
 * not land while the thing it is summarizing is still moving.
 */
export function resultStampsAt(seatCount: number): number {
  return flipEndsAt(seatCount) + RESULT_BEAT_MS;
}

/**
 * When the reveal has finished clearing the table.
 *
 * Anything that starts earlier runs underneath cards that are still turning
 * over or still bouncing. One expression, shared: two copies of it would
 * drift, and then one animation starts under the other.
 */
export function revealSettledAt(seatCount: number): number {
  return hopStartsAt(Math.max(0, seatCount - 1)) + CARD_HOP_MS + SETTLE_BEAT_MS;
}

/**
 * Budgeted, not per-item: a fixed stagger makes a full table run for four
 * seconds and the last of them fires long after the eye has moved on.
 */
export function staggerFor(groupCount: number): number {
  return groupCount <= 1 ? 0 : Math.min(110, 420 / (groupCount - 1));
}

export type Disc = { center: Vec; radius: number };

/**
 * Deterministic stand-in for Math.random, keyed by (thrower, axis).
 *
 * Not for the aesthetics — for stability. The table re-renders on every
 * websocket frame, and a fresh random per render would rewrite every emoji's
 * keyframes and restart all of them mid-flight.
 */
function jitter(i: number, axis: number): number {
  const x = Math.sin(i * 311.7 + axis * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * How far above its slot a joining seat starts.
 *
 * A constant, not a measurement: the drop is scale-invariant, so the distance
 * is only a scale factor on a curve whose shape is already fixed — and reading
 * a rect to discover a number the design picked anyway would buy nothing.
 * Roughly one seat plus a little air, matching the harness's start pad.
 */
export const DROP_DISTANCE_PX = 96;

/** How long the row takes to open before anything falls into the gap it made. */
export const FLIP_MS = 260;

/**
 * When a joining seat may start falling, and how far apart several of them go.
 *
 * The FLIP has to be finished first — a seat landing in a slot that is still
 * opening reads as the row shoving it aside. During a reveal the same
 * clearing expression the high-five waits on applies, so a
 * joiner never drops through cards that are still turning over.
 */
export function joinBeats(seatCount: number, joinCount: number, revealed: boolean) {
  return {
    start: (revealed ? revealSettledAt(seatCount) : 0) + FLIP_MS,
    stagger: staggerFor(joinCount),
  };
}

export type PlannedDrop = {
  userId: string;
  delayMs: number;
  durationMs: number;
  distancePx: number;
};

/**
 * Every seat arriving in one envelope, solved but not yet handed to the DOM.
 *
 * Each seat gets its own fall: the distance is jittered, and √d carries that
 * straight into the duration, so no two land at the same instant even before
 * the stagger. The beats are jittered inside their own slot as well, which is
 * what keeps a burst reading as people arriving rather than as a mechanism
 * firing. The last slot is left exactly on its beat so the spread stays inside
 * the stagger budget however the hash falls.
 *
 * The variation is a deterministic hash of the index, never Math.random: the
 * table re-renders on every websocket frame, and a fresh random per render
 * would rewrite each seat's animation and restart the fall halfway down. The
 * drop takes independent hash axes for its height and timing.
 *
 * Nothing coalesces here on purpose either. hub.go already merges presence
 * changes inside 1500ms into a single rebroadcast, so a meeting-start burst
 * arrives as one diff of several ids; a second layer would only fight it.
 */
export function planDropIn({
  joined,
  seatCount,
  revealed,
}: {
  joined: string[];
  seatCount: number;
  revealed: boolean;
}): PlannedDrop[] {
  const { start, stagger } = joinBeats(seatCount, joined.length, revealed);
  const last = joined.length - 1;
  return joined.map((userId, i) => {
    const distancePx = DROP_DISTANCE_PX * (0.85 + jitter(i, 6) * 0.34);
    const slot = i === last ? i : i + jitter(i, 7) * 0.85;
    return {
      userId,
      delayMs: start + slot * stagger,
      durationMs: dropBounce(distancePx).durationMs,
      distancePx,
    };
  });
}

/** How long the row takes to close once the kicked seat has left. */
export const KICK_REFLOW_MS = 420;
/** A beat of air after the reflow before the overlay is emptied. */
const KICK_TEARDOWN_MS = 120;

export type KickGeometry = {
  /** The victim's avatar, in the overlay's own coordinates. */
  avatar: Disc;
  /** The victim's whole seat, in the same coordinates. */
  seat: { x: number; y: number; width: number; height: number };
  bootRadius: number;
  /** What the seat has to get past before the row may close. */
  bounds: Bounds;
};

export type KickPlan = {
  boot: BootSwing;
  launch: { frames: Frame[]; durationMs: number; exitMs: number };
  /** Where the seat's clone starts, in the overlay's coordinates. */
  seatX: number;
  seatY: number;
  velocity: Vec;
  spin: number;
  /** The boot connects: the seat is handed its velocity and starts to travel. */
  impactMs: number;
  /** The seat is fully gone. The row closes here and not a frame earlier. */
  exitMs: number;
  /**
   * The boot is off its arc and out of the picture. Its own ending, gated on
   * its own motion: it is never held on screen waiting for the seat.
   */
  bootEndMs: number;
  /** Everything is over and the overlay can be emptied. */
  endMs: number;
};

/**
 * The whole kick, solved before a single node is created.
 *
 * The boot waits to the RIGHT of its target and swings left, which is a
 * deliberate cost rather than an oversight: for a seat near the right edge it
 * rests over its neighbor, and that is the price of "appears beside the
 * avatar". Time-to-reflow depends on how far the seat has to travel to leave
 * the viewport, so a seat on the right takes noticeably longer than one on the
 * left — correct, not a timing bug, and neither is pinned to a constant.
 *
 * Null where there is nothing to swing at. Every rect is zero in an
 * environment with no layout, and a boot solved against zeroes would be a
 * glyph standing on the felt forever.
 */
export function planKick({ avatar, seat, bootRadius, bounds }: KickGeometry): KickPlan | null {
  if (!(avatar.radius > 0) || !(bootRadius > 0) || !(seat.width > 0) || !(seat.height > 0)) {
    return null;
  }
  // Contact is the avatar's right edge; the boot rests a short way further
  // right, far enough that what the eye sees is an arc rather than a drop.
  const hitRadius = avatar.radius + bootRadius * 0.72;
  const contactCx = avatar.center.x + hitRadius;
  const startCx = contactCx + Math.max(150, avatar.radius * 6);
  const halfChord = (startCx - contactCx) / 2;
  // A high pivot keeps the dip shallow and the contact flat, which is what
  // sends the seat out sideways rather than lobbing it straight up.
  const lift = Math.max(70, halfChord * 1.6);
  const boot = swingBoot({
    pivot: { x: (startCx + contactCx) / 2, y: avatar.center.y - lift },
    radius: Math.hypot(halfChord, lift),
    startAngle: Math.atan2(halfChord, lift),
    target: avatar.center,
    hitRadius,
  });
  if (!boot) return null;

  // The seat inherits the boot's tangential speed at contact, which is why it
  // always leaves up-and-left. Nothing here is a chosen vector.
  const velocity = { x: boot.velocity.x * KICK_TRANSFER, y: boot.velocity.y * KICK_TRANSFER };
  const spin = (velocity.x / 40) * -1;
  const launch = simulateLaunch({ p0: { x: seat.x, y: seat.y }, v: velocity, bounds, spin });
  const impactMs = boot.impactMs;
  const exitMs = impactMs + launch.exitMs;
  return {
    boot,
    launch,
    seatX: seat.x,
    seatY: seat.y,
    velocity,
    spin,
    impactMs,
    exitMs,
    bootEndMs: boot.durationMs,
    endMs: Math.max(boot.durationMs, exitMs + KICK_REFLOW_MS + KICK_TEARDOWN_MS),
  };
}
