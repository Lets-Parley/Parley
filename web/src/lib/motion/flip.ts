/**
 * FLIP: the row re-lays-out first, then the seats that moved are animated
 * from where they used to be to where they now are.
 *
 * `flipDeltas` is the whole of it that can be reasoned about — the DOM half
 * only writes two custom properties and an animation shorthand. jsdom returns
 * all-zero rects, so the deltas are what the tests exercise; a FLIP asserted
 * against rendered layout would pass without testing anything.
 */

/** Only the corner matters: a seat is a fixed size, so nothing scales. */
export type Box = { left: number; top: number };

/** Below this a "move" is subpixel rounding, and animating it only flickers. */
const EPSILON = 0.5;

/**
 * How far each seat has to be pushed back to appear not to have moved yet.
 *
 * Seats that are new or gone are absent from the result: a joiner has no
 * previous position to come from, and its own drop is the animation it gets.
 */
export function flipDeltas(
  first: Map<string, Box>,
  last: Map<string, Box>,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  for (const [id, to] of last) {
    const from = first.get(id);
    if (!from) continue;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) continue;
    out.set(id, { dx, dy });
  }
  return out;
}

/**
 * Hand the deltas to the seats and let CSS close the gap.
 *
 * The animation shorthand is identical every time, so it is cleared and a
 * style recalculation forced before it is re-applied — otherwise a second
 * reflow inside one round writes the same declaration and the browser, seeing
 * no change, never restarts it. `offsetWidth` is read for that flush alone and
 * its value is discarded; it is not a geometry read, which is why this does
 * not belong in measure.ts.
 */
export function releaseFlip(
  container: HTMLElement,
  deltas: Map<string, { dx: number; dy: number }>,
  durationMs: number,
): void {
  for (const [id, { dx, dy }] of deltas) {
    const el = container.querySelector<HTMLElement>(`[data-seat-user="${CSS.escape(id)}"]`);
    if (!el) continue;
    el.style.animation = "";
    void el.offsetWidth;
    el.style.setProperty("--flip-dx", `${dx.toFixed(2)}px`);
    el.style.setProperty("--flip-dy", `${dy.toFixed(2)}px`);
    el.style.animation = `seat-flip-release ${Math.round(durationMs)}ms var(--ease-settle) both`;
  }
}
