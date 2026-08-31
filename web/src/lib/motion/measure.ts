import type { Box } from "./flip";
import type { Disc, KickGeometry, PileOnGeometry } from "./plan";

/**
 * The only place in the motion module that reads layout.
 *
 * Everything downstream is pure arithmetic on the numbers this returns, which
 * is what makes the curves checkable in a test environment that has no layout
 * at all.
 */

/** An element's bounding circle, in the overlay layer's own coordinates. */
function discIn(layer: DOMRect, el: Element): Disc {
  const r = el.getBoundingClientRect();
  return {
    center: { x: r.left + r.width / 2 - layer.left, y: r.top + r.height / 2 - layer.top },
    radius: Math.max(r.width, r.height) / 2,
  };
}

export function measurePileOn({
  layer,
  throwers,
  target,
  emojiRadius,
}: {
  layer: HTMLElement;
  throwers: Element[];
  target: Element;
  emojiRadius: number;
}): PileOnGeometry | null {
  if (throwers.length === 0) return null;
  const box = layer.getBoundingClientRect();
  return {
    seatCount: throwers.length + 1,
    target: discIn(box, target),
    throwers: throwers.map((el) => discIn(box, el)),
    emojiRadius,
    // The emoji is chased until it clears the window, not merely the overlay:
    // the overlay is only as tall as the felt, and an emoji that stops at its
    // edge stops in plain sight.
    bounds: {
      box: { width: emojiRadius * 2, height: emojiRadius * 2 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      offset: { x: box.left, y: box.top },
    },
  };
}

/**
 * The translation a computed `transform` applies, in px.
 *
 * A browser always resolves `transform` to `none`, `matrix(...)` or
 * `matrix3d(...)`, so the two numbers wanted are at fixed positions: the 5th
 * and 6th of a 2D matrix, the 13th and 14th of a 3D one. Anything else is
 * treated as no translation rather than guessed at.
 */
export function translationOf(transform: string | null | undefined): {
  x: number;
  y: number;
} {
  const none = { x: 0, y: 0 };
  if (!transform || transform === "none") return none;
  const open = transform.indexOf("(");
  if (open < 0 || !transform.endsWith(")")) return none;
  const kind = transform.slice(0, open).trim();
  const n = transform
    .slice(open + 1, -1)
    .split(",")
    .map((v) => Number.parseFloat(v));
  const at = kind === "matrix" ? 4 : kind === "matrix3d" ? 12 : -1;
  if (at < 0) return none;
  const x = n[at];
  const y = n[at + 1];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : none;
}

/**
 * Where every seat in a rank container currently sits, keyed by its user id.
 *
 * The *layout* position, which is not what `getBoundingClientRect` returns:
 * the rect includes any transform still on the element, so a seat measured
 * while its own `seat-flip-release` is mid-flight reads back at the position
 * it is animating *from*. Two renders inside one FLIP window then pair a
 * post-layout map against a mid-animation one and produce exactly the negated
 * delta, which relaunches the seat from the far side of its destination. So
 * the live transform is subtracted back off and the layout box is what leaves
 * this function.
 */
export function measureSeats(container: HTMLElement): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-seat-user]")) {
    const id = el.dataset.seatUser;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    const t = translationOf(getComputedStyle(el).transform);
    out.set(id, { left: r.left - t.x, top: r.top - t.y });
  }
  return out;
}

/**
 * Everything the kick needs to know about the screen, read once.
 *
 * The seat's own rect is the box the exit test uses, and the viewport is the
 * window rather than the overlay: the overlay is only as tall as the felt, and
 * a seat that stops at its edge stops in plain sight.
 */
export function measureKick({
  layer,
  seat,
  avatar,
  bootPx,
}: {
  layer: HTMLElement;
  seat: Element;
  avatar: Element;
  bootPx: number;
}): KickGeometry {
  const box = layer.getBoundingClientRect();
  const r = seat.getBoundingClientRect();
  return {
    avatar: discIn(box, avatar),
    seat: { x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height },
    bootRadius: bootPx / 2,
    bounds: {
      box: { width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      offset: { x: box.left, y: box.top },
    },
  };
}
