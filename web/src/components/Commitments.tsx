import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
 * The beat a landed row is held for before it leaves the list. Answering yes
 * closes the commitment server-side, so the very next broadcast drops it from
 * `commitments` — about a tenth of a second later on a local connection, which
 * made the resolved line a flash nobody could read. The row is held for one
 * `let-go` beat instead: --dur-flip of stillness, then --dur-flip of lifting
 * away. Kept in step with the keyframe in tokens.css.
 */
const LET_GO_MS = 600;

/** The one authored moment on the way out. Reduced motion kills the animation
 *  globally; the row then simply disappears at the end of the same beat. */
const LEAVING = "animate-[let-go_var(--dur-flip)_var(--ease-settle)_var(--dur-flip)_both]";

/**
 * A quiet control one step below Yes/No: a pill with a real hit area and no
 * border. It is only ever used outside the answer group — a bare pill sitting
 * beside Yes and No still reads as a third answer, whatever its weight.
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
  const mine = useMemo(() => commitments.filter((c) => c.userId === meId), [commitments, meId]);
  const left = 500 - text.length;

  /**
   * Rows answered yes in this sitting, held for one beat so the answer is
   * legible on the way out, and the position they were holding so the beat is
   * not a jump to the bottom of the list.
   *
   * `closed` is the matching set of ids to suppress once the beat is over: a
   * broadcast that has not caught up yet would otherwise put the row straight
   * back. Both are per-mount, so a phase change or a remount starts clean and
   * nothing is ever resurrected from a previous sitting; `leaving` empties
   * itself on a timer, and `closed` gains at most one id per click.
   */
  const [leaving, setLeaving] = useState<{ c: Commitment; at: number }[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const held = useCallback((c: Commitment, at: number) => {
    setClosed((prev) => new Set(prev).add(c.id));
    setLeaving((prev) => (prev.some((l) => l.c.id === c.id) ? prev : [...prev, { c, at }]));
    timers.current.push(
      setTimeout(() => setLeaving((prev) => prev.filter((l) => l.c.id !== c.id)), LET_GO_MS),
    );
  }, []);

  // The list as drawn: what the server still carries, minus anything whose
  // beat has already finished, plus the held rows the server has dropped —
  // each put back at the index it was holding rather than appended.
  const rows = useMemo(() => {
    const still = new Set(leaving.map((l) => l.c.id));
    const out = mine.filter((c) => still.has(c.id) || !closed.has(c.id));
    for (const l of leaving) {
      if (!out.some((c) => c.id === l.c.id)) out.splice(Math.min(l.at, out.length), 0, l.c);
    }
    return out;
  }, [mine, leaving, closed]);
  const goneIds = new Set(leaving.map((l) => l.c.id));

  // A row that leaves — landed and let go, or removed — takes the focused
  // control with it. Whoever was standing there gets the add box rather than
  // <body>.
  const catchFocus = useCallback(() => addRef.current?.focus(), []);

  return (
    <div data-testid="carrying-over" className="flex flex-col gap-3">
      <div>
        <h3 className="text-[15px] font-bold text-ink">Carrying over</h3>
        {/* Only true once there was a last time. On a space's first standup the
            line asserted a history the empty state below immediately denied. */}
        {rows.length > 0 && (
          <p className="text-sm text-ink-faint">What you took on last time. Did that land?</p>
        )}
      </div>
      {rows.length === 0 ? (
        <p data-testid="carrying-over-empty" className="text-sm text-ink-faint">
          Nothing carrying over. Anything you take on here will be waiting for you next time.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((c, i) => (
            <CommitmentRow
              key={c.id}
              c={c}
              leaving={goneIds.has(c.id)}
              onAnswer={onAnswer}
              onRemove={onRemove}
              onNote={onNote}
              onLanded={() => held(c, i)}
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
 * never be dressed as one.
 *
 * The two answers resolve differently because the server treats them
 * differently. No keeps the commitment open, so the row settles in place and
 * offers a way back — the previous one-way No could only be undone by
 * reloading. Yes closes it for good: `answer` only matches rows with
 * `closed_at is null`, so nothing on the wire can reopen one. A "Change" there
 * would be a button that could only ever 404, so the yes path says what
 * happened, holds still long enough to be read, and leaves.
 */
function CommitmentRow({
  c,
  leaving,
  onAnswer,
  onRemove,
  onNote,
  onLanded,
  onLeave,
}: {
  c: Commitment;
  /** Answered yes and on its way out: resolved, and no longer answerable. */
  leaving: boolean;
  onAnswer: (id: string, done: boolean) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onNote?: (msg: string) => void;
  onLanded: () => void;
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
        // Yes has just closed this commitment. Ask to be held for a beat, so
        // the acknowledgement is not gone before the eye reaches it.
        if (done) onLanded();
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
      className={`flex flex-col gap-2 rounded-card border border-line px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 ${
        leaving ? LEAVING : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span id={textId} className="block font-semibold">
          {c.text}
        </span>
        {/* A sentence, not a badge. On a projected screen a red chip arrives
            before the words, which is the reprimand this feature exists to
            avoid — and the fact is about the work carrying, never a mark
            against whoever is keeping it. The numeral is the only data in the
            line, so it alone is mono and tabular.

            No token carries this state, and that is the decision. `stop` is
            reserved for destructive and stop actions, and a stuck commitment
            is neither. `accent` would be defensible — it is a live state of
            the work — but accent on every stuck row turns the list into a wall
            of pills, and the state is not a call to act on the row. `settled`
            is wrong in the other direction: settled is a decision at rest, and
            this is the opposite of at rest. So it is quiet ink, and the words
            carry the fact. */}
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
      {/* Two different kinds of thing, so two groups rather than one strip of
          pills. Yes/No answer the question; Remove withdraws it. Stacked, the
          groups take opposite edges of the control line, so Remove never sits
          shoulder to shoulder with the answers at 375px where the row has
          least room; from sm a hairline stands between them. Structure, not
          colour: stop is reserved for destructive confirms, and a red control
          on every row would put back the reprimand this list exists without. */}
      <span className="flex items-center justify-between gap-3 sm:ml-auto sm:shrink-0 sm:justify-end">
        <span
          data-testid="answer-group"
          className="order-2 flex flex-wrap items-center gap-2 sm:order-1"
        >
          {answer === null && !leaving ? (
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
                {answer === false ? "Not yet — it carries over." : "Landed."}
              </span>
              {/* Only the No path. A no leaves the commitment open, so taking
                  it back is a real action; a yes has already closed it. */}
              {answer === false && (
                <button
                  type="button"
                  className={buttonBare}
                  aria-describedby={textId}
                  onClick={() => setAnswer(null)}
                >
                  Change
                </button>
              )}
            </span>
          )}
        </span>
        {/* Nothing to withdraw once it has landed: the row is on its way out. */}
        {!leaving &&
          (confirming ? (
            <span className="order-1 flex items-center gap-1 sm:order-2 sm:border-l sm:border-line sm:pl-3">
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
            <span className="order-1 flex items-center sm:order-2 sm:border-l sm:border-line sm:pl-3">
              <button
                type="button"
                className={buttonBare}
                aria-describedby={textId}
                onClick={() => setConfirming(true)}
              >
                Remove
              </button>
            </span>
          ))}
      </span>
    </li>
  );
}
