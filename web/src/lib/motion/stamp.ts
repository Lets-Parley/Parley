/**
 * Certified Guesswork: the stamp swings down on a hinge at its left edge like
 * a slammed lid, strikes the card flat, bounces with restitution and settles.
 *
 * a is the lift above the card in radians. A uniform bar hinged at one end
 * falls as a'' = -(3g / 2L)·cos a: hardest near the card, gentlest when held
 * high. Each strike keeps `STAMP_RESTITUTION` of the speed, so every rebound
 * is shorter in height *and* time; the swing ends when a rebound is too slow
 * to leave the card — no fade, no fixed duration.
 */

import { GRAVITY } from "./physics";

export const STAMP_DT = 1 / 240;
export const STAMP_RESTITUTION = 0.4;
/** A strike slower than this (rad/s) cannot lift the stamp: it stays down. */
const REST_W = 0.5;
/** A swing that has not settled by now is put down anyway. */
const CAP_S = 2;

export type Stamp = { a: number; w: number };

/** One fixed step. Mutates and returns `s`; true in `hit` when it struck the card. */
export function stepStamp(s: Stamp, k: number, dt: number): { s: Stamp; hit: boolean } {
  if (s.a === 0 && s.w === 0) return { s, hit: false };
  s.w -= k * Math.cos(s.a) * dt;
  s.a += s.w * dt;
  if (s.a > 0) return { s, hit: false };
  const rebound = -s.w * STAMP_RESTITUTION;
  s.a = 0;
  s.w = rebound < REST_W ? 0 : rebound;
  return { s, hit: true };
}

/** The whole swing from rest at `lift` radians, for a stamp `length` px wide. */
export function simulateStamp(lift: number, length: number) {
  const k = (3 * GRAVITY) / (2 * length);
  const s: Stamp = { a: lift, w: 0 };
  const path = [{ t: 0, a: lift }];
  const hits: number[] = [];
  for (let step = 1; step * STAMP_DT <= CAP_S; step++) {
    const t = step * STAMP_DT;
    if (stepStamp(s, k, STAMP_DT).hit) hits.push(t);
    path.push({ t, a: s.a });
    if (s.a === 0 && s.w === 0) break;
  }
  const end = path[path.length - 1].t;
  // Rotate the hinge up (counterclockwise on screen) by the lift.
  const frames = path.map(({ t, a }) => ({ offset: t / end, transform: `rotate(${((-a * 180) / Math.PI).toFixed(2)}deg)` }));
  frames[frames.length - 1].transform = "rotate(0deg)";
  return { frames, durationMs: end * 1000, impactsMs: hits.map((t) => t * 1000) };
}
