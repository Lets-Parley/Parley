import { useState } from "react";
import { buttonQuiet, inputClass, labelClass } from "./Modal";

/** One open commitment, exactly as the session state sends it. */
export type Commitment = {
  id: string;
  userId: string;
  text: string;
  carried: number;
  /** Computed by the server so every screen agrees on what stalled means. */
  stuck: boolean;
};

/**
 * What you have said about this commitment in this sitting. Three states, so
 * the null is written out: `boolean | undefined` collapses "not answered yet"
 * and "answered no" under one truthiness check, and a commitment nobody has
 * touched then renders as a No.
 */
type Answer = boolean | null;

/**
 * The carry-over list: what you said you would do, still open, asked the way
 * round that makes the answer mean something — "did that land?", where No is
 * the one that carries. Only your own rows are answerable; the wire carries
 * the whole room's, because one payload is broadcast to every socket.
 */
export function Commitments({
  commitments,
  meId,
  onAdd,
  onAnswer,
  onRemove,
}: {
  commitments: Commitment[];
  meId: string;
  onAdd: (text: string) => Promise<boolean>;
  onAnswer: (id: string, done: boolean) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const mine = commitments.filter((c) => c.userId === meId);

  return (
    <div data-testid="carrying-over" className="flex flex-col gap-3">
      <div>
        <h3 className={`${labelClass} mb-1 mt-0`}>Carrying over</h3>
        <p className="text-sm text-ink-faint">What you took on last time. Did that land?</p>
      </div>
      {mine.length === 0 ? (
        <p data-testid="carrying-over-empty" className="text-sm text-ink-faint">
          Nothing carrying over.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((c) => {
            const answer = answers[c.id] ?? null;
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-chip bg-felt-deep px-3 py-2"
              >
                <span className="min-w-0 flex-1 font-semibold">{c.text}</span>
                {/* Spelled out, because a badge alone puts the whole fact in a
                    colour. Worded about the work: it is the commitment that
                    has carried, not a mark against whoever is keeping it.

                    Accent, not stop. Stop is for destructive and stop actions;
                    a commitment that keeps carrying is a live state of the
                    work, which is what accent means. It is not `settled`
                    either — settled is a decision at rest, and this is the
                    opposite of at rest. */}
                {c.stuck && (
                  <span
                    data-testid="stuck-badge"
                    className="rounded-full border border-accent px-2.5 py-0.5 text-xs font-bold text-accent"
                  >
                    {`This has carried over ${c.carried} times — it looks stuck`}
                  </span>
                )}
                {/* The pair stays answerable after you answer. Swapping it
                    for a dead sentence made a misclick during the ninety
                    seconds before your turn unrecoverable in-session. */}
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className={buttonQuiet}
                    aria-pressed={answer === true}
                    aria-label={`Yes, "${c.text}" landed`}
                    onClick={() => void onAnswer(c.id, true).then((ok) => ok && setAnswers((a) => ({ ...a, [c.id]: true })))}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    aria-pressed={answer === false}
                    aria-label={`No, "${c.text}" has not landed yet`}
                    onClick={() => void onAnswer(c.id, false).then((ok) => ok && setAnswers((a) => ({ ...a, [c.id]: false })))}
                  >
                    No
                  </button>
                  {answer === false && (
                    <span className="text-sm font-semibold text-ink-soft">Not yet — it carries over.</span>
                  )}
                </span>
                <button
                  type="button"
                  className={`${buttonQuiet} hover:!bg-stop hover:!text-accent-ink`}
                  aria-label={`Remove "${c.text}"`}
                  onClick={() => void onRemove(c.id)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void onAdd(text.trim()).then((ok) => ok && setText(""));
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className={`${labelClass} mb-0 mt-0`}>Add a commitment</span>
          <input
            className={inputClass}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder="What will you have done by the next standup?"
          />
        </label>
        <button type="submit" className={buttonQuiet} disabled={!text.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
