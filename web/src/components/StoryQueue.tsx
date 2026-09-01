import { useId, useState, type FormEvent } from "react";
import { action, errorText, type Story } from "../lib/api";
import { TOUCH_HIT } from "../lib/breakpoints";
import { ErrorRow, buttonPrimary, buttonQuiet, inputClass, Modal, type Fail } from "./Modal";
import { faceOf } from "./Table";

// A story may carry only a ref or only a title, so name it by whichever it has.
function nameOf(s: Story) {
  return s.title || s.ref || "ad hoc round";
}

export function StoryQueue({
  sessionId,
  stories,
  currentStoryId,
  isFacilitator,
  onQuickRound,
  fail,
  onFail,
  onDismiss,
}: {
  sessionId: string;
  stories: Story[];
  currentStoryId: string | null;
  isFacilitator: boolean;
  onQuickRound: () => void;
  /** Owned by PokerRoom, rendered here: the aside's failures stay in the aside. */
  fail: Fail | null;
  onFail: (msg: string, retry?: () => Promise<unknown>) => void;
  onDismiss: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const headingId = useId();

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
    const neighbour = stories[idx + dir * 2];
    // Insert between the swap target and its neighbour — positions never renumber.
    const pos = neighbour ? (swap.position + neighbour.position) / 2 : swap.position + dir;
    run(() => action(sessionId, "story", { storyId: story.id, position: pos }));
  }

  return (
    <aside aria-labelledby={headingId} className="flex w-full flex-col gap-2 rounded-panel border border-line bg-surface p-3.5 shadow-rest lg:w-[300px] lg:shrink-0">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <h2 id={headingId} className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
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
        {stories.map((s, i) => (
          <li
            key={s.id}
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
            </span>

            {s.estimate ? (
              <span
                role="img"
                aria-label={`Agreed estimate ${faceOf(s.estimate)}`}
                className="flex h-[33px] w-6 shrink-0 items-center justify-center rounded-[5px] border border-settled bg-surface font-mono text-[0.8rem] text-settled shadow-rest"
              >
                {faceOf(s.estimate)}
              </span>
            ) : (
              isFacilitator &&
              s.id !== currentStoryId && (
                <button
                  aria-label={`Deal ${nameOf(s)}`}
                  className={`${TOUCH_HIT} shrink-0 inline-flex items-center rounded-full border border-line px-3 text-xs font-bold text-ink-soft hover:bg-felt-deep`}
                  onClick={() => run(() => action(sessionId, "select", { storyId: s.id }))}
                >
                  Deal
                </button>
              )
            )}
          </li>
        ))}
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
          autoFocus
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
