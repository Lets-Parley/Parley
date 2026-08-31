import type { PileOnPlan } from "./plan";

/**
 * The WAAPI adapter and the overlay's lifetime.
 *
 * CSS keyframes are the default everywhere in this product. WAAPI is permitted
 * only where the *shape* of a curve — not merely its magnitude — depends on
 * measured geometry, which is exactly what a thrown arc between two seats is:
 * the seats move as the table wraps, and no static keyframe can know where.
 *
 * The adapter is feature-detected, which is also the test seam: jsdom does not
 * implement Element.animate, so the physics still runs and the DOM call
 * no-ops. WAAPI does not schedule through requestAnimationFrame either, so the
 * table's "nothing schedules frames behind its back" guarantee survives.
 */

/** Matches the inline font-size below; a rect read here would only re-measure it. */
export const EMOJI_PX = 24;
export const EMOJI_RADIUS = EMOJI_PX / 2;

export function playPileOn(layer: HTMLElement, plan: PileOnPlan): () => void {
  const running: Animation[] = [];
  for (const t of plan.throws) {
    const el = document.createElement("span");
    el.className = "pointer-events-none absolute leading-none";
    el.style.left = `${t.originX - EMOJI_RADIUS}px`;
    el.style.top = `${t.originY - EMOJI_RADIUS}px`;
    el.style.fontSize = `${EMOJI_PX}px`;
    el.style.opacity = "0";
    el.textContent = t.emoji;
    layer.appendChild(el);
    if (typeof el.animate !== "function") continue;
    running.push(
      el.animate(t.frames, {
        duration: t.durationMs,
        delay: t.delayMs,
        // Linear on purpose: fast-slow-fast is gravity in the sampled frames,
        // not an easing curve laid over them.
        easing: "linear",
        fill: "forwards",
      }),
    );
  }
  // The overlay outlives nothing: it is torn down a beat after the last emoji
  // has faded, whether or not anything re-renders.
  const timer = window.setTimeout(() => layer.replaceChildren(), Math.round(plan.endMs) + 250);
  return () => {
    window.clearTimeout(timer);
    for (const a of running) a.cancel();
    layer.replaceChildren();
  };
}
