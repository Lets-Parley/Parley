import { useEffect, useState, type ReactNode } from "react";
import { buttonQuiet } from "./Modal";

const ESCALATE_AFTER_MS = 10_000;

/** A loading line that owns up after ten seconds, so a dead server is not an endless spinner. */
export function Pending({ children }: { children: ReactNode }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), ESCALATE_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center text-ink-soft">
      <p role="status">{slow ? "Still loading. Check your connection, then reload." : children}</p>
      {slow && (
        <button type="button" className={buttonQuiet} onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}
