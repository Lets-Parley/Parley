import type { Box } from "./flip";
import type { Disc, PileOnGeometry } from "./plan";

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
  };
}

/** Where every seat in a rank container currently sits, keyed by its user id. */
export function measureSeats(container: HTMLElement): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-seat-user]")) {
    const id = el.dataset.seatUser;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    out.set(id, { left: r.left, top: r.top });
  }
  return out;
}
