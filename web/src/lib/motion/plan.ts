import { simulateThrow, type Frame, type Vec } from "./physics";

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

/**
 * When the reveal has finished clearing the table.
 *
 * flip-in is staggered by seat index and card-hop runs 450ms from 620+i*40, so
 * anything that starts earlier runs underneath cards that are still turning
 * over. One expression, shared: two copies of it would drift, and then one
 * animation starts under the other.
 */
export function revealSettledAt(seatCount: number): number {
  return 620 + Math.max(0, seatCount - 1) * 40 + 450 + 60;
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
export function planPileOn({
  seatCount,
  target,
  throwers,
  emojiRadius,
}: PileOnGeometry): PileOnPlan {
  const { start, stagger } = pileOnBeats(seatCount, throwers.length);
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
    });
    return {
      emoji: PILE_ON_EMOJI[Math.floor(jitter(i, 4) * PILE_ON_EMOJI.length)],
      originX: p0.x,
      originY: p0.y,
      delayMs: start + i * stagger,
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
