import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buttonGo, buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";

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
 * An answered row settles into place rather than snapping: the one moment on
 * this surface worth animating is something being set down. `set-down` has no
 * overshoot, and the global reduced-motion rule kills it outright.
 */
const SETTLE = "animate-[set-down_var(--dur-lift)_var(--ease-settle)]";

/**
 * A quiet control one step below Yes/No: a pill with a real hit area, no
 * border, so it never reads as a third answer in the same row.
 */
const buttonBare =
  "touch-hit inline-flex items-center justify-center rounded-full px-3 py-2 text-[13px] font-semibold text-ink-faint transition hover:bg-felt-deep hover:text-ink disabled:opacity-50";

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
  onNote,
}: {
  commitments: Commitment[];
  meId: string;
  onAdd: (text: string) => Promise<boolean>;
  onAnswer: (id: string, done: boolean) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  /** Routed into the page's single polite region. Never a second live region:
   *  a third would queue serially behind the two that already exist. */
  onNote?: (msg: string) => void;
}) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  const countId = useId();
  const mine = commitments.filter((c) => c.userId === meId);
  const left = 500 - text.length;

  // A row that leaves — answered yes and swept by the next broadcast, or
  // removed — takes the focused control with it. Whoever was standing there
  // gets the add box rather than <body>.
  const catchFocus = useCallback(() => addRef.current?.focus(), []);

  return (
    <div data-testid="carrying-over" className="flex flex-col gap-3">
      <div>
        <h3 className="text-[15px] font-bold text-ink">Carrying over</h3>
        {/* Only true once there was a last time. On a space's first standup the
            line asserted a history the empty state below immediately denied. */}
        {mine.length > 0 && (
          <p className="text-sm text-ink-faint">What you took on last time. Did that land?</p>
        )}
      </div>
      {mine.length === 0 ? (
        <p data-testid="carrying-over-empty" className="text-sm text-ink-faint">
          Nothing carrying over. Anything you take on here will be waiting for you next time.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((c) => (
            <CommitmentRow
              key={c.id}
              c={c}
              onAnswer={onAnswer}
              onRemove={onRemove}
              onNote={onNote}
              onLeave={catchFocus}
            />
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t || adding) return;
          setAdding(true);
          void onAdd(t).then((ok) => {
            setAdding(false);
            if (!ok) return;
            setText("");
            onNote?.("Commitment added.");
          });
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className={labelText}>Add a commitment</span>
          <input
            ref={addRef}
            className={inputClass}
            value={text}
            maxLength={500}
            aria-describedby={left <= 50 ? countId : undefined}
            onChange={(e) => setText(e.target.value)}
            placeholder="What will you have done by the next standup?"
          />
        </label>
        {/* The section's one submit, and a different task from answering a row:
            it gets the primary weight, not the same quiet pill as everything. */}
        <button type="submit" className={buttonPrimary} disabled={!text.trim() || adding}>
          Add
        </button>
        {/* Typing that simply stops at the ceiling reads as a broken field, so
            say how much room is left — but only once it is close enough to
            matter, and with the numeral as data. */}
        {left <= 50 && (
          <span id={countId} className="w-full text-[13px] text-ink-faint">
            <span className="font-mono tabular-nums">{left}</span> characters left
          </span>
        )}
      </form>
    </div>
  );
}

/**
 * One row: the commitment as prose, the answer as an asymmetric pair. Yes is
 * `go`, because landing something is a confirm that closes a state; No stays
 * transparent, because declining to close something is not a failure and must
 * never be dressed as one. Either answer resolves the row in place, with a way
 * back — the previous one-way No could only be undone by reloading.
 */
function CommitmentRow({
  c,
  onAnswer,
  onRemove,
  onNote,
  onLeave,
}: {
  c: Commitment;
  onAnswer: (id: string, done: boolean) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onNote?: (msg: string) => void;
  onLeave: () => void;
}) {
  const [answer, setAnswer] = useState<Answer>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Two clicks in the same tick both read stale state, so the ref is the guard
  // and the state only dims the control.
  const busyRef = useRef(false);
  const li = useRef<HTMLLIElement>(null);
  const textId = useId();

  // The row can be swept away by a broadcast at any moment. If it goes while it
  // holds focus, hand focus on rather than let it fall to <body>.
  useEffect(
    () => () => {
      if (li.current?.contains(document.activeElement)) onLeave();
    },
    [onLeave],
  );

  const send = (run: () => Promise<boolean>, after: (ok: boolean) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void run().then((ok) => {
      busyRef.current = false;
      setBusy(false);
      after(ok);
    });
  };

  const answered = (done: boolean) =>
    send(
      () => onAnswer(c.id, done),
      (ok) => {
        if (!ok) return;
        setAnswer(done);
        // The control that was clicked has just gone. The row it belonged to is
        // the nearest thing that still exists and still reads as the answer.
        li.current?.focus();
        onNote?.(done ? "Marked as landed." : "Still open — it carries over to the next standup.");
      },
    );

  return (
    <li
      ref={li}
      tabIndex={-1}
      aria-labelledby={textId}
      /* Outlined paper on a surface panel, not a felt well: `bg-felt-deep` is
         the page ground and the hand tray, and a row inside a panel that wears
         it reads as a well without the inset that would justify one. Stacked
         below sm, where 216px of content cannot hold text and controls on one
         line without orphaning the controls onto their own row. */
      className="flex flex-col gap-2 rounded-card border border-line px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="min-w-0 flex-1">
        <span id={textId} className="block font-semibold">
          {c.text}
        </span>
        {/* A sentence, not a badge. On a projected screen a red chip arrives
            before the words, which is the reprimand this feature exists to
            avoid — and the fact is about the work carrying, never a mark
            against whoever is keeping it. The numeral is the only data in the
            line, so it alone is mono and tabular. */}
        {c.stuck && (
          <span
            data-testid="stuck-badge"
            className="mt-0.5 block text-[13px] leading-snug text-ink-soft"
          >
            Carried over <span className="font-mono tabular-nums">{c.carried}</span> times — this
            one looks stuck.
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-2 sm:ml-auto sm:shrink-0">
        {answer === null ? (
          <>
            {/* Short labels with the commitment attached by description: the
                old aria-label read up to 500 characters of the person's own
                text before the operative word, three times per row. */}
            <button
              type="button"
              className={buttonGo}
              disabled={busy}
              aria-describedby={textId}
              onClick={() => answered(true)}
            >
              Yes
            </button>
            <button
              type="button"
              className={buttonQuiet}
              disabled={busy}
              aria-describedby={textId}
              onClick={() => answered(false)}
            >
              No
            </button>
          </>
        ) : (
          <span className={`flex items-center gap-1 ${SETTLE}`}>
            <span className="text-sm font-semibold text-ink-soft">
              {answer ? "Landed." : "Not yet — it carries over."}
            </span>
            <button
              type="button"
              className={buttonBare}
              aria-describedby={textId}
              onClick={() => setAnswer(null)}
            >
              Change
            </button>
          </span>
        )}
        {confirming ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className={buttonBare}
              disabled={busy}
              aria-describedby={textId}
              onClick={() =>
                send(
                  () => onRemove(c.id),
                  (ok) => {
                    if (!ok) {
                      setConfirming(false);
                      return;
                    }
                    onNote?.("Commitment removed.");
                  },
                )
              }
            >
              Remove it
            </button>
            <button type="button" className={buttonBare} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </span>
        ) : (
          /* Destructive, with nothing on the server to undo it, so the first
             click only asks. */
          <button
            type="button"
            className={buttonBare}
            aria-describedby={textId}
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </span>
    </li>
  );
}
