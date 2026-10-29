import type { ConnectionStatus } from "../lib/socket";
import { TOUCH_HIT } from "../lib/breakpoints";

// Named failures only. Each banner says what happened, what it means for your
// vote, and — when there's something to do — offers the one action.
export function ConnectionBanner({
  status,
  onRetry,
}: {
  status: ConnectionStatus;
  onRetry?: () => void;
}) {
  // A room removal has the room's own screen — a banner over the top of it
  // would say the same thing twice, in a smaller voice.
  if (status === "live" || status === "kicked") return null;
  const removed = status === "removed";
  const stale = status === "stale" || removed;
  // Zero height in the flow, so the banner arriving or leaving moves nothing;
  // the bar itself floats over the top of what follows. Text is the page ink on
  // the tint, measured at 12.5:1 (light) and 11.0:1 (dark) for the stale tint.
  return (
    <div className="relative z-30 h-0 shrink-0">
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-x-0 top-0 flex items-center justify-center gap-2.5 border-b border-line px-5 py-2.5 text-[13px] font-semibold shadow-rest"
      style={{
        background: stale
          ? "color-mix(in oklab, var(--color-stop) 14%, var(--color-surface))"
          : "var(--color-accent-soft)",
      }}
    >
      <span className={"h-2 w-2 shrink-0 rounded-full " + (stale ? "bg-stop" : "bg-accent")} />
      {removed
        ? "You no longer have access to this space — an owner removed you. Ask them for an invite to rejoin."
        : stale
          ? "Connection lost — showing the table as it last stood. Votes may be out of date."
          : "Reconnecting — your vote is safe."}
      {removed && (
        /* A dead end needs a door. Everything else on this page belongs to a
           space this person is no longer in. */
        <a
          href="/"
          className={`${TOUCH_HIT} inline-flex items-center rounded-full border border-line bg-surface px-4 text-xs font-bold hover:bg-surface-hi`}
        >
          Back to Parley
        </a>
      )}
      {stale && !removed && onRetry && (
        <button
          onClick={onRetry}
          className={`${TOUCH_HIT} inline-flex items-center rounded-full border border-line bg-surface px-4 text-xs font-bold hover:bg-surface-hi`}
        >
          Retry now
        </button>
      )}
    </div>
    </div>
  );
}
