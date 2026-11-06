import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Story } from "../lib/api";
import { trayFreeArea } from "../lib/fanMotion";
import {
  blockReason,
  blockerLinks,
  isLinked,
  linkChipText,
  provenanceText,
  storyName,
  type BlockerLink,
  type SplitFan,
} from "../lib/splitFan";

export type MenuCloseCause = "escape" | "outside-press";

const MENU_STEPS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

export const DEPENDENCY_NOTICE = "Planning dependency · Completion not checked";

export function CardMenu({
  heading,
  onClose,
  children,
  footer,
}: {
  heading: string;
  onClose: (cause: MenuCloseCause) => void;
  children: ReactNode;
  footer?: string;
}) {
  const headingId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const position = () => {
      const card = element.parentElement?.getBoundingClientRect();
      if (!card) return;
      const area = trayFreeArea();
      if (card.bottom < area.top || card.top > area.bottom) {
        close.current("escape");
        return;
      }
      const below = Math.max(0, area.bottom - card.bottom - 14);
      const above = Math.max(0, card.top - area.top - 14);
      const naturalHeight = Math.max(element.offsetHeight, element.scrollHeight + 2);
      const placeAbove = naturalHeight > below && above > below;
      const available = placeAbove ? above : below;
      const height = Math.min(naturalHeight, available);
      const left = Math.max(8, Math.min(card.left + 6, window.innerWidth - element.offsetWidth - 8));
      element.style.maxHeight = `${available}px`;
      element.style.overflowY = "auto";
      element.style.top = `${Math.max(area.top + 8, placeAbove ? card.top - height - 6 : card.bottom + 6) - card.top}px`;
      element.style.left = `${left - card.left}px`;
    };
    const onMove = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && element.contains(event.target)) return;
      position();
    };
    position();
    element.focus({ preventScroll: true });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(position) : null;
    resize?.observe(element);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, []);

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      const card = menu.current?.parentElement;
      if (card && event.target instanceof Node && !card.contains(event.target)) close.current("outside-press");
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  return (
    <div
      ref={menu}
      role="group"
      aria-labelledby={headingId}
      tabIndex={-1}
      className="fan-menu"
      onKeyDown={(event) => {
        const step = MENU_STEPS[event.key];
        if (step !== undefined) {
          const options = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
          if (options.length === 0) return;
          event.preventDefault();
          const focusedIndex = options.indexOf(document.activeElement as HTMLElement);
          const nextIndex = focusedIndex < 0 ? (step > 0 ? 0 : options.length - 1) : (focusedIndex + step + options.length) % options.length;
          options[nextIndex].focus({ preventScroll: true });
          return;
        }
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose("escape");
      }}
    >
      <p id={headingId} className="fan-menu-heading">
        {heading}
      </p>
      {children}
      {footer && <p className="fan-menu-footer">{footer}</p>}
    </div>
  );
}

export function BlockedByMenu({
  fan,
  story,
  error,
  onToggle,
  onClose,
}: {
  fan: SplitFan;
  story: Story;
  error: string;
  onToggle: (blockerId: string, shouldLink: boolean) => Promise<void> | void;
  onClose: (cause: MenuCloseCause) => void;
}) {
  const reasonPrefix = useId();
  const [pendingChoices, setPendingChoices] = useState<Record<string, boolean>>({});
  async function toggle(blockerId: string, shouldLink: boolean) {
    setPendingChoices((choices) => ({ ...choices, [blockerId]: shouldLink }));
    try {
      await onToggle(blockerId, shouldLink);
    } finally {
      setPendingChoices((choices) => {
        const remaining = { ...choices };
        delete remaining[blockerId];
        return remaining;
      });
    }
  }
  const siblings = fan.children.filter((sibling) => sibling.id !== story.id);
  const unavailable = blockerLinks(fan, story.id).filter(
    (link) => !siblings.some((sibling) => sibling.id === link.blockerId),
  );
  return (
    <CardMenu heading={`${storyName(story)} is blocked by`} onClose={onClose} footer={DEPENDENCY_NOTICE}>
      {siblings.length === 0 && unavailable.length === 0 && (
        <p className="fan-note">Add another story first.</p>
      )}
      {siblings.map((sibling) => {
        const isSavedLink = isLinked(fan, story.id, sibling.id);
        const isChecked = pendingChoices[sibling.id] ?? isSavedLink;
        const reason = isSavedLink ? "" : blockReason(fan, story.id, sibling.id);
        const reasonId = `${reasonPrefix}-${sibling.id}`;
        return (
          <label key={sibling.id} className={"fan-menu-choice" + (reason ? " is-refused" : "")}>
            <input
              type="checkbox"
              checked={isChecked}
              aria-disabled={reason ? true : undefined}
              aria-describedby={reason ? reasonId : undefined}
              onChange={(event) => {
                if (reason) return;
                void toggle(sibling.id, event.target.checked);
              }}
            />
            <span>
              {storyName(sibling)}
              {reason && <small id={reasonId}>{reason}</small>}
            </span>
          </label>
        );
      })}
      {unavailable.map((link) => (
        <label key={link.edgeId} className="fan-menu-choice">
          <input type="checkbox" checked={pendingChoices[link.blockerId] ?? true} onChange={() => void toggle(link.blockerId, false)} />
          <span>
            {link.title}
            <small>No longer in this split · needs review. Untick to drop the link.</small>
          </span>
        </label>
      ))}
      {error && (
        <p role="alert" className="fan-note text-stop">
          {error}
        </p>
      )}
    </CardMenu>
  );
}

export function DependencyChips({ links }: { links: BlockerLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="fan-chips">
      {links.map((link) => (
        <li key={link.edgeId} data-edge-id={link.edgeId} className={"fan-chip" + (link.isUnavailable ? " is-unavailable" : "")}>
          {linkChipText(link)}
        </li>
      ))}
    </ul>
  );
}

export function TicketEstimate({ story }: { story: Story }) {
  if (story.estimate == null) return <>Unestimated</>;
  const points = <span className="font-mono font-bold text-ink">{story.estimate}</span>;
  if (story.estimateNeedsReview) return <>Needs review · previous {points}</>;
  return (
    <>
      {points} · {provenanceText(story.estimateProvenance)}
    </>
  );
}
