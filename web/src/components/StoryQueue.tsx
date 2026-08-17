import { useState, type FormEvent } from "react";
import { api, type Story } from "../lib/api";
import { buttonPrimary, buttonQuiet, inputClass, Modal } from "./Modal";
import { faceOf } from "./Table";

export function StoryQueue({
  sessionId,
  stories,
  currentStoryId,
  isFacilitator,
  onError,
}: {
  sessionId: string;
  stories: Story[];
  currentStoryId: string | null;
  isFacilitator: boolean;
  onError: (msg: string) => void;
}) {
  const [composing, setComposing] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  function move(story: Story, dir: -1 | 1) {
    const idx = stories.findIndex((s) => s.id === story.id);
    const swap = stories[idx + dir];
    if (!swap) return;
    const neighbour = stories[idx + dir * 2];
    // Insert between the swap target and its neighbour — positions never renumber.
    const pos = neighbour ? (swap.position + neighbour.position) / 2 : swap.position + dir;
    run(() => api("PATCH", `/api/stories/${story.id}`, { position: pos }));
  }

  return (
    <aside className="flex w-full flex-col gap-2 rounded-panel border border-line bg-surface p-3.5 shadow-rest lg:w-[300px] lg:shrink-0">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Story queue · {stories.length}
        </h2>
        {isFacilitator && (
          <button
            onClick={() => setComposing(true)}
            className="text-xs font-bold text-accent hover:underline"
          >
            + Add
          </button>
        )}
      </div>

      {stories.length === 0 && (
        <p className="px-2 py-3.5 text-center text-[13px] text-ink-faint">The queue is empty.</p>
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
              <span className="flex shrink-0 flex-col gap-0.5">
                <button
                  aria-label={`Move ${s.title} up`}
                  disabled={i === 0}
                  className="h-[14px] w-[18px] text-[9px] leading-none text-ink-faint hover:text-ink disabled:opacity-30"
                  onClick={() => move(s, -1)}
                >
                  ▲
                </button>
                <button
                  aria-label={`Move ${s.title} down`}
                  disabled={i === stories.length - 1}
                  className="h-[14px] w-[18px] text-[9px] leading-none text-ink-faint hover:text-ink disabled:opacity-30"
                  onClick={() => move(s, 1)}
                >
                  ▼
                </button>
              </span>
            )}

            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[10px] text-ink-faint">
                #{i + 1}
                {s.id === currentStoryId && <span className="text-accent"> · current</span>}
              </span>
              <span className="block truncate text-[13px] font-semibold" title={s.title}>
                {s.title}
              </span>
            </span>

            {s.estimate ? (
              <span
                title="Agreed estimate"
                className="flex h-[33px] w-6 shrink-0 items-center justify-center rounded-[5px] border border-brass bg-surface font-display text-[0.8rem] shadow-rest"
              >
                {faceOf(s.estimate)}
              </span>
            ) : (
              isFacilitator &&
              s.id !== currentStoryId && (
                <button
                  className="shrink-0 rounded-full border border-line px-2.5 py-1 text-xs font-bold text-ink-soft hover:bg-felt-deep"
                  onClick={() => run(() => api("POST", `/api/sessions/${sessionId}/select`, { storyId: s.id }))}
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
          onSubmit={async (title, notes) => {
            await run(() => api("POST", `/api/sessions/${sessionId}/stories`, { title, notes }));
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
  onSubmit: (title: string, notes: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) onSubmit(title.trim(), notes.trim());
  }

  return (
    <Modal title="Add a story" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3 pt-3">
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
          <button type="submit" className={buttonPrimary} disabled={!title.trim()}>
            Add to queue
          </button>
        </div>
      </form>
    </Modal>
  );
}
