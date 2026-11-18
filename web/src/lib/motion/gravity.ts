/**
 * Gravity cards: after a reveal each numeric card sinks into the felt by its
 * rank in the deck, the top value deepest. The settle is a damped mass on a
 * spring under its own weight, integrated at a fixed step with semi-implicit
 * Euler: heavier cards drop lower, ring a little longer, and come to rest.
 */

/** About 14 px at a 1280 px layout, where the felt is about 860 px wide. */
export function maxSink(feltWidth: number): number {
  return (14 * feltWidth) / 860;
}

/** The deck's numeric values, in deck order. `?`, coffee and other specials drop out. */
function numericValues(deck: readonly string[]): string[] {
  return deck.filter((v) => v.trim() !== "" && Number.isFinite(Number(v)));
}

/** How far a revealed card sinks: max × rank / (numericCount − 1). Specials stay put. */
export function sinkDepth(value: string | undefined, deck: readonly string[], feltWidth: number): number {
  const nums = numericValues(deck);
  const rank = value === undefined ? -1 : nums.indexOf(value);
  if (rank < 0 || nums.length < 2) return 0;
  return (maxSink(feltWidth) * rank) / (nums.length - 1);
}

/** Per-seat depths. Before the reveal nothing sinks, whatever the payload holds. */
export function sinkOffsets(
  revealed: boolean,
  votes: ReadonlyMap<string, string>,
  deck: readonly string[],
  feltWidth: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, v] of votes) out.set(id, revealed ? sinkDepth(v, deck, feltWidth) : 0);
  return out;
}

export type Sink = { y: number; v: number; m: number; k: number; c: number; g: number };

/** Fixed integrator step. */
export const SINK_DT = 1 / 240;
const K = 145;
const C = 17.7;
/** Static friction with the felt: inside this, a card stops dead at rest. */
const REST_PX = 0.1;
const REST_SPEED = 1;

/**
 * A card of mass 1 (lowest) to 1.5 (top value), whose weight on the spring
 * rests it at `depth`: m·g = k·depth. ζ = c / 2√(km) runs 0.73 → 0.6, so the
 * heaviest card drops in about 0.4 s, overshoots under 10%, and its second
 * swing is far below a pixel; friction then stops it.
 */
export function makeSink(depth: number, weight: number): Sink {
  const m = 1 + 0.5 * Math.max(0, Math.min(1, weight));
  return { y: 0, v: 0, m, k: K, c: C, g: (K * depth) / m };
}

export function sinkRest(s: Sink): number {
  return (s.m * s.g) / s.k;
}

/** One fixed step. Mutates and returns `s`. Snaps to rest once inside the friction band. */
export function stepSink(s: Sink, dt: number): Sink {
  if (sinkAtRest(s)) return s;
  s.v += (s.g - (s.k * s.y + s.c * s.v) / s.m) * dt;
  s.y += s.v * dt;
  const rest = sinkRest(s);
  if (Math.abs(s.y - rest) < REST_PX && Math.abs(s.v) < REST_SPEED) {
    s.y = rest;
    s.v = 0;
  }
  return s;
}

export function sinkAtRest(s: Sink): boolean {
  return s.v === 0 && s.y === sinkRest(s);
}
