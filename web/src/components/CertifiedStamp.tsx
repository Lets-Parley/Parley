import { useEffect, useRef } from "react";
import { simulateStamp } from "../lib/motion/stamp";

/**
 * Certified Guesswork, decoration only. "swing" runs the hinge sim once on
 * mount; the resting pose is plain CSS, so a cancelled or skipped animation
 * still leaves the ink where it lands.
 */
export function CertifiedStamp({ swing }: { swing: boolean }) {
  const ink = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ink.current;
    if (!swing || !el?.animate) return;
    const { frames, durationMs } = simulateStamp(1.1, el.offsetWidth || 120);
    const run = el.animate(frames, { duration: durationMs, easing: "linear" });
    return () => run.cancel();
  }, [swing]);
  return (
    <span className="certified-stamp" data-stamp={swing ? "swing" : "ink"} aria-hidden="true">
      <span ref={ink}>Certified guesswork</span>
    </span>
  );
}
