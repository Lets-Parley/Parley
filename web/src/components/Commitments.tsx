import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buttonGo, buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";

/** One open commitment, exactly as the session state sends it. */
export type Commitment = {
  id: string;
  userId: string;
  text: string;
  carried: number;
  /** Computed by the server so every screen agrees on what stalled means. */
  stuck: boolean;
  /**
   * True when this commitment was opened in the session on screen. It comes off
   * the row (`opened_session_id`, which is null once that room has been
   * deleted), not from `carried === 0`: a commitment opened weeks ago and
   * never answered also has a carry count of zero, so the
   * count cannot tell "just typed" from "carried in unanswered". Reading it off
   * the wire also means it survives a reconnect, which a client-side "things I
   * added since the page loaded" set would not.
   */
  openedHere: boolean;
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
  "touch-hit inline-flex items-center justify-center whitespace-nowrap rounded-full px-3 py-2 text-[13px] font-semibold text-ink-faint transition hover:bg-felt-deep hover:text-ink disabled:opacity-50";

/**
 * Both lists are peers under "Before your turn" (h2), so they take the same
 * level and the same weight. One constant rather than two hand-rolled strings,
 * so the two headings cannot drift apart.
 */
const sectionHeading = "text-[15px] font-bold text-ink";

/**
 * Your open commitments, in two lists, because they are owed two different
 * things. What carried in from an earlier sitting is asked the way round that
 * makes the answer mean something — "did that land?", where No is the one that
 * carries. What you take on in this sitting is only listed back: it has carried
 * from nowhere, so there is nothing yet to answer, and a No there would move a
 * carry count towards a stuck state it never earned.
 *
 * Only your own rows appear; the wire carries the whole room's, because one
 * payload is broadcast to every socket.
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
  // Two different questions, so two different lists. Which list a row belongs
  // to is the server's answer, never a guess from the carry count.
  const carriedOver = useMemo(() => mine.filter((c) => !c.openedHere), [mine]);
  const takenOnNow = useMemo(() => mine.filter((c) => c.openedHere), [mine]);
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
    const out = carriedOver.filter((c) => still.has(c.id) || !closed.has(c.id));
    for (const l of leaving) {
      if (!out.some((c) => c.id === l.c.id)) out.splice(Math.min(l.at, out.length), 0, l.c);
    }
    return out;
  }, [carriedOver, leaving, closed]);
  const goneIds = new Set(leaving.map((l) => l.c.id));

  // A row that leaves — landed and let go, or removed — takes the focused
  // control with it. Whoever was standing there gets the add box rather than
  // <body>.
  const catchFocus = useCallback(() => addRef.current?.focus(), []);

  return (
    <div data-testid="carrying-over" className="flex flex-col gap-3">
      <div>
        <h3 className={sectionHeading}>Carrying over</h3>
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
        <ul data-testid="carrying-over-list" className="flex flex-col gap-2">
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
      {/* Only when there is something in it: an empty "Taking on now" would be
          a heading announcing nothing, directly above the field that is the
          way to fill it. */}
      {takenOnNow.length > 0 && (
        <div data-testid="taking-on-now" className="flex flex-col gap-3">
          <div>
            <h3 className={sectionHeading}>Taking on now</h3>
            <p className="text-sm text-ink-faint">
              What you are picking up this standup. Nothing to answer yet — it will be here next
              time.
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            {takenOnNow.map((c) => (
              <CommitmentRow
                key={c.id}
                c={c}
                /* No question was asked, so there is no answer to offer. It is
                   still yours to withdraw, with the same two-step confirm, the
                   same focus handling and the same behaviour at 375px as a
                   carried-over row. */
                answerable={false}
                leaving={false}
                onAnswer={onAnswer}
                onRemove={onRemove}
                onNote={onNote}
                onLanded={NOTHING_TO_LAND}
                onLeave={catchFocus}
              />
            ))}
          </ul>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t || adding) return;
          setAdding(true);
          void onAdd(t)
            .then((ok) => {
              if (!ok) return;
              setText("");
              onNote?.("Commitment added.");
            })
            // Without this a rejection would leave `adding` set and the Add
            // button permanently disabled.
            .catch(() => {})
            .finally(() => setAdding(false));
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
/** A row with no answer group can never land, so there is no beat to hold. */
const NOTHING_TO_LAND = () => {};

function CommitmentRow({
  c,
  answerable = true,
  leaving,
  onAnswer,
  onRemove,
  onNote,
  onLanded,
  onLeave,
}: {
  c: Commitment;
  /**
   * False for a commitment opened in this sitting: "did that land?" is not a
   * question anyone can answer about a sentence typed ninety seconds ago, so
   * the row carries no answer group at all.
   */
  answerable?: boolean;
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
  // A remove that succeeded leaves the row on screen until the broadcast drops
  // it. Nothing about the confirm changes in that gap, so the guard stays
  // latched rather than arming a second Remove it that could only 404.
  const latched = useRef(false);
  const li = useRef<HTMLLIElement>(null);
  // Focus is moved onto Keep it when the confirm opens, so the second step is a
  // step for a keyboard too, and the control it lands on is the harmless one.
  const keep = useRef<HTMLButtonElement>(null);
  // Backing out of the confirm has to land somewhere. The Remove button is a
  // fresh node every time — the keys below force that on purpose — so what is
  // remembered is the intention to go back, not a reference to the old node.
  const ask = useRef<HTMLButtonElement>(null);
  const backOut = useRef(false);
  const textId = useId();
  // The hairline is the seam between two groups of controls, not an edge of
  // its own — `line`, not `line-strong`, because no control here is bounded by
  // it. With no answer group beside it there is nothing to divide, so a row
  // that cannot be answered draws none.
  const divider = answerable ? "sm:border-l sm:border-line sm:pl-3" : "";

  // The row can be swept away by a broadcast at any moment. If it goes while it
  // holds focus, hand focus on rather than let it fall to <body>.
  //
  // Layout, not passive: React detaches the ref and takes the node out of the
  // document before passive cleanup runs, so by then `li.current` is null and
  // the active element is already <body> — the guard could never be true.
  // Layout cleanup runs while the node is still attached and still holds focus.
  useLayoutEffect(
    () => () => {
      if (li.current?.contains(document.activeElement)) onLeave();
    },
    [onLeave],
  );

  // The catch is not decoration. The call site resolves rather than rejects
  // today, but a rejection with no catch here would leave busyRef set and the
  // control dead for the life of the row, with nothing on screen saying so.
  useEffect(() => {
    if (confirming) {
      keep.current?.focus();
    } else if (backOut.current) {
      backOut.current = false;
      ask.current?.focus();
    }
  }, [confirming]);

  // Keep it, or Escape. Either way the row goes back to its first step and the
  // control that opened the confirm takes focus again.
  const cancel = useCallback(() => {
    backOut.current = true;
    setConfirming(false);
  }, []);

  const send = (run: () => Promise<boolean>, after: (ok: boolean) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void run()
      .then((ok) => after(ok))
      .catch(() => {})
      .finally(() => {
        busyRef.current = latched.current;
        setBusy(false);
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
          least room, and where there is not even room for that the line wraps
          and the withdraw action drops below the answers rather than ahead of
          them; from sm a hairline stands between them. Structure, not
          colour: stop is reserved for destructive confirms, and a red control
          on every row would put back the reprimand this list exists without. */}
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:ml-auto sm:shrink-0 sm:flex-nowrap sm:justify-end">
        {answerable && (
          <span data-testid="answer-group" className="flex flex-wrap items-center gap-2">
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
        )}
        {/* Nothing to withdraw once it has landed: the row is on its way out. */}
        {/* The keys are load-bearing. Without them the two states render the
            same element types in the same position, React reconciles the button
            in place, and the node holding keyboard focus simply changes its
            accessible name from "Remove" to "Remove it" — so a second Enter
            deletes the commitment with no second step at all. A distinct key
            forces the remount, and focus is then moved deliberately below. */}
        {!leaving &&
          (confirming ? (
            <span
              key="confirm"
              className={`flex items-center gap-1 ${divider}`}
              /* Scoped to the row on purpose: a document listener here would
                 also swallow Escape from the page's native <dialog>, which
                 closes itself. The stop keeps this Escape from travelling on
                 to any surface above the row. */
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                cancel();
              }}
            >
              {/* Keep it leads: the safe choice is the one the keyboard reaches
                  first, and the one focus lands on. */}
              <button
                ref={keep}
                type="button"
                className={buttonBare}
                onClick={cancel}
              >
                Keep it
              </button>
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
                      latched.current = true;
                      onNote?.("Commitment removed.");
                    },
                  )
                }
              >
                Remove it
              </button>
            </span>
          ) : (
            /* Destructive, with nothing on the server to undo it, so the first
               click only asks. */
            <span key="ask" className={`flex items-center ${divider}`}>
              <button
                ref={ask}
                type="button"
                className={buttonBare}
                aria-describedby={textId}
                onClick={() => {
                  setConfirming(true);
                  onNote?.("Remove this commitment? Confirm or keep it.");
                }}
              >
                Remove
              </button>
            </span>
          ))}
      </span>
    </li>
  );
}
