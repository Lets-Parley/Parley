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
