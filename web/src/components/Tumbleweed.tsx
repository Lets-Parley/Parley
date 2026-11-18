import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  TUMBLEWEED_IDLE_MS,
  WEED_DT,
  bumpyGround,
  gusts,
  makeWeed,
  stepWeed,
  weedAtRest,
  weedRadius,
} from "../lib/motion";

const STILL = { x: 0, y: 0 };

/**
 * A tumbleweed blowing along the felt's bottom edge, in front of the card
 * slots — an overlay, so the felt does not grow for it. After the table sits empty for TUMBLEWEED_IDLE_MS (a per-client
 * timer — decorative, so clients drifting apart is fine) it is simulated live
 * in lib/motion. The first vote kills the wind for good: it rolls off if it
 * still has the speed, or stops where friction leaves it until the round ends.
 * The caller keys this on the round and leaves it out under reduced motion.
 */
export function Tumbleweed({ calm, seed, revealed }: { calm: boolean; seed: number; revealed: boolean }) {
  const laneRef = useRef<HTMLDivElement>(null);
  const weedRef = useRef<HTMLSpanElement>(null);
  const [r, setR] = useState(20);
  const [phase, setPhase] = useState<"wait" | "roll" | "gone">("wait");
  const calmRef = useRef(calm);
  const rRef = useRef(r);
  useLayoutEffect(() => {
    calmRef.current = calm;
    rRef.current = r;
  });

  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const fit = () => setR(weedRadius(lane.clientWidth));
    fit();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(fit);
    ro.observe(lane);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== "wait" || !calm || revealed) return;
    const id = setTimeout(() => setPhase("roll"), TUMBLEWEED_IDLE_MS);
    return () => clearTimeout(id);
  }, [phase, calm, revealed]);

  useEffect(() => {
    const el = weedRef.current;
    const lane = laneRef.current;
    if (phase !== "roll" || !el || !lane) return;
    const rr = rRef.current;
    const width = lane.clientWidth;
    const b = makeWeed(rr);
    const wind = gusts(seed, rr);
    const ground = bumpyGround(rr);
    // Mutable clock for the loop; the step itself is fixed at WEED_DT.
    const clock = { t: 0, acc: 0, last: null as number | null, raf: 0, windDead: false };
    const draw = () => {
      el.style.transform = `translate(${b.x - rr}px, ${-b.y}px) rotate(${b.angle}rad)`;
    };
    const frame = (now: number) => {
      clock.acc += clock.last === null ? 0 : Math.min(0.1, (now - clock.last) / 1000);
      clock.last = now;
      if (!calmRef.current) clock.windDead = true;
      while (clock.acc >= WEED_DT) {
        stepWeed(b, WEED_DT, clock.windDead ? STILL : wind(clock.t), ground);
        clock.t += WEED_DT;
        clock.acc -= WEED_DT;
      }
      draw();
      if (b.x - rr > width) return setPhase("gone");
      if (clock.windDead && weedAtRest(b)) return;
      clock.raf = requestAnimationFrame(frame);
    };
    draw();
    clock.raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(clock.raf);
  }, [phase, seed]);

  const d = 2 * r;
  return (
    // Above the slots, below the pile-on and kick layers, and inside the felt's
    // stacking context, so menus and dialogs stay on top.
    <div aria-hidden ref={laneRef} className="pointer-events-none absolute inset-0 z-[3] overflow-hidden rounded-panel">
      {phase === "roll" && !revealed && (
        <span
          ref={weedRef}
          data-testid="tumbleweed"
          className="absolute bottom-0 left-0 text-ink-soft"
          style={{ width: d, height: d, transform: `translateX(${-d}px)` }}
        >
          {/* An open tangle of branches, not a ring, so the spin reads. */}
          <svg viewBox="0 0 40 40" width={d} height={d} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path strokeWidth="1.5" d="M5 24c0-9 7-17 16-17 5 0 9 3 11 6M36 19c1 7-3 14-11 16M21 36c-7 1-13-3-15-8M8 9c-3 4-5 9-4 13M30 30c3-2 6-6 6-9" />
            <path strokeWidth="1.2" d="M9 12c6 3 9 10 17 9s9-7 9-7M4 25c7-1 12 4 19 2s11-9 13-8" />
            <path strokeWidth="1.1" d="M14 5c-1 7 3 12 2 19s-5 10-4 12M27 6c1 6-4 9-3 16s6 9 5 13" />
            <path strokeWidth="1" d="M8 31c5-6 12-9 18-16 3-3 5-6 6-8M11 9c3 7 9 11 14 17 3 3 6 5 8 6" />
            <path strokeWidth="0.9" d="M20 3l-2 5M35 15l3-2M3 19l4 1M31 34l2 3M16 37l1-4M5 30l-2 3" />
          </svg>
        </span>
      )}
    </div>
  );
}
