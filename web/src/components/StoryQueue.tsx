import { useId, useState, type FormEvent } from "react";
import { action, errorText, type Story } from "../lib/api";
import { TOUCH_HIT } from "../lib/breakpoints";
import { draftStoriesText, estimateCounts, estimateCountsText, hasParkedDrafts, provenanceText } from "../lib/splitFan";
import { ErrorRow, buttonPrimary, buttonQuiet, inputClass, Modal, type Fail } from "./Modal";
import { TicketEstimate } from "./StoryDependencies";
import { faceOf } from "./Table";

// A story may carry only a ref or only a title, so name it by whichever it has.
function nameOf(s: Story) {
  return s.title || s.ref || "ad hoc round";
}

export function StoryQueue({
  sessionId,
  stories,
  allStories = stories,
  currentStoryId,
  shownSplitId = null,
  onShowSplit,
  onContinueSplit,
  isFacilitator,
  onQuickRound,
  onDeal,
  fail,
  onFail,
  onDismiss,
}: {
  sessionId: string;
  stories: Story[];
  allStories?: Story[];
  currentStoryId: string | null;
  shownSplitId?: string | null;
  onShowSplit?: (parent: Story) => void;
  onContinueSplit?: (parent: Story) => void;
  isFacilitator: boolean;
  onQuickRound: () => void;
  onDeal?: (story: Story) => void;
  /** Owned by PokerRoom, rendered here: the aside's failures stay in the aside. */
  fail: Fail | null;
  onFail: (msg: string, retry?: () => Promise<unknown>) => void;
  onDismiss: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const headingId = useId();
  const groups = allStories.filter(s =>
    !s.parentId && !s.removedAt && !hasParkedDrafts(s) && allStories.some(child => child.parentId === s.id && !child.removedAt),
  );
  const removedCountOf = (story: Story) =>
    groups.some(parent => parent.id === story.id)
      ? 0
      : allStories.filter(child => child.parentId === story.id && child.removedAt).length;
  const parkedDraftCountOf = (story: Story) =>
    hasParkedDrafts(story) && story.id !== currentStoryId
      ? allStories.filter(child => child.parentId === story.id && !child.removedAt && child.planningRole === "proposed").length
      : 0;
  const standalone = stories.filter(s =>
    (!s.parentId || !groups.some(p => p.id === s.parentId)) && !groups.some(p => p.id === s.id),
  );

  async function run(fn: () => Promise<unknown>, retryable = true) {
    try {
      await fn();
    } catch (e) {
      onFail(errorText(e), retryable ? fn : undefined);
    }
  }

  function move(story: Story, dir: -1 | 1) {
    const idx = stories.findIndex((s) => s.id === story.id);
    const swap = stories[idx + dir];
    if (!swap) return;
    const neighbor = stories[idx + dir * 2];
    // Insert between the swap target and its neighbor — positions never renumber.
    const pos = neighbor ? (swap.position + neighbor.position) / 2 : swap.position + dir;
    run(() => action(sessionId, "story", { storyId: story.id, position: pos, expectedRevision: story.contentRevision }), false);
  }

  return (
    <aside aria-labelledby={headingId} className="flex w-full flex-col gap-2 rounded-panel border border-line bg-surface p-3.5 shadow-rest lg:w-[300px] lg:shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pb-1">
        <h2 id={headingId} tabIndex={-1} data-queue-heading="" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Story queue · {stories.length}
        </h2>
        {isFacilitator && (
          <span className="flex gap-2.5">
            <button
              onClick={onQuickRound}
              title="Ad-hoc round, no ticket needed"
              className={`${TOUCH_HIT} inline-flex items-center px-2 text-xs font-bold text-accent hover:underline`}
            >
              + Ad hoc
            </button>
            <button
              onClick={() => setComposing(true)}
              className={`${TOUCH_HIT} inline-flex items-center px-2 text-xs font-bold text-accent hover:underline`}
            >
              + Ticket
            </button>
          </span>
        )}
      </div>

      {fail && (
        <ErrorRow
          fail={fail}
          onDismiss={onDismiss}
          onRetry={fail.retry && (() => run(fail.retry!))}
        />
      )}

      {stories.length === 0 && (
        // A member has no add controls above, so "empty" alone is a dead end
        // for them — name who fills it instead.
        <p className="px-2 py-3.5 text-center text-[13px] text-ink-faint text-pretty">
          {isFacilitator
            ? "Nothing queued. Add a ticket, or deal an ad-hoc round."
            : "Nothing queued yet — the facilitator deals the next story."}
        </p>
      )}

      <ul className="flex flex-col">
        {groups.map(parent => {
          const children = allStories.filter(s => s.parentId === parent.id && !s.removedAt);
          const isAdopted = parent.planningRole === "context";
          const counted = isAdopted ? children.filter(child => child.planningRole !== "proposed") : children;
          const drafted = children.length - counted.length;
          const current = children.find(s => s.id === currentStoryId);
          return (
          <li
            key={parent.id}
            className={"rounded-chip px-2 py-2.5 text-[13px] " + (parent.id === shownSplitId ? "bg-felt-deep" : "")}
          >
            <button
              type="button"
              className="flex min-h-[44px] w-full flex-col justify-center rounded-chip text-left"
              aria-label={`Show the split of ${nameOf(parent)}`}
              aria-current={parent.id === shownSplitId ? "true" : undefined}
              onClick={() => onShowSplit?.(parent)}
            >
              <span className="block font-mono text-[10px] text-ink-faint">
                {parent.ref || "split"} · {isAdopted ? `${counted.length} stories` : "splitting"}
              </span>
              <span className="block truncate font-semibold" title={nameOf(parent)}>{nameOf(parent)}</span>
            </button>
            <p className="break-words text-xs text-ink-soft">
              {isAdopted
                ? `${estimateCountsText(estimateCounts(counted))}${drafted > 0 ? ` · ${drafted} drafted` : ""}`
                : `${children.length} drafted · not counted until the split`}
            </p>
            {isAdopted && parent.estimate != null && <p className="break-words text-xs text-ink-soft">Ticket: <TicketEstimate story={parent} /></p>}
            {(current || parent.id === currentStoryId) && <p className="break-words text-xs text-accent">On the table: {nameOf(current ?? parent)}</p>}
            {isFacilitator && !isAdopted && parent.id !== currentStoryId && <button className={buttonQuiet + " mt-1 min-h-[44px]"} aria-label={`Deal ${nameOf(parent)}`} onClick={() => onDeal?.(parent)}>Deal</button>}
          </li>
          );
        })}
        {standalone.map((s) => {
          const i = stories.findIndex(story => story.id === s.id);
          const parkedDraftCount = parkedDraftCountOf(s);
          const removedCount = parkedDraftCount > 0 ? 0 : removedCountOf(s);
          return (
          <li
            key={s.id}
            data-queue-story={s.id}
            className={
              "flex items-center gap-2 rounded-chip px-2 py-2.5 " +
              (s.id === currentStoryId ? "bg-felt-deep" : "")
            }
          >
            {isFacilitator && (
              <span className="flex shrink-0 flex-row">
                <button
                  aria-label={`Move ${nameOf(s)} up`}
                  disabled={i === 0}
                  className={`${TOUCH_HIT} flex items-center justify-center text-[9px] leading-none text-ink-faint hover:text-ink disabled:opacity-30`}
                  onClick={() => move(s, -1)}
                >
                  ▲
                </button>
                <button
                  aria-label={`Move ${nameOf(s)} down`}
                  disabled={i === stories.length - 1}
                  className={`${TOUCH_HIT} flex items-center justify-center text-[9px] leading-none text-ink-faint hover:text-ink disabled:opacity-30`}
                  onClick={() => move(s, 1)}
                >
                  ▼
                </button>
              </span>
            )}

            <span className="min-w-0 flex-1">
              <span
                className={"block font-mono text-[10px] text-ink-faint" + (s.ref ? "" : " italic")}
              >
                {s.ref || "ad hoc"}
                {s.id === currentStoryId && <span className="text-accent"> · current</span>}
              </span>
              {s.title && (
                <span className="block truncate text-[13px] font-semibold" title={s.title}>
                  {s.title}
                </span>
              )}
              {s.estimateNeedsReview && (<span className="block text-xs text-ink-soft">Needs review · previous {s.estimate}</span>
              )}
              {parkedDraftCount > 0 && (isFacilitator && onContinueSplit ? (
                <button
                  type="button"
                  data-queue-drafts
                  aria-label={`Continue splitting ${nameOf(s)}, ${draftStoriesText(parkedDraftCount)}`}
                  className="inline-flex min-h-[44px] items-center rounded-chip text-left text-xs font-semibold text-accent hover:underline"
                  onClick={() => onContinueSplit(s)}
                >
                  {draftStoriesText(parkedDraftCount)}
                </button>
              ) : (
                <span className="block text-xs text-ink-soft">{draftStoriesText(parkedDraftCount)}</span>
              ))}
              {removedCount > 0 && isFacilitator && onShowSplit && (
                <button
                  type="button"
                  aria-label={`Show the ${removedCount === 1 ? "removed story" : `${removedCount} removed stories`} of ${nameOf(s)}`}
                  className="inline-flex min-h-[44px] items-center rounded-chip text-left text-xs font-semibold text-ink-soft hover:text-accent hover:underline"
                  onClick={() => onShowSplit(s)}
                >
                  {removedCount === 1 ? "1 removed story" : `${removedCount} removed stories`}
                </button>
              )}
            </span>

            {s.estimate && (
              <span
                role="img"
                aria-label={`${s.estimateNeedsReview ? "Needs review" : s.estimateProvenance ? provenanceText(s.estimateProvenance) : "Agreed"} estimate ${faceOf(s.estimate)}`}
                className="flex h-[33px] w-6 shrink-0 items-center justify-center rounded-[5px] border border-settled bg-surface font-mono text-[0.8rem] text-settled shadow-rest"
              >
                {faceOf(s.estimate)}
              </span>
            )}
            {(!s.estimate || s.estimateNeedsReview || (s.splitRevision ?? 0) > 0) &&
              isFacilitator &&
              s.id !== currentStoryId && (
                <button
                  data-queue-deal
                  aria-label={`Deal ${nameOf(s)}`}
                  className={`${TOUCH_HIT} shrink-0 inline-flex items-center rounded-full border border-line px-3 text-xs font-bold text-ink-soft hover:bg-felt-deep`}
                  onClick={() => onDeal ? onDeal(s) : run(() => action(sessionId, "select", { storyId: s.id }))}
                >
                  Deal
                </button>
              )}
          </li>
          );
        })}
      </ul>

      {composing && (
        <StoryComposer
          onClose={() => setComposing(false)}
          onSubmit={async (title, notes, ref) => {
            // Story creation is not idempotent: retrying after a lost response
            // can create a duplicate ticket in the queue. Deal/move stay
            // retryable; this call must not offer Try again.
            await run(() => action(sessionId, "stories", { title, notes, ref }), false);
            setComposing(false);
          }}
        />
      )}
    </aside>
  );
}

function StoryComposer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (title: string, notes: string, ref: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [ref, setRef] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() || ref.trim()) onSubmit(title.trim(), notes.trim(), ref.trim());
  }

  return (
    <Modal title="Add a ticket" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3 pt-3">
        <input
          className={inputClass}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="Ticket, e.g. PAR-142 — leave blank for an ad-hoc round"
          maxLength={40}
        />
        <input
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Rate limiting for the invite endpoint"
          maxLength={200}
          autoFocus data-autofocus
        />
        <input
          className={inputClass}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes or a link — Parley keeps it attached"
          maxLength={500}
        />
        <div className="mt-2 flex justify-end gap-2.5">
          <button type="button" className={buttonQuiet} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonPrimary} disabled={!title.trim() && !ref.trim()}>
            Add to queue
          </button>
        </div>
      </form>
    </Modal>
  );
}
