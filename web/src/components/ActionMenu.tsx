import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// An engine without the popover API would hide a [popover] for good; there the
// list is an ordinary positioned box that Escape, an outside press, or the
// trigger closes.
const canPopover = () => typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

/**
 * A button that opens a short list of actions, on the platform's own popover:
 * top layer, light dismiss and Escape come free. A disclosure, not an ARIA
 * menu: the items are ordinary links and buttons in the tab order. Items close
 * the popover after they run so a modal they open is never stacked under it,
 * and tabbing out closes it. The list is only mounted while open, so closed
 * it is out of the tab order and the tree.
 */
export function ActionMenu({
  label,
  trigger,
  triggerClassName,
  children,
}: {
  /** Accessible name of the trigger and of the list. */
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dismiss = () => {
    if (canPopover() && pop.current?.matches(":popover-open")) pop.current.hidePopover();
    setIsOpen(false);
  };
  const close = () => {
    dismiss();
    button.current?.focus();
  };

  useLayoutEffect(() => {
    const el = pop.current;
    if (!isOpen || !el || !button.current) return;
    if (canPopover() && !el.matches(":popover-open")) el.showPopover();
    // Positioned by hand until CSS anchor positioning ships in every engine.
    const r = button.current.getBoundingClientRect();
    const w = el.offsetWidth;
    const below = Math.max(0, window.innerHeight - r.bottom - 14);
    const above = Math.max(0, r.top - 14);
    const placeAbove = el.offsetHeight > below && above > below;
    const available = placeAbove ? above : below;
    const height = Math.min(el.offsetHeight, available);
    el.style.maxHeight = `${available}px`;
    el.style.overflowY = "auto";
    el.style.top = `${Math.max(8, placeAbove ? r.top - height - 6 : r.bottom + 6)}px`;
    el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    el.querySelector<HTMLElement>("a[href], button:not(:disabled)")?.focus({ preventScroll: true });
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onMove = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && pop.current?.contains(event.target)) return;
      if (pop.current?.contains(document.activeElement)) close();
      else dismiss();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [isOpen]);

  // Without the popover API nothing else dismisses the list.
  useLayoutEffect(() => {
    if (!isOpen || canPopover()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPress = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={button}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {isOpen && (
        <div
          ref={pop}
          id={id}
          popover={canPopover() ? "auto" : undefined}
          role="group"
          aria-label={label}
          onToggle={(e) => {
            if ((e as unknown as ToggleEvent).newState === "closed") setIsOpen(false);
          }}
          onBlur={(e) => {
            const next = e.relatedTarget as HTMLElement | null;
            // The trigger toggles the list itself; closing here too would reopen it.
            if (next && !e.currentTarget.contains(next) && next.id !== triggerId) dismiss();
          }}
          className="fixed z-[60] m-0 w-max min-w-56 max-w-[calc(100vw-16px)] rounded-card border border-line bg-surface-hi p-1.5 text-sm text-ink shadow-lift"
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

export const menuItem =
  "flex min-h-11 w-full items-center gap-2 rounded-chip px-3 text-left font-semibold text-ink-soft hover:bg-felt-deep hover:text-ink focus-visible:bg-felt-deep active:bg-felt-deep disabled:opacity-50 aria-disabled:opacity-50";

export function MenuDivider() {
  return <hr role="separator" className="my-1 border-line" />;
}
