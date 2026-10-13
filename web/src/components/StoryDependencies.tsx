import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Story } from "../lib/api";
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
  const [isEndAligned, setEndAligned] = useState(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    if (element.getBoundingClientRect().right > window.innerWidth - 8) setEndAligned(true);
    element.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
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
      className={"fan-menu" + (isEndAligned ? " is-end-aligned" : "")}
      onKeyDown={(event) => {
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
