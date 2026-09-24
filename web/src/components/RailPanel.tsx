import { buttonQuiet } from "./Modal";
import { TOUCH_HIT } from "../lib/breakpoints";

/** The one heading voice both panels beside the sessions speak in. */
export const railHeading = "text-[17px] font-bold tracking-tight text-ink";

/**
 * A panel whose read failed. Saying "nothing yet" here would be a claim the
 * page cannot back: it does not know.
 */
export function RailError({
  what,
  onRetry,
  busy,
}: {
  what: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
      <span className="text-pretty">Could not read {what} just now.</span>
      <button
        type="button"
        className={`${TOUCH_HIT} ${buttonQuiet}`}
        disabled={busy}
        onClick={onRetry}
      >
        Retry
      </button>
    </p>
  );
}
