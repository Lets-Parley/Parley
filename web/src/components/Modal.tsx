import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";
import { TOUCH_HIT } from "../lib/breakpoints";

/**
 * Whether a pointer event landed outside the dialog's own box. A click on the
 * backdrop is dispatched at the <dialog> element itself, so the target alone
 * cannot tell the backdrop from the dialog's padding — the coordinates can.
 */
function onBackdrop(el: HTMLDialogElement, e: { clientX: number; clientY: number }) {
  const r = el.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

/**
 * A native <dialog>: focus trapping, Escape-to-close and inertness of the rest
 * of the page all come from the platform. Backdrop-click-to-close is the one
 * dismissal <dialog> does not offer, so it is added here — people expect the
 * dim area to be dead space they can click out through.
 */
export function Modal({
  title,
  children,
  onClose,
  width = "26rem",
  opaque = false,
  anchor = "center",
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  width?: string;
  /** Solid cover — use when the dialog sits over secrets (passcode, roster)
   *  that a translucent scrim would leave shoulder-readable. */
  opaque?: boolean;
  /** "top" pins the top edge so a dialog whose height changes does not
   *  re-center under the pointer. "side" is a panel on the right edge, and a
   *  bottom sheet on a narrow screen. */
  anchor?: "center" | "top" | "side";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /* The press must have started on the backdrop too: a drag-select that begins
     in a field and ends past the edge is not a dismissal. */
  const pressedBackdrop = useRef(false);
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
    if (ref.current && !ref.current.open) {
      ref.current.showModal();
      // showModal() focuses the first focusable element, which is the ✕, and
      // it runs after React's autoFocus. Start on the marked safe action or
      // the first field instead.
      const usable = (el: HTMLElement) =>
        !(el as HTMLInputElement).disabled &&
        (el as HTMLInputElement).type !== "hidden" &&
        !el.classList.contains("sr-only") &&
        // jsdom has no layout and no checkVisibility; treat it as visible there.
        (el.checkVisibility?.() ?? true);
      const d = ref.current;
      const first = (sel: string) => [...d.querySelectorAll<HTMLElement>(sel)].find(usable);
      (first("[data-autofocus]") ?? first("input, textarea, select"))?.focus();
    }
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
         the close event alone reports it.

         With no onClose there is no ✕ and nowhere for a dismissal to be
         reported, so closing would only strand the user behind a blank page.
         Such a modal is simply not dismissable: cancel the cancel. */
      onCancel={(e) => {
        e.preventDefault();
        if (onClose) e.currentTarget.close();
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget && onBackdrop(e.currentTarget, e);
      }}
      onClick={(e) => {
        if (!onClose || !pressedBackdrop.current) return;
        if (e.target === e.currentTarget && onBackdrop(e.currentTarget, e)) onClose();
      }}
      aria-labelledby={titleId}
      className={
        "relative rounded-panel border border-line bg-surface text-ink shadow-lift " +
        (anchor === "side" ? "p-0 " : "p-6 ") +
        (anchor === "top"
          ? "mx-auto mb-auto mt-[12dvh] max-h-[calc(100dvh-12dvh-1rem)] "
          : anchor === "side"
            ? /* Below md, a bottom sheet: edge to edge, square at the bottom. */
              "mx-0 mb-0 mt-auto max-h-[90dvh] w-full max-w-full overflow-y-auto max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:w-full md:mr-0 md:ml-auto md:my-0 md:h-dvh md:max-h-dvh md:w-(--modal-w) "
            : "m-auto ") +
        (opaque
          ? "backdrop:bg-surface backdrop:backdrop-blur-none"
          : "backdrop:bg-card-back/50")
      }
      style={{
        ...(anchor === "side" ? { "--modal-w": `min(92vw, ${width})` } : { width: `min(92vw, ${width})` }),
        animation: "modal-drop 280ms var(--ease-settle)",
      } as CSSProperties}
    >
      {anchor === "side" ? (
        <>
          {/* A side panel scrolls, so its title and ✕ sit on a solid bar the
              content passes under, rather than scrolling away. */}
          <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-6 pb-2 pt-4">
            <h2 id={titleId} className="min-w-0 flex-1 text-[19px] font-bold tracking-tight">
              {title}
            </h2>
            {onClose && (
              <button
                onClick={onClose}
                aria-label="Close"
                className={`${TOUCH_HIT} flex shrink-0 items-center justify-center text-[13px] text-ink-faint hover:text-ink`}
              >
                ✕
              </button>
            )}
          </div>
          <div className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</div>
        </>
      ) : (
        <>
      <h2 id={titleId} className="mb-1 text-[19px] font-bold tracking-tight">
        {title}
      </h2>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className={`${TOUCH_HIT} absolute right-2 top-2 flex items-center justify-center text-[13px] text-ink-faint hover:text-ink`}
        >
          ✕
        </button>
      )}
      {children}
        </>
      )}
    </dialog>
  );
}

/* Pills, not rectangles — every control on the table is a chip you could pick up. */
export const buttonPrimary =
  "rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift disabled:opacity-50 disabled:shadow-rest";
export const buttonQuiet =
  "rounded-full border border-line-strong px-4 py-2 text-sm font-bold text-ink-soft transition hover:bg-felt-deep disabled:opacity-50";
export const buttonDanger =
  "rounded-full bg-stop px-4 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift";
export const buttonGo =
  "rounded-full bg-go px-4 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift";
export const inputClass =
  "w-full rounded-chip border border-line-strong bg-surface-hi px-3.5 py-2.5 text-sm text-ink focus-visible:border-accent";
/* The label spec itself, with no spacing opinion — for labels that sit inside
   a flex column where the stack, not the margin, owns the rhythm. */
export const labelText = "font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint";
export const labelClass = "mb-2 mt-4 block " + labelText;

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
