import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, errorText, type Kudo, type Person } from "../lib/api";
import { Avatar } from "./Avatar";
import { buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";
import { kudoSeenApi, kudosApi } from "../lib/paths";
import { safeDisplayName } from "../lib/displayName";
import { TOUCH_HIT } from "../lib/breakpoints";
import { useToast } from "../lib/ui";
import { RailError, railHeading } from "./RailPanel";

/** Who a Thank pressed outside the wall is for. */
export type ThankRequest = { userId: string };

/** The wall shows this many before it asks to show the rest. */
const SHOWN = 5;
/** A full page from the server; a shorter one is the end of the wall. */
const PAGE = 100;
/** The counter stays out of the way until this few characters are left. */
const WARN_AT = 40;

/** Matches maxKudoRunes in internal/api/kudos.go and the CHECK in 0033_kudos.sql. */
const MAX_RUNES = 280;

/**
 * Paper slid across a desk: pushed once, then slowed by friction alone. A
 * constant deceleration puts position on 1 - (1 - t)², and that parabola is
 * exactly this cubic Bézier — the same drag note-set-down's settle is built on.
 */
const FRICTION = "cubic-bezier(0.333, 0.667, 0.667, 1)";
/** The desk's friction, in px/s². A slide takes sqrt(2d/a), so a longer trip
    takes longer but not proportionally — nothing moves on a uniform clock. */
const DECEL = 2400;

/** How long a slide of `px` takes to come to rest under FRICTION. */
function slideMs(px: number): number {
  return Math.round(Math.min(700, Math.max(240, Math.sqrt((2 * Math.abs(px)) / DECEL) * 1000)));
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How long ago, in the coarsest unit that still says something. A kudos wall is
 * read in order, so the exact minute matters far less than "this morning" —
 * and the machine-readable instant travels on the <time> element regardless.
 *
 * `now` is a parameter rather than a call to Date.now inside, so the behaviour
 * is testable without freezing the clock for the whole suite.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The kudos wall on a space: a form to thank somebody, and everything the
 * space has said, newest first.
 *
 * There is deliberately no count anywhere — not per person, not in the
 * heading. A number beside a name is a leaderboard however quietly it is
 * drawn, and the whole point of this surface is that thanking somebody is not
 * a scoreboard event.
 *
 * A kudo outlives the people in it: the recipient can leave the space and the
 * record stays. So no lookup here assumes a userId resolves to a current
 * member — an id with nobody behind it is named rather than left blank, which
 * is the case that would otherwise render an empty line or crash.
 */
export function Kudos({
  org,
  slug,
  members,
  meId,
  thank = null,
}: {
  org: string;
  slug: string;
  /** The space roster, as SpacePage already has it. */
  members: Person[] | undefined;
  meId: string;
  /**
   * A Thank pressed somewhere else on the page — the sidebar's member rows.
   * A fresh object per press, so pressing the same person twice still opens
   * the form a second time.
   */
  thank?: ThankRequest | null;
}) {
  const qc = useQueryClient();
  const say = useToast();
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** The letter whose seen request is in flight, "" for none. Its own state, so
      putting a letter away never disables the Thank form. */
  const [ackPending, setAckPending] = useState("");
  /** The kudo whose withdrawal has been asked about, "" for none. */
  const [confirming, setConfirming] = useState("");
  /** Whether the give form is unfolded. It starts folded: the wall is the
      thing most visits come to read. */
  const [formOpen, setFormOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** Where focus goes once the form has (un)folded. A fresh object per move,
      not the bare target: a second Thank asks for "text" again, and an
      unchanged string would never re-run the effect that moves focus. */
  const [focusTo, setFocusTo] = useState<{ el: "to" | "text" | "trigger" } | null>(null);
  const [lastThank, setLastThank] = useState<ThankRequest | null>(thank);
  const headingId = useId();
  const countId = useId();
  const formId = useId();
  const toRef = useRef<HTMLSelectElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The cursor is the last row's createdAt exactly as the server sent it:
  // re-serialising it through Date would drop the microseconds and skip rows.
  const kudos = useInfiniteQuery({
    queryKey: ["kudos", org, slug],
    queryFn: ({ pageParam }) =>
      api<Kudo[]>(
        "GET",
        pageParam
          ? `${kudosApi(org, slug)}?${new URLSearchParams({ before: pageParam.createdAt, beforeId: pageParam.id })}`
          : kudosApi(org, slug),
      ),
    initialPageParam: null as Kudo | null,
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1] : undefined),
    retry: false,
  });

  const roster = useMemo(() => members ?? [], [members]);
  // Yourself is not a recipient — the server answers 400 — and neither is a
  // link guest, who may neither send nor receive.
  const candidates = useMemo(
    () => roster.filter((m) => m.userId !== meId && !m.guest),
    [roster, meId],
  );
  const byId = useMemo(() => new Map(roster.map((m) => [m.userId, m])), [roster]);
  const nameOf = (id: string) => safeDisplayName(byId.get(id)?.name ?? "Someone who has left");
  // Two people may share a display name, and a picker offering "Kade" twice
  // is a coin toss. The id is the only thing the roster sends that tells them
  // apart, so its tail is the suffix — stable across visits, and nothing the
  // members could not already see in a URL.
  const optionLabel = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of candidates) {
      const name = safeDisplayName(m.name);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return (m: Person) => {
      const name = safeDisplayName(m.name);
      return (seen.get(name) ?? 0) > 1 ? `${name} · ${m.userId.slice(-4)}` : name;
    };
  }, [candidates]);

  // A Thank from the sidebar: unfold the form with that person chosen and
  // put the caret where the words go. Adjusted during render rather than in
  // an effect, so the form never paints a frame with the old recipient.
  if (thank !== lastThank) {
    setLastThank(thank);
    if (thank && candidates.some((m) => m.userId === thank.userId)) {
      setFormOpen(true);
      setTo(thank.userId);
      setFocusTo({ el: "text" });
    }
  }

  useEffect(() => {
    if (!focusTo) return;
    const el = { to: toRef, text: textRef, trigger: triggerRef }[focusTo.el].current;
    // Focusing scrolls the field into view on its own, instantly, which is
    // what a reduced-motion reader wants and costs everyone else nothing.
    el?.focus();
  }, [focusTo]);

  function unfold() {
    setFormOpen(true);
    setFocusTo({ el: "to" });
  }

  function fold() {
    setFormOpen(false);
    setFocusTo({ el: "trigger" });
  }

  function onFormKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      fold();
    }
  }

  // Runes, not UTF-16 units: the handler counts runes, so a `maxLength` of 280
  // on the field would let an emoji-heavy kudo past the counter and straight
  // into a 400.
  const left = MAX_RUNES - [...text].length;
  const all = useMemo(() => kudos.data?.pages.flat() ?? [], [kudos.data]);
  /** Letters put with the others this visit. Also a filter, so no answer from
      the server that is older than the put-away can land one again. */
  const [putAway, setPutAway] = useState<string[]>([]);
  /**
   * A letter on its way to its row. `from` is where its note sat and `blockH`
   * the height the letter took up, both read before the list changed. While
   * this is set the letter stays mounted, emptied, and closes up; the next one
   * lands only once the note has come to rest.
   */
  const [moving, setMoving] = useState<{ id: string; from: DOMRect | null; blockH: number } | null>(null);
  /** Set once a put-away has settled, to move focus after it. */
  const [landed, setLanded] = useState<{ id: string } | null>(null);
  // An unread kudo to you waits as a letter above the list, not in it too.
  const isLetter = (k: Kudo) => k.toUserId === meId && !!k.unread && !putAway.includes(k.id);
  const letters = all.filter(isLetter);
  const rows = all.filter((k) => !isLetter(k));
  // A kudo addressed to you is never folded: it is the one you came for.
  const visible = showAll ? rows : rows.filter((k, i) => i < SHOWN || k.toUserId === meId);
  // Whether the fold hides anything: rows past it that are all yours stay
  // shown, and a Show all that reveals nothing is a dead control.
  const folds = rows.some((k, i) => i >= SHOWN && k.toUserId !== meId);
  const who = (id: string, you: string) => (id === meId ? you : nameOf(id));
  // While one is on its way to its row it is still drawn, emptied, as it closes
  // up; the next waiting letter lands only after.
  const letter = moving ? all.find((k) => k.id === moving.id) : letters[0];
  /** The letter after it: its room opens during the put-away, and it lands after. */
  const incoming = moving ? letters[0] : undefined;

  async function give(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!to || !t || left < 0 || busy) return;
    setBusy(true);
    try {
      await api("POST", kudosApi(org, slug), { to, text: t });
      await qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      setText("");
      setTo("");
      say(`Kudos sent to ${nameOf(to)}.`);
      fold();
    } catch (err) {
      say(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const listRef = useRef<HTMLUListElement>(null);
  const letterRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const letterButtonRef = useRef<HTMLButtonElement>(null);
  /** Whether the wall has already been drawn with its kudos. A letter mounting
      after that arrived live, so it opens its own room rather than shoving the
      wall down in one frame; one there on first paint simply is. */
  const wallShown = useRef(false);
  useEffect(() => {
    if (kudos.data) wallShown.current = true;
  }, [kudos.data]);

  const rowEl = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-testid="kudo-${CSS.escape(id)}"]`) ?? null;

  // The put-away. The note's row is already in the list, at its date; it is
  // drawn back onto the letter and slides home (FLIP), while the letter closes
  // up, the next letter's room (if one waits) opens in its place, and the row
  // opens its slot — all over the same beat, on the same curve. Every layout
  // shift the row feels is a multiple of that one curve, so offset and shifts
  // sum to one straight slide from the letter to the row. The next letter only
  // drops into its room once all of that has come to rest.
  useLayoutEffect(() => {
    if (!moving) return;
    const settle = () => {
      setMoving(null);
      setLanded({ id: moving.id });
    };
    const root = letterRef.current;
    const row = rowEl(moving.id);
    const note = row?.querySelector<HTMLElement>('[data-testid="kudo-note"]');
    if (!root || !row || !note || !moving.from || typeof row.animate !== "function" || reducedMotion()) {
      // Reduced motion, or nothing to measure: the swap is instant.
      settle();
      return;
    }
    // Measured with the next letter's room at its full height; it starts at 0.
    const next = incomingRef.current;
    const nextH = next ? next.getBoundingClientRect().height : 0;
    const to = note.getBoundingClientRect();
    const rowH = row.getBoundingClientRect().height;
    const dx = moving.from.left - to.left;
    const dy = moving.from.top - (to.top - nextH);
    const opts: KeyframeAnimationOptions = {
      duration: slideMs(Math.hypot(dx, moving.from.top - (to.top - moving.blockH))),
      easing: FRICTION,
      fill: "both",
    };
    root.style.overflowY = "clip";
    if (next) next.style.overflowY = "clip";
    const running = [
      root.animate([{ height: `${moving.blockH}px` }, { height: "0px" }], opts),
      ...(next ? [next.animate([{ height: "0px" }, { height: `${nextH}px` }], opts)] : []),
      row.animate(
        [
          { marginBottom: `${-rowH}px`, transform: `translate(${dx}px, ${dy}px)` },
          { marginBottom: "0px", transform: "none" },
        ],
        opts,
      ),
    ];
    // What stays behind on the letter — its label, the edge, the pressed
    // button — goes quickly, before the gap has closed over it.
    for (const el of root.querySelectorAll<HTMLElement>("[data-letter-leaves]")) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: FRICTION, fill: "forwards" });
    }
    let live = true;
    void Promise.all(running.map((a) => a.finished)).then(
      () => live && settle(),
      () => {},
    );
    return () => {
      live = false;
      for (const a of running) a.cancel();
      if (next) next.style.overflowY = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per move
  }, [moving]);

  // Focus follows the put-away: to the next letter if one is waiting, else to
  // the row the note went into. Never a jump scroll for a target on screen.
  useEffect(() => {
    if (!landed) return;
    const target = letterButtonRef.current ?? rowEl(landed.id);
    if (!target) return;
    target.focus({ preventScroll: true });
    const r = target.getBoundingClientRect();
    if ((r.top < 0 || r.bottom > window.innerHeight) && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [landed]);

  async function seen(id: string) {
    if (ackPending || moving) return;
    setAckPending(id);
    try {
      await api("POST", kudoSeenApi(org, slug, id));
      // A refetch already in flight still says unread; it must not land after this.
      await qc.cancelQueries({ queryKey: ["kudos", org, slug] });
      qc.setQueryData<InfiniteData<Kudo[]>>(["kudos", org, slug], (d) =>
        d && { ...d, pages: d.pages.map((p) => p.map((k) => (k.id === id ? { ...k, unread: false } : k))) },
      );
      const root = letterRef.current;
      const note = root?.querySelector<HTMLElement>('[data-testid="kudo-note"]');
      setMoving({ id, from: note?.getBoundingClientRect() ?? null, blockH: root?.getBoundingClientRect().height ?? 0 });
      setPutAway((a) => [...a, id]);
    } catch (err) {
      say(errorText(err));
    } finally {
      setAckPending("");
    }
  }

  const toMeHead = (k: Kudo) => (
    <>
      <Avatar
        name={nameOf(k.fromUserId)}
        hue={byId.get(k.fromUserId)?.avatarHue ?? 0}
        icon={byId.get(k.fromUserId)?.avatarIcon}
        size="sm"
        decorative
      />
      <span data-testid="kudo-who" className="min-w-0 flex-1 break-words text-[13px] text-ink-soft">
        <span className="font-semibold text-ink">{nameOf(k.fromUserId)}</span>{" "}
        <span className="whitespace-nowrap">thanked <span className="font-semibold text-ink">you</span></span>
      </span>
      {/* ink-soft, not ink-faint: on the raised note in the
          dark theme ink-faint measures only 4.59:1. */}
      <time dateTime={k.createdAt} className="shrink-0 text-[12px] text-ink-soft">
        {ago(k.createdAt)}
      </time>
    </>
  );

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await api("DELETE", `${kudosApi(org, slug)}/${id}`);
      await qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      setConfirming("");
      say("Kudos withdrawn.");
    } catch (err) {
      say(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="kudos"
      aria-labelledby={headingId}
      className="rounded-panel border border-line bg-surface px-5 py-5"
    >
      <h2 id={headingId} className={railHeading}>
        Kudos
      </h2>
      <p className="mt-1 text-[13px] text-ink-faint text-pretty">
        Thanks by name. Nothing here is counted or ranked.
      </p>

      {kudos.isLoading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Reading the wall…</p>
      ) : kudos.isError && !kudos.data ? (
        <RailError what="the kudos" onRetry={() => void kudos.refetch()} busy={kudos.isFetching} />
      ) : all.length === 0 ? (
        <p data-testid="kudos-empty" className="mt-3 text-[13px] text-ink-soft text-pretty">
          No kudos yet. The first one is the hardest — say what somebody did and who did it.
        </p>
      ) : (
        <>
          {/* Keyed by id in one list, so a refetch keeps the same node and the
              landing plays once per letter, not on every refresh of the wall —
              and the next letter, mounted early to open its room, is the same
              node when it lands. */}
          {[letter, incoming].map(
            (k) =>
              k && (
                <KudoLetter
                  key={k.id}
                  rootRef={k === incoming ? incomingRef : letterRef}
                  buttonRef={k === letter && moving ? undefined : letterButtonRef}
                  from={nameOf(k.fromUserId)}
                  text={k.text}
                  head={toMeHead(k)}
                  more={letters.length > 1}
                  grow={wallShown.current}
                  leaving={k === letter && !!moving}
                  incoming={k === incoming}
                  pending={ackPending !== ""}
                  onPut={() => void seen(k.id)}
                />
              ),
          )}
          <ul ref={listRef} className="mt-2 flex flex-col divide-y divide-line">
            {visible.map((k) =>
              k.toUserId === meId ? (
                <li
                  key={k.id}
                  data-testid={`kudo-${k.id}`}
                  data-to-me
                  tabIndex={putAway.includes(k.id) ? -1 : undefined}
                  className={`flex pt-2.5 pb-3 ${toMeRow}`}
                >
                  {/* Never a withdraw control here: nobody can thank
                      themselves, so a kudo to you is never yours to take back. */}
                  <KudoNote
                    from={nameOf(k.fromUserId)}
                    text={k.text}
                    words="text-[15px]"
                    head={toMeHead(k)}
                  />
                </li>
              ) : (
              <li
                key={k.id}
                data-testid={`kudo-${k.id}`}
                className="flex flex-wrap items-start gap-3 py-3"
              >
                <Avatar
                  name={nameOf(k.fromUserId)}
                  hue={byId.get(k.fromUserId)?.avatarHue ?? 0}
                  icon={byId.get(k.fromUserId)?.avatarIcon}
                  size="sm"
                  decorative
                />
                {/* min-w-0 is what actually lets the wrapping below happen: a
                    flex child defaults to min-content width, so an unbroken word
                    would otherwise widen the row past the panel. */}
                <span className="min-w-0 flex-1">
                  <span data-testid="kudo-who" className="block break-words text-[13px] text-ink-soft">
                    <span className="font-semibold text-ink">{who(k.fromUserId, "You")}</span> thanked{" "}
                    <span className="font-semibold text-ink">{nameOf(k.toUserId)}</span>
                  </span>
                  <span data-testid="kudo-text" className="mt-0.5 block break-words text-[14px]">
                    {k.text}
                  </span>
                  <time dateTime={k.createdAt} className="mt-1 block text-[12px] text-ink-faint">
                    {ago(k.createdAt)}
                  </time>
                  {/* Only the sender, matching the handler: everyone else gets
                      a 403 there, so offering the control would be a lie. It
                      sits under the words rather than beside them, so a narrow
                      column keeps its width for the thank-you itself. */}
                  {k.fromUserId === meId &&
                    (confirming === k.id ? (
                      <span className="-ml-2 flex flex-wrap items-center">
                        <button type="button" className={smallPill} onClick={() => setConfirming("")}>
                          <span className={smallPillFace}>Keep it</span>
                        </button>
                        <button
                          type="button"
                          className={smallPill}
                          disabled={busy}
                          onClick={() => void withdraw(k.id)}
                        >
                          <span className={smallPillFace}>Withdraw it</span>
                        </button>
                      </span>
                    ) : (
                      /* Nothing on the server undoes a withdrawal, so the
                         first click only asks. */
                      <button
                        type="button"
                        className={`${smallPill} -ml-2`}
                        aria-label={`Withdraw: ${k.text}`}
                        onClick={() => setConfirming(k.id)}
                      >
                        <span className={smallPillFace}>Withdraw</span>
                      </button>
                    ))}
                </span>
              </li>
              ),
            )}
          </ul>
          {/* No number on the way to the rest: the wall's length is a
              count too, and nothing here is counted. */}
          {folds && (
            <button
              type="button"
              aria-expanded={showAll}
              className={`${TOUCH_HIT} -mx-2 px-2 text-[13px] font-bold text-accent hover:underline`}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show fewer" : "Show all"}
            </button>
          )}
          {(showAll || !folds) && kudos.hasNextPage && (
            <button
              type="button"
              disabled={kudos.isFetchingNextPage}
              className={`${TOUCH_HIT} -mx-2 px-2 text-[13px] font-bold text-accent hover:underline disabled:opacity-50`}
              onClick={() => {
                // Asking for older kudos is asking to see them, so the fold
                // opens rather than swallowing the page that just arrived.
                setShowAll(true);
                void kudos.fetchNextPage();
              }}
            >
              Show older
            </button>
          )}
        </>
      )}

      {candidates.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-faint text-pretty">
          Nobody else is in this space yet — invite someone and you will have somebody to thank.
        </p>
      ) : !formOpen ? (
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={false}
          aria-controls={formId}
          className={`${TOUCH_HIT} ${buttonQuiet} mt-4 w-full`}
          onClick={unfold}
        >
          Thank someone
        </button>
      ) : (
        <form
          id={formId}
          aria-label="Thank someone"
          className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
          onSubmit={give}
          onKeyDown={onFormKey}
        >
          <label className="flex flex-col gap-1">
            <span className={labelText}>To</span>
            {/* A native select: it is keyboard-operable, screen-reader
                announced and mobile-native for free, which a hand-rolled
                listbox would each have to earn back. */}
            <select
              ref={toRef}
              className={inputClass}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="">Choose somebody</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {optionLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelText}>For what</span>
            <input
              ref={textRef}
              className={inputClass}
              value={text}
              aria-describedby={countId}
              aria-invalid={left < 0 || undefined}
              onChange={(e) => setText(e.target.value)}
              placeholder="What did they do?"
            />
          </label>
          {/* Quiet until it matters. The numeral is the only data in the
              line, so it alone is mono and tabular — it must not jitter as
              it falls. */}
          <span id={countId} className="text-[13px] empty:hidden">
            {left <= WARN_AT && (
              <span data-testid="kudos-left" className={left < 0 ? "text-stop" : "text-ink-faint"}>
                {left < 0 ? (
                  <>
                    <span className="font-mono tabular-nums">{-left}</span> over — shorten it to{" "}
                    {MAX_RUNES} characters to send
                  </>
                ) : (
                  <>
                    <span className="font-mono tabular-nums">{left}</span> characters left
                  </>
                )}
              </span>
            )}
          </span>
          {/* Said once, when the text first runs over, rather than on every
              keystroke the visible counter changes on. */}
          <span data-testid="kudos-over" aria-live="polite" className="sr-only">
            {left < 0 ? `Too long to send. A kudo is at most ${MAX_RUNES} characters.` : ""}
          </span>
          <span className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={`${TOUCH_HIT} ${buttonQuiet}`} onClick={fold}>
              Cancel
            </button>
            <button
              type="submit"
              className={`${TOUCH_HIT} ${buttonPrimary}`}
              disabled={!to || !text.trim() || left < 0 || busy}
            >
              Give kudos
            </button>
          </span>
        </form>
      )}
    </section>
  );
}

/** A kudo addressed to the viewer: a pip edge and a light wash behind the
    note. The wash is kept at 40% so the row still reads as the panel's own. */
export const toMeRow = "-mx-2 border-l-2 border-pip bg-accent-soft/40 px-2";

/**
 * An unread kudo to you, waiting above the wall as a letter.
 *
 * It carries the same pip edge and wash as a to-you row — the unread one must
 * never look less yours than the ones you have read — and one plain label.
 * The edge for "more than one waiting" is a sheet of paper under the note
 * alone, 4–6px showing below it (5px, turned a little), the same for two as for thirty; it falls with
 * the note, so no frame shows it without its letter.
 */
function KudoLetter({
  rootRef,
  buttonRef,
  head,
  from,
  text,
  more,
  grow,
  leaving,
  incoming,
  pending,
  onPut,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null> | undefined;
  head: ReactNode;
  from: string;
  text: string;
  /** Another letter is waiting after this one. A yes or no, never a number. */
  more: boolean;
  /** It arrived after the wall was drawn: open its room before it lands. */
  grow: boolean;
  /** Put away: its note has gone to its row, and what is left closes up. */
  leaving: boolean;
  /** Next after one being put away: its room is opening, and it has not landed. */
  incoming: boolean;
  pending: boolean;
  onPut: () => void;
}) {
  const moreId = useId();
  // How long the landing waits for its room to open. Unknown (null) until the
  // room has been measured, and the letter is held invisible until then.
  const [delay, setDelay] = useState<number | null>(grow && !incoming ? null : 0);
  const held = incoming || delay === null;

  useLayoutEffect(() => {
    const el = rootRef.current;
    // An incoming letter's room is opened by the put-away, in step with it.
    if (!grow || incoming || !el) return;
    if (typeof el.animate !== "function" || reducedMotion()) {
      setDelay(0);
      return;
    }
    // The wall parts first and the letter drops into the gap, rather than
    // falling into a space still being shoved open under it.
    const h = el.getBoundingClientRect().height;
    const ms = slideMs(h);
    el.style.overflowY = "clip";
    const opening = el.animate([{ height: "0px" }, { height: `${h}px` }], { duration: ms, easing: FRICTION });
    setDelay(ms);
    const done = () => {
      el.style.overflowY = "";
    };
    opening.finished.then(done, done);
    return () => opening.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  return (
    <div
      ref={rootRef}
      data-testid="kudo-letter-block"
      style={{ "--land-delay": `${delay ?? 0}ms` } as CSSProperties}
      inert={leaving || incoming}
      aria-hidden={leaving || incoming || undefined}
    >
      <div
        role="group"
        aria-label="A thank-you waiting for you"
        aria-describedby={more ? moreId : undefined}
        // Padding, not margin, so the room it opens and closes starts and ends
        // at nothing. Held transparent rather than hidden while it is measured:
        // a hidden button could not take focus handed to it on arrival.
        className={`pt-3 pb-2 ${held ? "opacity-0" : "animate-[letter-in_50ms_linear_var(--land-delay)_both]"}`}
      >
        <p data-letter-leaves aria-hidden="true" className="text-[12px] font-bold text-ink-soft">
          Waiting for you
        </p>
        {/* The row the note will join, drawn the same, so the put-away is one
            piece of paper moving rather than one shape swapped for another. */}
        <div className={`mt-1 flex pt-2.5 pb-3 ${toMeRow} ${leaving ? "invisible" : ""}`}>
          <div
            data-testid="kudo-letter"
            // No landing is scheduled while it is held: it would play out unseen.
            className={`relative flex min-w-0 flex-1 ${held ? "" : "*:animate-[note-set-down_790ms_linear_var(--land-delay)_both]"}`}
          >
            {more && (
              <span
                data-testid="kudo-letter-stack"
                data-letter-leaves
                aria-hidden="true"
                className="visible absolute inset-x-1.5 top-[5px] -bottom-[5px] rotate-[0.4deg] rounded-chip bg-surface-hi shadow-rest"
              />
            )}
            <KudoNote className="relative" from={from} text={text} words="text-[15px]" head={head} />
          </div>
        </div>
        {more && (
          <span id={moreId} className="sr-only">
            Another is waiting after this one.
          </span>
        )}
        <button
          ref={buttonRef}
          type="button"
          data-letter-leaves
          disabled={pending}
          className={`${smallPill} -ml-2 mt-1 ${held ? "" : "animate-[letter-pill-in_790ms_linear_var(--land-delay)_both]"}`}
          onClick={onPut}
        >
          <span className={smallPillFace}>Put it with the others</span>
          <span className="sr-only">, {from}'s thank-you</span>
        </button>
      </div>
    </div>
  );
}

/**
 * A kudo addressed to the viewer, handed to them: the words on a raised note,
 * signed by whoever sent it. The wall and the standup's closing list both draw
 * it, so a thank-you looks the same wherever it reaches you.
 *
 * The sign-off repeats the name the head line already says, so it is hidden
 * from a screen reader rather than read twice. There is one note per kudo and
 * nothing on it is counted.
 */
export function KudoNote({
  head,
  from,
  text,
  words,
  className = "",
}: {
  /** The line above the words: who thanked you, and on the wall their face and when. */
  head: ReactNode;
  /** The sender's display name, for the sign-off. */
  from: string;
  text: string;
  /** The words' type size: the wall sets them a step larger than the standup list. */
  words: string;
  className?: string;
}) {
  return (
    <span
      data-testid="kudo-note"
      className={`block min-w-0 flex-1 rounded-chip bg-surface-hi px-3 pt-2.5 pb-[9px] shadow-rest ${className}`}
    >
      <span className="flex items-center gap-2">{head}</span>
      <span data-testid="kudo-text" className={`mt-2 block break-words leading-[1.45] text-ink text-pretty ${words}`}>
        {text}
      </span>
      <span
        data-testid="kudo-sign"
        aria-hidden="true"
        className="mt-1.5 block break-words text-right text-[13px] font-semibold text-ink-soft"
      >
        — {from}
      </span>
    </span>
  );
}

/** A small pill inside a full-size hit area: the target is 44px, the face is not. */
const smallPill = `${TOUCH_HIT} pill-hit inline-flex items-center justify-center px-2 disabled:opacity-50`;
const smallPillFace =
  "pill-face rounded-full border border-line-strong px-3 py-1 text-[12px] font-bold text-ink-soft hover:bg-felt-deep";
