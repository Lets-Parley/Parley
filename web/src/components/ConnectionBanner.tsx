import type { ConnectionStatus } from "../lib/socket";

// Named failures only. Each banner says what happened, what it means for your
// vote, and — when there's something to do — offers the one action.
export function ConnectionBanner({
  status,
  onRetry,
}: {
  status: ConnectionStatus;
  onRetry?: () => void;
}) {
  if (status === "live") return null;
  const removed = status === "removed";
  const stale = status === "stale" || removed;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-center gap-2.5 border-b border-line px-5 py-2.5 text-[13px] font-semibold"
      style={{
        background: stale
          ? "color-mix(in oklab, var(--color-stop) 14%, var(--color-surface))"
          : "color-mix(in oklab, var(--color-brass) 18%, var(--color-surface))",
      }}
    >
      <span className={"h-2 w-2 shrink-0 rounded-full " + (stale ? "bg-stop" : "bg-brass")} />
      {removed
        ? "You no longer have access to this space — an owner removed you. Ask them for an invite to rejoin."
        : stale
          ? "Connection lost — showing the table as it last stood. Votes may be out of date."
          : "Reconnecting — your vote is safe."}
      {stale && !removed && onRetry && (
        <button
          onClick={onRetry}
          className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-bold hover:bg-surface-hi"
        >
          Retry now
        </button>
      )}
    </div>
  );
}
