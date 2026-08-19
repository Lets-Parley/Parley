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
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    // Unmounting the dialog drops focus to <body> instead of restoring it,
    // so hand it back to whatever opened the modal.
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
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
  "w-full rounded-chip border border-line bg-surface-hi px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent";
export const labelClass =
  "mb-2 mt-4 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint";
