import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// An engine without the popover API would hide a [popover] for good; there the
// list is an ordinary positioned box and the trigger alone closes it.
const hasPopover = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

/**
 * A button that opens a short list of actions, on the platform's own popover:
 * top layer, light dismiss and Escape come free. Items close the menu after
 * they run so a modal they open is never stacked under it. The list is only
 * mounted while open, so closed it is out of the tab order and the tree.
 */
export function ActionMenu({
  label,
  trigger,
  triggerClassName,
  children,
}: {
  /** Accessible name of the trigger. */
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = () => {
    if (pop.current?.matches?.(":popover-open")) pop.current.hidePopover();
    setIsOpen(false);
  };

  useLayoutEffect(() => {
    const el = pop.current;
    if (!isOpen || !el || !button.current) return;
    if (typeof el.showPopover === "function" && !el.matches(":popover-open")) el.showPopover();
    // Positioned by hand until CSS anchor positioning ships in every engine.
    const r = button.current.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.top = `${r.bottom + 6}px`;
    el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    el.querySelector<HTMLElement>("a, button")?.focus();
  }, [isOpen]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
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
          popover={hasPopover ? "auto" : undefined}
          role="menu"
          aria-label={label}
          onToggle={(e) => {
            if ((e as unknown as ToggleEvent).newState === "closed") setIsOpen(false);
          }}
          className="fixed z-[60] m-0 min-w-56 rounded-card border border-line bg-surface-hi p-1.5 text-sm text-ink shadow-lift"
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

export const menuItem =
  "flex min-h-10 w-full items-center gap-2 rounded-chip px-3 text-left font-semibold text-ink-soft hover:bg-felt-deep hover:text-ink focus-visible:bg-felt-deep aria-disabled:opacity-50";

export function MenuDivider() {
  return <hr role="separator" className="my-1 border-line" />;
}
