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
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
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
 * Paper slid across a desk: pushed from rest, then slowed by friction alone.
 * The push is a constant acceleration, so position runs on t² — EASE_IN, whose
 * opening slope is zero, so nothing leaves at full speed on its first frame.
 * Friction is a constant deceleration, position on 1 - (1 - t)², and that
 * parabola is exactly FRICTION — the same drag note-set-down's settle is built on.
 */
const EASE_IN = "cubic-bezier(0.333, 0, 0.667, 0.333)";
const FRICTION = "cubic-bezier(0.333, 0.667, 0.667, 1)";
/** How long the push lasts. */
const PUSH_MS = 90;
/** The desk's friction, in px/s². The glide after the push takes about
    sqrt(2d/a), so a longer trip takes longer but not proportionally. */
const DECEL = 2400;

/**
 * A slide of `px`: PUSH_MS of push, then friction. Both phases share one peak
 * speed and each covers half of it on average, so the push hands over at the
 * same fraction of the way as of the time — `at`, which is therefore the one
 * offset every keyframe list for the move is split at.
 */
function slide(px: number): { duration: number; at: number } {
  const push = PUSH_MS / 1000;
  const glide = Math.min(0.61, Math.max(0.15, (-push + Math.sqrt(push * push + (8 * Math.abs(px)) / DECEL)) / 2));
  return { duration: Math.round((push + glide) * 1000), at: push / (push + glide) };
}

/** Keyframes for a move under slide(): `frame(f)` is the state f of the way there. */
function slideFrames(at: number, frame: (f: number) => Keyframe): Keyframe[] {
  return [
    { ...frame(0), offset: 0, easing: EASE_IN },
    { ...frame(at), offset: at, easing: FRICTION },
    { ...frame(1), offset: 1 },
  ];
}

/** The note touches down 37.9% into note-set-down's 790ms; the pill comes in then. */
const PILL_AT = 300;
const PILL_MS = 140;

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
  // The letters come from their own read, not from the wall's pages: an unread
  // kudo older than the first page is exactly the one somebody who has been
  // away needs to be handed.
  const waiting = useQuery({
    queryKey: ["kudos", org, slug, "waiting"],
    queryFn: () => api<Kudo[]>("GET", `${kudosApi(org, slug)}?waiting=1`),
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
  /** The letter on show, by id. It stays until it is put away: a newer one
      arriving never takes its place, it only says another is waiting. */
  const [pinned, setPinned] = useState("");
  /**
   * A put-away in flight. `queue` is the letters still waiting as the button
   * was pressed, frozen: anything arriving meanwhile is held back until the
   * note has come to rest, so nothing can shove the wall or the note mid-move.
   * The rest is what the letter looked like before the list changed.
   */
  const [moving, setMoving] = useState<{
    kudo: Kudo;
    queue: Kudo[];
    from: DOMRect | null;
    blockH: number;
    buttonTop: number | null;
    ghost: HTMLElement | null;
  } | null>(null);
  /** Bumped when the last letter has gone, so one arriving after it opens its
      own room rather than reusing the closed-up one. */
  const [gen, setGen] = useState(0);
  const live = useMemo(() => (waiting.data ?? []).filter((k) => !putAway.includes(k.id)), [waiting.data, putAway]);
  const liveRef = useRef(live);
  liveRef.current = live;
  // Newest first, like the wall. While a note is moving the queue is frozen.
  const queue = moving ? moving.queue : live;
  const leaving = moving && moving.queue.length === 0 ? moving.kudo : null;
  const shown = leaving ?? queue.find((k) => k.id === pinned) ?? queue[0];
  if (!leaving && shown && shown.id !== pinned) setPinned(shown.id);
  const more = !leaving && queue.length > 1;
  // A waiting kudo is a letter above the list, never a row in it too — and one
  // held back mid-move is neither until the move is over. The wall's own
  // unread flag counts as well, so a refetch of the wall that beats the letters'
  // own refetch cannot flash a new kudo into the list first.
  const letterIds = new Set([...live, ...queue].map((k) => k.id));
  const isLetter = (k: Kudo) =>
    letterIds.has(k.id) || (k.toUserId === meId && !!k.unread && !putAway.includes(k.id));
  const rows = all.filter((k) => !isLetter(k));
  // A kudo addressed to you is never folded: it is the one you came for. So the
  // fold counts only the others — putting a letter away adds a row of yours,
  // and that must never push somebody else's kudo behind Show all.
  const others = rows.filter((k) => k.toUserId !== meId);
  const folded = new Set(others.slice(SHOWN).map((k) => k.id));
  const visible = showAll ? rows : rows.filter((k) => !folded.has(k.id));
  // A Show all that reveals nothing is a dead control.
  const folds = folded.size > 0;
  const who = (id: string, you: string) => (id === meId ? you : nameOf(id));

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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const letterRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const letterButtonRef = useRef<HTMLButtonElement>(null);
  /** Whether the wall has already been drawn with its kudos. A letter mounting
      after that arrived live, so it opens its own room rather than shoving the
      wall down in one frame; one there on first paint simply is. */
  const wallShown = useRef(false);
  useEffect(() => {
    if (kudos.data && !waiting.isLoading) wallShown.current = true;
  }, [kudos.data, waiting.isLoading]);

  const rowEl = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-testid="kudo-${CSS.escape(id)}"]`) ?? null;

  // The put-away. The note's row is already in the list, at its date. If that
  // row is on screen, the row's note is drawn back onto the letter and slides
  // home (FLIP) while its slot opens; if it is not, the note is set down where
  // it is and the row simply takes its place in the list — no fling across the
  // page, and no scroll. Either way, when another letter waits, the label and
  // the button stay exactly where they are and the next note is already under
  // the one leaving; only when the last one goes does the letter close up.
  // Every part of the move runs on one slide() split at one offset, so all the
  // layout shifts the row feels sum with its offset to one straight path.
  useLayoutEffect(() => {
    if (!moving) return;
    const last = moving.queue.length === 0;
    const settle = () => {
      setMoving(null);
      if (last) setGen((g) => g + 1);
    };
    const root = letterRef.current;
    const row = rowEl(moving.kudo.id);
    // Focus goes somewhere stable before anything goes inert: it stays on the
    // same button when another letter waits, else it goes where the note is
    // going — or to the wall itself, for a letter from a page not loaded.
    if (last) {
      (row ?? headingRef.current)?.focus({ preventScroll: true });
      if (root) root.inert = true;
    }
    if (!root || typeof root.animate !== "function" || reducedMotion()) {
      settle();
      return;
    }
    const running: Animation[] = [];
    const undo: (() => void)[] = [];
    const hNow = root.getBoundingClientRect().height;
    const targetH = last ? 0 : hNow;
    const note = row?.querySelector<HTMLElement>('[data-testid="kudo-note"]') ?? null;
    const to = note?.getBoundingClientRect();
    // Where the row's note will rest once the letter has closed up.
    const toTop = to ? to.top - (hNow - targetH) : 0;
    const margin = 32;
    const glide = !!(to && moving.from && toTop >= -margin && toTop + to.height <= window.innerHeight + margin);
    const dx = glide ? moving.from!.left - to!.left : 0;
    const dy = glide ? moving.from!.top - toTop - (moving.blockH - targetH) : 0;
    const { duration, at } = slide(
      glide ? Math.hypot(moving.from!.left - to!.left, moving.from!.top - toTop) : Math.max(48, Math.abs(moving.blockH - targetH)),
    );
    const run = (el: HTMLElement, frame: (f: number) => Keyframe) =>
      running.push(el.animate(slideFrames(at, frame), { duration, easing: "linear", fill: "both" }));
    const hold = (el: HTMLElement, prop: "overflowY" | "position" | "zIndex" | "visibility", value: string) => {
      el.style[prop] = value;
      undo.push(() => (el.style[prop] = ""));
    };

    // The letter closes up to the next note's height, or to nothing.
    hold(root, "overflowY", "clip");
    run(root, (f) => ({ height: `${moving.blockH + (targetH - moving.blockH) * f}px` }));
    // The button stays put — or, if the next note is a different height, glides
    // the difference rather than jumping it.
    const button = letterButtonRef.current;
    if (!last && button && moving.buttonTop !== null) {
      const off = moving.buttonTop - button.getBoundingClientRect().top;
      if (Math.abs(off) > 0.5) run(button, (f) => ({ transform: `translateY(${off * (1 - f)}px)` }));
    }
    if (row) {
      // The row's slot opens under the rows above it. Set down in place, the
      // row is revealed as its slot opens rather than overlapping the next.
      const rowH = row.getBoundingClientRect().height;
      run(row, (f) =>
        glide
          ? { marginBottom: `${-rowH * (1 - f)}px` }
          : { marginBottom: `${-rowH * (1 - f)}px`, clipPath: `inset(0 0 ${rowH * (1 - f)}px 0)` },
      );
    }
    if (glide) {
      // Only the note moves, above the rows it passes; its row's divider stays
      // in the list, where the slot is opening.
      hold(note!, "position", "relative");
      hold(note!, "zIndex", "1");
      run(note!, (f) => ({ transform: `translate(${dx * (1 - f)}px, ${dy * (1 - f)}px)` }));
      if (last) {
        const own = root.querySelector<HTMLElement>('[data-testid="kudo-letter"]');
        if (own) own.style.visibility = "hidden";
        // What the last letter leaves behind — its label, its wash, the
        // pressed button — goes quickly, before the gap has closed over it.
        for (const el of root.querySelectorAll<HTMLElement>("[data-letter-leaves]")) {
          el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: PILL_MS, easing: FRICTION, fill: "forwards" });
        }
      }
    } else if (last) {
      // Set down where it is: the whole letter settles away as it closes up.
      run(root, (f) => ({ opacity: 1 - f }));
    } else if (moving.ghost && ghostRef.current && moving.from) {
      // Set down where it is, on top of the next one: the note leaving is
      // lowered onto the pile and gone, and the next is already underneath.
      const wrap = ghostRef.current.getBoundingClientRect();
      const g = moving.ghost;
      g.style.cssText = `position:absolute;margin:0;left:${moving.from.left - wrap.left}px;top:${moving.from.top - wrap.top}px;width:${moving.from.width}px`;
      ghostRef.current.append(g);
      undo.push(() => g.remove());
      run(g, (f) => ({ opacity: 1 - f, transform: `translateY(${3 * f}px) scale(${1 - 0.015 * f})` }));
    }
    let current = true;
    void Promise.all(running.map((a) => a.finished)).then(
      () => current && settle(),
      () => {},
    );
    return () => {
      current = false;
      for (const a of running) a.cancel();
      for (const u of undo) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per move
  }, [moving]);

  /** Presses are ignored until this instant: while one is being recorded, and
      for as long as the next letter takes to be seen — a double press, or a
      second one on the heels of the first, must not put away a letter that
      was on screen for a moment. A ref, so two presses in one tick agree. */
  const lockUntil = useRef(0);
  async function seen() {
    const k = shown;
    if (!k || moving || performance.now() < lockUntil.current) return;
    lockUntil.current = Infinity;
    setAckPending(k.id);
    try {
      await api("POST", kudoSeenApi(org, slug, k.id));
      // A refetch already in flight still says unread; it must not land after this.
      await qc.cancelQueries({ queryKey: ["kudos", org, slug] });
      qc.setQueryData<InfiniteData<Kudo[]>>(["kudos", org, slug], (d) =>
        d && { ...d, pages: d.pages.map((p) => p.map((x) => (x.id === k.id ? { ...x, unread: false } : x))) },
      );
      qc.setQueryData<Kudo[]>(["kudos", org, slug, "waiting"], (d) => d?.filter((x) => x.id !== k.id));
      const root = letterRef.current;
      const note = root?.querySelector<HTMLElement>('[data-testid="kudo-letter"] > [data-testid="kudo-note"]');
      // A copy of the note, for setting it down in place over the next one.
      const ghost = (note?.cloneNode(true) as HTMLElement | undefined) ?? null;
      if (ghost) {
        ghost.setAttribute("aria-hidden", "true");
        for (const el of [ghost, ...ghost.querySelectorAll("[data-testid]")]) el.removeAttribute("data-testid");
      }
      setMoving({
        kudo: k,
        queue: liveRef.current.filter((x) => x.id !== k.id),
        from: note?.getBoundingClientRect() ?? null,
        blockH: root?.getBoundingClientRect().height ?? 0,
        buttonTop: letterButtonRef.current?.getBoundingClientRect().top ?? null,
        ghost,
      });
      setPutAway((a) => [...a, k.id]);
      lockUntil.current = performance.now() + PILL_AT + PILL_MS;
    } catch (err) {
      lockUntil.current = 0;
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
      <h2 ref={headingRef} id={headingId} tabIndex={-1} className={railHeading}>
        Kudos
      </h2>
      <p className="mt-1 text-[13px] text-ink-faint text-pretty">
        Thanks by name. Nothing here is counted or ranked.
      </p>

      {kudos.isLoading || waiting.isLoading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Reading the wall…</p>
      ) : kudos.isError && !kudos.data ? (
        <RailError what="the kudos" onRetry={() => void kudos.refetch()} busy={kudos.isFetching} />
      ) : all.length === 0 ? (
        <p data-testid="kudos-empty" className="mt-3 text-[13px] text-ink-soft text-pretty">
          No kudos yet. The first one is the hardest — say what somebody did and who did it.
        </p>
      ) : (
        <>
          {/* One letter block, kept across letters: the label and the button
              are the same nodes from one letter to the next, so they stay
              still and focus stays on the button. It is re-keyed only after
              the last one has gone, so a later arrival opens its own room. */}
          {shown && (
            <KudoLetter
              key={`letter-${gen}`}
              rootRef={letterRef}
              ghostRef={ghostRef}
              buttonRef={letterButtonRef}
              from={nameOf(shown.fromUserId)}
              text={shown.text}
              head={toMeHead(shown)}
              more={more}
              grow={wallShown.current}
              leaving={!!leaving}
              pending={ackPending !== "" || !!moving}
              onPut={() => void seen()}
            />
          )}
          <ul ref={listRef} className="mt-2 flex flex-col divide-y divide-line">
            {visible.map((k) =>
              k.toUserId === meId ? (
                <li
                  key={k.id}
                  data-testid={`kudo-${k.id}`}
                  data-to-me
                  tabIndex={putAway.includes(k.id) ? -1 : undefined}
                  // No wash and no edge once read: the waiting letter alone
                  // carries the full treatment, and a read one is its note.
                  className="flex pt-2.5 pb-3"
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

/** A kudo addressed to the viewer, in the standup's closing list: a pip edge
    and a light wash behind the note. The wash is kept at 40% so the row still
    reads as the panel's own. */
export const toMeRow = "-mx-2 border-l-2 border-pip bg-accent-soft/40 px-2";

/** The waiting letter's edge and wash. The left padding gives back the 2px
    edge, so its note is exactly as wide as the row it will become — the
    slide moves one piece of paper, never one that changes shape on arrival.
    The pip edge is decorative (2.54:1 on the light wash): "Waiting for you"
    and "thanked you" say in words what it marks. */
const letterRow = "-mx-2 border-l-2 border-pip bg-accent-soft/40 pl-1.5 pr-2";

/**
 * An unread kudo to you, waiting above the wall as a letter — the only thing
 * on the wall with the pip edge, the wash and a label, so the one you have not
 * read leads the ones you have.
 *
 * The edge for "more than one waiting" is a sheet of paper under the note
 * alone, 5px showing below it and turned a little, the same for two as for
 * thirty; it falls with the note, so no frame shows it without its letter.
 */
function KudoLetter({
  rootRef,
  ghostRef,
  buttonRef,
  head,
  from,
  text,
  more,
  grow,
  leaving,
  pending,
  onPut,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  /** An empty layer over the note, for the copy set down in place. */
  ghostRef: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  head: ReactNode;
  from: string;
  text: string;
  /** Another letter is waiting after this one. A yes or no, never a number. */
  more: boolean;
  /** It arrived after the wall was drawn: open its room before it lands. */
  grow: boolean;
  /** The last one, put away: its note has gone, and what is left closes up. */
  leaving: boolean;
  /** A put-away is being recorded or is in flight; the button ignores presses. */
  pending: boolean;
  onPut: () => void;
}) {
  const moreId = useId();
  const [still] = useState(reducedMotion);
  // How long the landing waits for its room to open. Unknown (null) until the
  // room has been measured, and the letter is held invisible until then.
  const [delay, setDelay] = useState<number | null>(grow && !still ? null : 0);
  // The button is out of reach until its pill can be seen: nobody can put a
  // letter away they have not been shown.
  const [ready, setReady] = useState(still);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!grow || still || !el || typeof el.animate !== "function") {
      setDelay(0);
      return;
    }
    // The wall parts first and the letter drops into the gap, rather than
    // falling into a space still being shoved open under it.
    const h = el.getBoundingClientRect().height;
    const { duration, at } = slide(h);
    el.style.overflowY = "clip";
    const opening = el.animate(
      slideFrames(at, (f) => ({ height: `${h * f}px` })),
      { duration, easing: "linear" },
    );
    setDelay(duration);
    const done = () => {
      el.style.overflowY = "";
    };
    opening.finished.then(done, done);
    return () => opening.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  useEffect(() => {
    if (ready || delay === null) return;
    // A frame past the pill's own fade, so it is whole before it can be pressed.
    const t = setTimeout(() => setReady(true), delay + PILL_AT + PILL_MS + 20);
    return () => clearTimeout(t);
  }, [ready, delay]);

  const held = delay === null;
  return (
    <div
      ref={rootRef}
      data-testid="kudo-letter-block"
      style={{ "--land-delay": `${delay ?? 0}ms`, "--pill-delay": `${(delay ?? 0) + PILL_AT}ms` } as CSSProperties}
      aria-hidden={leaving || undefined}
    >
      <div
        role="group"
        aria-label="A thank-you waiting for you"
        aria-describedby={more ? moreId : undefined}
        // Padding, not margin, so the room it opens and closes starts and ends
        // at nothing.
        className={`pt-3 pb-2 ${held ? "opacity-0" : "animate-[letter-in_50ms_linear_var(--land-delay)_both]"}`}
      >
        <p data-letter-leaves aria-hidden="true" className="text-[12px] font-bold text-ink-soft">
          Waiting for you
        </p>
        <div data-letter-leaves className={`relative mt-1 flex pt-2.5 pb-3 ${letterRow}`}>
          <div
            data-testid="kudo-letter"
            // No landing is scheduled while it is held: it would play out unseen.
            className={`relative flex min-w-0 flex-1 ${held ? "" : "*:animate-[note-set-down_790ms_linear_var(--land-delay)_both]"}`}
          >
            {more && (
              <span
                data-testid="kudo-letter-stack"
                aria-hidden="true"
                className="visible absolute inset-x-1.5 top-[5px] -bottom-[5px] rotate-[0.4deg] rounded-chip bg-surface-hi shadow-rest"
              />
            )}
            <KudoNote className="relative" from={from} text={text} words="text-[15px]" head={head} />
          </div>
          <div ref={ghostRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1]" />
        </div>
        {/* hidden: said once, as the group's description, never read again as content. */}
        {more && (
          <span id={moreId} hidden>
            Another is waiting after this one.
          </span>
        )}
        <button
          ref={buttonRef}
          type="button"
          data-letter-leaves
          inert={!ready || undefined}
          aria-disabled={pending || undefined}
          aria-label={`Put it with the others, ${from}'s thank-you`}
          className={`${smallPill} -ml-2 mt-1 ${held ? "opacity-0" : ready ? "" : "animate-[letter-pill-in_140ms_ease-out_var(--pill-delay)_both]"}`}
          onClick={onPut}
        >
          <span className={smallPillFace}>Put it with the others</span>
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
