import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Envelope } from "../lib/api";
import { spacePath } from "../lib/paths";
import { buttonPrimary, buttonQuiet } from "./Modal";

/** "Oct 29, 5:07 PM" — the date matters, an ended room is revisited later. */
export function endedAtText(endedAt: string): string {
  return new Date(endedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The one ended treatment both core rooms share: heading, when it ended, the
 * room's own summary, and the way out. A link guest's capability is this room
 * alone, so the space link is not offered to one, and a guest is never the
 * facilitator, so Reopen goes with it.
 */
export function EndedBanner({
  env,
  guest,
  isFacilitator,
  onReopen,
  announce,
  children,
}: {
  env: Envelope;
  guest: boolean;
  isFacilitator: boolean;
  onReopen: () => void;
  /** From useJustEnded: this tab watched the room end. */
  announce: boolean;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Watched it end rather than opened it ended: the controls the viewer was
  // using are gone, so focus lands on what replaced them.
  useEffect(() => {
    if (announce) heading.current?.focus();
  }, [announce]);
  return (
    <section className="rounded-panel border border-line bg-surface px-8 py-6 text-center shadow-rest">
      <h2 ref={heading} tabIndex={-1} className="font-display text-2xl">This session has ended</h2>
      <p className="mt-1.5 text-[13px] text-ink-soft">
        Ended {endedAtText(env.endedAt!)}. Its results are saved in the space.
      </p>
      {announce && <p role="status" className="sr-only">This session has ended.</p>}
      {children}
      {!guest && (
        <div className="mt-5 flex justify-center gap-2.5">
          <Link to={spacePath(env.orgSlug, env.spaceSlug)} className={buttonPrimary}>
            Back to the space
          </Link>
          {isFacilitator && (
            <button className={buttonQuiet} onClick={onReopen}>
              Reopen it
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** True once this tab has seen the room go from live to ended; reset by a reopen. */
export function useJustEnded(endedAt: string | null): boolean {
  const [wasLive, setWasLive] = useState(endedAt === null);
  const [just, setJust] = useState(false);
  if (wasLive && endedAt !== null) {
    setWasLive(false);
    setJust(true);
  } else if (!wasLive && endedAt === null) {
    setWasLive(true);
    setJust(false);
  }
  return just;
}
