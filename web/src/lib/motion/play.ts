import type { KickPlan, PileOnPlan } from "./plan";

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

/** Matches the inline font-size below; a rect read here would only re-measure it. */
export const BOOT_PX = 52;

/**
 * The kick: the boot's arc, the seat's launch, and the two beats the row is
 * gated on.
 *
 * The seat is CLONED into the overlay rather than moved. The original stays in
 * the row, held invisible, so the gap it leaves does not close while the eye
 * is still following the thing that made it — the row is released at `onExit`,
 * when the seat is fully off screen, and never at contact.
 */
export function playKick(
  layer: HTMLElement,
  plan: KickPlan,
  seat: HTMLElement,
  { onContact, onExit }: { onContact: () => void; onExit: () => void },
): () => void {
  const running: Animation[] = [];
  const timers: number[] = [];

  const boot = document.createElement("span");
  boot.setAttribute("aria-hidden", "true");
  boot.className = "pointer-events-none absolute leading-none";
  boot.style.left = `${plan.boot.origin.x - BOOT_PX / 2}px`;
  boot.style.top = `${plan.boot.origin.y - BOOT_PX / 2}px`;
  boot.style.fontSize = `${BOOT_PX}px`;
  boot.style.transformOrigin = "center center";
  boot.textContent = "🥾";
  layer.appendChild(boot);
  if (typeof boot.animate === "function") {
    running.push(
      boot.animate(plan.boot.frames, {
        duration: plan.boot.durationMs,
        // Linear on purpose: the dip and the rise are gravity in the sampled
        // frames, not an easing curve laid over them.
        easing: "linear",
        fill: "forwards",
      }),
    );
  }

  timers.push(
    window.setTimeout(() => {
      onContact();
      const clone = seat.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-seat-user");
      clone.setAttribute("aria-hidden", "true");
      clone.style.position = "absolute";
      clone.style.left = `${plan.seatX}px`;
      clone.style.top = `${plan.seatY}px`;
      clone.style.margin = "0";
      clone.style.visibility = "visible";
      clone.style.animation = "";
      clone.style.transformOrigin = "center center";
      layer.appendChild(clone);
      if (typeof clone.animate === "function") {
        running.push(
          clone.animate(plan.launch.frames, {
            duration: plan.launch.durationMs,
            easing: "linear",
            fill: "forwards",
          }),
        );
      }
    }, Math.round(plan.impactMs)),
  );

  // The boot goes when the boot is done. Left in the overlay it would hold its
  // last frame, visible, until the seat's flight released the layer.
  timers.push(window.setTimeout(() => boot.remove(), Math.round(plan.bootEndMs)));

  timers.push(window.setTimeout(onExit, Math.round(plan.exitMs)));
  timers.push(window.setTimeout(() => layer.replaceChildren(), Math.round(plan.endMs)));

  return () => {
    for (const t of timers) window.clearTimeout(t);
    for (const a of running) a.cancel();
    layer.replaceChildren();
  };
}
