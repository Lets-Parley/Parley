import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * A native <dialog>: focus trapping, Escape-to-close and inertness of the rest
 * of the page all come from the platform. Backdrop-click-to-close is
 * deliberately not re-implemented — <dialog> does not offer it, and Escape plus
 * the ✕ are two dismissals already.
 */
export function Modal({
  title,
  children,
  onClose,
  width = "26rem",
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  width?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    // Whoever had focus before the dialog took it. Never a control inside the
    // dialog: React remounts this effect without tearing the dialog down, and
    // by then focus already sits on the close button — recording that would
    // hand focus to a node that is about to be removed.
    if (!opener.current && active && !ref.current?.contains(active)) {
      opener.current = active;
    }
    // Only if it is not already open: a real <dialog> throws InvalidStateError
    // on a second showModal(), and the throw would abandon the cleanup below.
    if (ref.current && !ref.current.open) ref.current.showModal();
    // Unmounting the dialog drops focus to <body> instead of restoring it,
    // so hand it back to whatever opened the modal.
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      /* Escape fires cancel and then, once the dialog actually closes, close.
         Reporting both handed the caller one dismissal twice — a duplicate
         write under commit-on-close — so cancel only performs the close, and
         the close event alone reports it. */
      onCancel={(e) => {
        e.preventDefault();
        e.currentTarget.close();
      }}
      aria-labelledby={titleId}
      className="relative m-auto rounded-panel border border-line bg-surface p-6 text-ink shadow-lift backdrop:bg-card-back/40 backdrop:backdrop-blur-[4px]"
      style={{ width: `min(92vw, ${width})`, animation: "modal-drop 280ms var(--ease-settle)" }}
    >
      <h2 id={titleId} className="mb-1 text-[19px] font-extrabold tracking-tight">
        {title}
      </h2>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3 text-[13px] text-ink-faint hover:text-ink"
        >
          ✕
        </button>
      )}
      {children}
    </dialog>
  );
}

/* Pills, not rectangles — every control on the table is a chip you could pick up. */
export const buttonPrimary =
  "rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift disabled:opacity-50 disabled:shadow-rest";
export const buttonQuiet =
  "rounded-full border border-line px-4 py-2 text-sm font-bold text-ink-soft transition hover:bg-felt-deep disabled:opacity-50";
export const buttonDanger =
  "rounded-full bg-stop px-4 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift";
export const buttonGo =
  "rounded-full bg-go px-4 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift";
export const inputClass =
  "w-full rounded-chip border border-line bg-surface-hi px-3.5 py-2.5 text-sm text-ink focus-visible:border-accent";
export const labelClass =
  "mb-2 mt-4 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint";

/** What failed, where it failed, and how to try it again. */
export type Fail = { msg: string; retry?: () => Promise<unknown> };

/**
 * An error row that sits with the control that failed. One string in the middle
 * of the page meant a failed "Deal" in the right-hand aside printed its reason
 * in the left column, often below the fold.
 */
export function ErrorRow({
  fail,
  onDismiss,
  onRetry,
}: {
  fail: Fail;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-chip px-3 py-2 text-[13px] font-bold text-stop"
      style={{ background: "color-mix(in oklab, var(--color-stop) 12%, var(--color-surface))" }}
    >
      <span className="min-w-0 flex-1">{fail.msg}</span>
      {fail.retry && onRetry && (
        <button onClick={onRetry} className="shrink-0 font-bold underline hover:no-underline">
          Try again
        </button>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0 px-1 text-ink-faint hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
