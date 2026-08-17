import type { ConnectionStatus } from "../lib/socket";

const copy: Record<Exclude<ConnectionStatus, "live">, string> = {
  reconnecting: "Connection lost — reconnecting…",
  stale: "Still reconnecting. What you see may be out of date.",
};

export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status === "live") return null;
  return (
    <div
      role="status"
      className={
        "fixed inset-x-0 top-0 z-50 py-2 text-center text-sm font-bold text-accent-ink " +
        (status === "reconnecting" ? "bg-brass" : "bg-stop")
      }
    >
      {copy[status]}
    </div>
  );
}
