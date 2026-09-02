import {
  KICK_TRANSFER,
  dropBounce,
  simulateLaunch,
  simulateThrow,
  swingBoot,
  type BootSwing,
  type Bounds,
  type Frame,
  type Vec,
} from "./physics";

/**
 * Playfully cross and classic heckling, never mocking — this fires
 * automatically at a named colleague, so ridicule is out where teasing is in.
 * Sixteen, so a pile-on of up to thirteen throwers rarely repeats itself.
 *
 * Two rules for anything added here: nothing that collides with the deck (☕ is
 * a card value, so drink glyphs are out — a flying emoji must never read as
 * somebody's vote), and it has to read against `--color-felt-deep`.
 */
export const PILE_ON_EMOJI = [
  "😤", "😠", "🙄", "🤨", "😒", "🤦", "🥱",
  "👎", "💢", "🚩",
  "🍅", "🥚", "🥧", "🍞", "🍌", "🍋",
];

/** Excluded from consensus by internal/poker/stats.go, and from this too. */
const SPECIAL = new Set(["?", "coffee"]);

/**
 * Below this, "all but one agree" is trivially true on nearly every split
 * reveal, and singling somebody out for it is just noise.
 */
const MIN_VOTERS = 4;

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
/** A beat of air after the last card is face-up, before the number lands. */
const RESULT_BEAT_MS = 90;
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
 * not land while the thing it is summarising is still moving.
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

export function pileOnBeats(seatCount: number, throwerCount: number) {
  return { start: revealSettledAt(seatCount), stagger: staggerFor(throwerCount) };
}

export type Ballot = { userId: string; value: string };

/**
 * The one person everybody else disagreed with, or null.
 *
 * Null at unanimity and null with two dissenters — consensus already has its
 * own celebration, and a genuine split is not a pile-on. A special card as the
 * *dissent* still counts: shrugging when five people said 5 is a dissent.
 */
export function pileOnOutlier(ballots: Ballot[]): string | null {
  if (ballots.length < MIN_VOTERS) return null;
  const counts = new Map<string, number>();
  for (const b of ballots) counts.set(b.value, (counts.get(b.value) ?? 0) + 1);
  const majority = ballots.length - 1;
  for (const [value, count] of counts) {
    if (count !== majority || SPECIAL.has(value)) continue;
    return ballots.find((b) => b.value !== value)?.userId ?? null;
  }
  return null;
}

export type Disc = { center: Vec; radius: number };

export type PileOnGeometry = {
  /** Every seat still on the table, so the throws clear the last card. */
  seatCount: number;
  target: Disc;
  throwers: Disc[];
  emojiRadius: number;
  /** Where the emoji has to get to before it counts as gone. */
  bounds: Bounds;
};

export type PlannedThrow = {
  emoji: string;
  /** Where the emoji's centre starts, in the overlay's own coordinates. */
  originX: number;
  originY: number;
  frames: Frame[];
  delayMs: number;
  durationMs: number;
  impactMs: number;
};

export type PileOnPlan = { throws: PlannedThrow[]; impactMs: number; endMs: number };

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

/** Every throw of one pile-on, solved but not yet handed to the DOM. */
/**
 * Where each throw is released, relative to the first.
 *
 * A fixed gap lands every impact on the same beat, which is what made the
 * pile-on read as a machine gun rather than a room. The gaps are jittered
 * around the budgeted stagger and then normalised back onto it, so the last
 * emoji still leaves at exactly the same moment a uniform stagger would.
 */
function offsets(count: number, stagger: number): number[] {
  const gaps = Array.from({ length: Math.max(0, count - 1) }, (_, i) => 0.6 + jitter(i, 5) * 0.8);
  const total = gaps.reduce((a, b) => a + b, 0);
  const scale = total > 0 ? (stagger * (count - 1)) / total : 0;
  let at = 0;
  return [0, ...gaps.map((g) => (at += g * scale))];
}

export function planPileOn({
  seatCount,
  target,
  throwers,
  emojiRadius,
  bounds,
}: PileOnGeometry): PileOnPlan {
  const { start, stagger } = pileOnBeats(seatCount, throwers.length);
  const delays = offsets(throwers.length, stagger);
  const throws = throwers.map((from, i) => {
    const aim = { x: target.center.x - from.center.x, y: target.center.y - from.center.y };
    const aimLen = Math.hypot(aim.x, aim.y) || 1;
    // Released from the edge of the thrower's own disc, facing the target,
    // rather than from somewhere inside their face.
    const p0 = {
      x: from.center.x + (aim.x / aimLen) * from.radius,
      y: from.center.y + (aim.y / aimLen) * from.radius,
    };
    // Apex scales with the distance thrown, which is what makes a long throw
    // read as a lob rather than a flat pitch.
    const rise = Math.min(150, Math.max(50, aimLen * 0.38)) * (0.85 + jitter(i, 1) * 0.3);
    const spin = (jitter(i, 2) > 0.5 ? 1 : -1) * (120 + jitter(i, 3) * 220);
    const solved = simulateThrow({
      p0,
      center: target.center,
      hitRadius: target.radius + emojiRadius,
      rise,
      spin,
      bounds,
    });
    return {
      emoji: PILE_ON_EMOJI[Math.floor(jitter(i, 4) * PILE_ON_EMOJI.length)],
      originX: p0.x,
      originY: p0.y,
      delayMs: start + delays[i],
      ...solved,
    };
  });
  return {
    // The disc reacts when something actually reaches it, and is cleared when
    // the slowest throw is done.
    impactMs: throws.reduce((m, t) => Math.min(m, t.delayMs + t.impactMs), Infinity),
    endMs: throws.reduce((m, t) => Math.max(m, t.delayMs + t.durationMs), 0),
    throws,
  };
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
 * clearing expression the pile-on and the high-five wait on applies, so a
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
 * drop takes hash axes 6 and 7, kept clear of the ones the pile-on throws use,
 * so a join burst and a reveal pile-on never share a random sequence.
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
 * rests over its neighbour, and that is the price of "appears beside the
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
