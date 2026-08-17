import { useState, type FormEvent } from "react";
import { api, type Story } from "../lib/api";
import { buttonQuiet, inputClass } from "./Modal";

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
  const [title, setTitle] = useState("");

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await run(() => api("POST", `/api/sessions/${sessionId}/stories`, { title }));
    setTitle("");
  }

  function move(story: Story, dir: -1 | 1) {
    const idx = stories.findIndex((s) => s.id === story.id);
    const swap = stories[idx + dir];
    if (!swap) return;
    const neighbour = stories[idx + dir * 2];
    // Insert between the swap target and its neighbour — positions never renumber.
    const pos = neighbour
      ? (swap.position + neighbour.position) / 2
      : swap.position + dir;
    run(() => api("PATCH", `/api/stories/${story.id}`, { position: pos }));
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-bold">Stories</h3>
      <ul className="flex flex-col gap-2">
        {stories.map((s) => (
          <li
            key={s.id}
            className={
              "flex items-center gap-2 rounded-chip border p-2 " +
              (s.id === currentStoryId
                ? "border-accent bg-accent-soft"
                : "border-line bg-surface")
            }
          >
            <span className="flex-1 truncate" title={s.title}>
              {s.title}
            </span>
            {s.estimate && (
              <span className="rounded-chip bg-brass px-2 py-0.5 font-display text-sm font-semibold text-accent-ink">
                {s.estimate}
              </span>
            )}
            {isFacilitator && (
              <span className="flex gap-1">
                <button aria-label="move up" className="px-1 text-ink-soft hover:text-ink" onClick={() => move(s, -1)}>↑</button>
                <button aria-label="move down" className="px-1 text-ink-soft hover:text-ink" onClick={() => move(s, 1)}>↓</button>
                {s.id !== currentStoryId && (
                  <button
                    className="rounded-chip border border-line px-2 py-0.5 text-sm font-bold text-ink-soft hover:bg-felt-deep"
                    onClick={() => run(() => api("POST", `/api/sessions/${sessionId}/select`, { storyId: s.id }))}
                  >
                    Vote
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
        {stories.length === 0 && (
          <li className="rounded-chip border border-dashed border-line p-4 text-center text-sm text-ink-faint">
            Deal the first story
          </li>
        )}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a story…"
          maxLength={200}
        />
        <button type="submit" className={buttonQuiet} disabled={!title.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}
