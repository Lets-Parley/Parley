import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TUMBLEWEED_IDLE_MS, WEED_RADIUS, planTumbleweed } from "../lib/motion";

/**
 * A weed that rolls across an idle table. It starts after the table has sat
 * empty for TUMBLEWEED_IDLE_MS (a per-client timer — decorative, so clients
 * drifting apart is fine) and, once started, rolls all the way off even if a
 * vote lands. Reduced motion: there is no resting weed, so nothing renders.
 */
export function Tumbleweed({ idle, seed, reduced }: { idle: boolean; seed: number; reduced: boolean }) {
  const [rolling, setRolling] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!idle || reduced) return;
    const id = setTimeout(() => setRolling(true), TUMBLEWEED_IDLE_MS);
    return () => clearTimeout(id);
  }, [idle, reduced, seed]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!rolling || !el) return;
    const samples = planTumbleweed(seed, el.parentElement?.clientWidth ?? 0);
    const last = samples[samples.length - 1];
    // No WAAPI (jsdom, very old browsers) means no weed.
    if (!last || typeof el.animate !== "function") return setRolling(false);
    const anim = el.animate(
      samples.map((s) => ({
        offset: s.t / last.t,
        transform: `translate(${s.x}px, ${-s.y}px) rotate(${s.angle}rad)`,
      })),
      { duration: last.t * 1000, easing: "linear", fill: "forwards" },
    );
    anim.onfinish = () => setRolling(false);
    return () => anim.cancel();
  }, [rolling, seed]);

  if (!rolling || reduced) return null;
  const d = WEED_RADIUS * 2;
  return (
    // The felt clips it: it enters off one edge and leaves off the other.
    <span aria-hidden className="pointer-events-none absolute inset-0 z-[3] overflow-hidden rounded-panel">
    <span
      ref={ref}
      data-testid="tumbleweed"
      className="absolute bottom-1 left-0 text-ink-faint"
      style={{ width: d, height: d, transform: `translateX(${-d}px)` }}
    >
      <svg viewBox="0 0 24 24" width={d} height={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M4 9c5-3 11 2 16-1M5 16c4 2 9-4 14 0M9 3c-2 6 4 12 1 18M15 3c2 5-5 11-1 18" />
      </svg>
    </span>
    </span>
  );
}
