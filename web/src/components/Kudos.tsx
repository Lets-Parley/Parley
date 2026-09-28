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
import { api, ApiError, errorText, type Kudo, type Person } from "../lib/api";
import { Avatar } from "./Avatar";
import { buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";
import { kudoAnswerApi, kudoSeenApi, kudosApi } from "../lib/paths";
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
    // Anything but a list (a proxy's error page, say) is read as no letters
    // rather than handed to a render that would throw on it.
    queryFn: async () => {
      const got = await api<Kudo[]>("GET", `${kudosApi(org, slug)}?waiting=1`);
      return Array.isArray(got) ? got : [];
    },
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
  /** The letter drawn last render, so one whose kudo has gone can still be set down. */
  const lastShown = useRef<Kudo | null>(null);
  // The letter on show left the waiting set without being put away here: its
  // sender withdrew it, or it was read somewhere else. It is drawn one render
  // more, so it can be set down in place rather than unmounted in one frame.
  const vanished =
    !moving && pinned !== "" && !putAway.includes(pinned) && lastShown.current?.id === pinned && !live.some((k) => k.id === pinned)
      ? lastShown.current
      : null;
  const shown = leaving ?? vanished ?? queue.find((k) => k.id === pinned) ?? queue[0];
  lastShown.current = shown ?? null;
  if (!leaving && !vanished && shown && shown.id !== pinned) setPinned(shown.id);
  const more = !leaving && queue.some((k) => k.id !== shown?.id);
  // A waiting kudo is a letter above the list, never a row in it too — and one
  // held back mid-move is neither until the move is over. The wall's own
  // unread flag counts as well, so a refetch of the wall that beats the letters'
  // own refetch cannot flash a new kudo into the list first.
  const letterIds = new Set([...live, ...queue, ...(vanished ? [vanished] : [])].map((k) => k.id));
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
      if (last) {
        setGen((g) => g + 1);
        setPinned("");
      }
    };
    const root = letterRef.current;
    const row = rowEl(moving.kudo.id);
    // Focus goes somewhere stable before anything goes inert: it stays on the
    // same button when another letter waits, else it goes where the note is
    // going — or to the wall itself, for a letter from a page not loaded or one
    // that no longer exists. Focus that was never in the letter is left alone.
    if (last) {
      const at = document.activeElement;
      if (!at || at === document.body || root?.contains(at)) (row ?? headingRef.current)?.focus({ preventScroll: true });
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
    // Set down in place on top of the next one, the note slides off the pile:
    // down and out of the letter's slot, far enough that none of it is left.
    const pile = !glide && !last && moving.ghost && moving.from ? ghostRef.current : null;
    const wrap = pile?.getBoundingClientRect();
    const drop = wrap ? Math.max(0, wrap.bottom - moving.from!.top) : 0;
    const { duration, at } = slide(
      glide
        ? Math.hypot(moving.from!.left - to!.left, moving.from!.top - toTop)
        : drop || Math.max(48, Math.abs(moving.blockH - targetH)),
    );
    const run = (el: HTMLElement, frame: (f: number) => Keyframe) =>
      running.push(el.animate(slideFrames(at, frame), { duration, easing: "linear", fill: "both" }));
    const hold = (el: HTMLElement, prop: "overflow" | "overflowY" | "outlineStyle" | "position" | "zIndex" | "visibility", value: string) => {
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
      // A slot still empty is no place to draw a focus ring; it shows once the
      // note is home.
      hold(row, "outlineStyle", "none");
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
    } else if (pile && wrap && moving.ghost && moving.from) {
      // Set down where it is, on top of the next one: the note leaving is the
      // top sheet, slid off the pile and out of the slot, whole and opaque the
      // whole way, so the next one is uncovered rather than faded through it.
      const g = moving.ghost;
      g.style.cssText = `position:absolute;margin:0;left:${moving.from.left - wrap.left}px;top:${moving.from.top - wrap.top}px;width:${moving.from.width}px`;
      hold(pile, "overflow", "clip");
      pile.append(g);
      undo.push(() => g.remove());
      run(g, (f) => ({ transform: `translateY(${drop * f}px)` }));
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

  /** Starts the move for the letter on show, measured as it stands now. */
  function setDown(k: Kudo) {
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
  }

  // Before paint: the letter that vanished is still on screen, so it is
  // measured where it stands and set down from there.
  useLayoutEffect(() => {
    if (vanished) setDown(vanished);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per vanished letter
  }, [vanished?.id]);

  async function seen() {
    const k = shown;
    if (!k || moving || performance.now() < lockUntil.current) return;
    lockUntil.current = Infinity;
    setAckPending(k.id);
    try {
      let gone = false;
      try {
        await api("POST", kudoSeenApi(org, slug, k.id));
      } catch (err) {
        // Withdrawn before it was put away: there is nothing left to mark, so
        // it is put away all the same, without an error for something already done.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        gone = true;
      }
      // A refetch already in flight still says unread; it must not land after this.
      await qc.cancelQueries({ queryKey: ["kudos", org, slug] });
      qc.setQueryData<InfiniteData<Kudo[]>>(["kudos", org, slug], (d) =>
        d && {
          ...d,
          pages: d.pages.map((p) =>
            gone ? p.filter((x) => x.id !== k.id) : p.map((x) => (x.id === k.id ? { ...x, unread: false } : x)),
          ),
        },
      );
      qc.setQueryData<Kudo[]>(["kudos", org, slug, "waiting"], (d) => d?.filter((x) => x.id !== k.id));
      setDown(k);
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

  async function answerKudo(k: Kudo, text: string | null): Promise<AnswerResult> {
    try {
      await (text === null
        ? api("DELETE", kudoAnswerApi(org, slug, k.id))
        : api("PUT", kudoAnswerApi(org, slug, k.id), { text }));
      // Saved is saved: the control shows it from here. The refetch only
      // catches the wall up, and one that fails must not hold the field.
      void qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      return true;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status !== 404 && status !== 409) {
        say(errorText(err));
        return false;
      }
      // Somebody moved first: the sender withdrew the kudo (404), or an
      // answer was already given, in another tab say (409). Either way the
      // wall is stale, and reading it again is what shows why.
      await qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      if (status === 409) return "taken";
      // The note is about to go, and focus with it. The heading stays, and
      // the reader keeps their place on the wall.
      say(`${nameOf(k.fromUserId)} withdrew this thank-you.`);
      headingRef.current?.focus({ preventScroll: true });
      return "gone";
    }
  }

  const answerOf = (k: Kudo) => (
    <KudoAnswer
      answer={k.answer}
      by={who(k.toUserId, "You")}
      thanker={nameOf(k.fromUserId)}
      about={k.text}
      mine={k.toUserId === meId}
      onAnswer={(t) => answerKudo(k, t)}
      onWithdraw={() => answerKudo(k, null)}
    />
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
      ) : all.length === 0 && !shown ? (
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
                  // Always focusable, not only once put away here: a letter
                  // read in another tab never runs through putAway, and the
                  // move that sets it down still needs somewhere real to send
                  // focus. -1 keeps it out of the tab order either way.
                  tabIndex={-1}
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
                    foot={answerOf(k)}
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
                  {/* After the time, so the time reads as the kudo's, not the answer's. */}
                  {answerOf(k)}
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
          // A held key repeats long after the lock has lapsed; only the
          // first keydown of a press may put a letter away.
          onKeyDown={(e) => e.repeat && e.preventDefault()}
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
  foot,
  className = "",
}: {
  /** Under the sign-off: the recipient's answer, or their Answer control. */
  foot?: ReactNode;
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
      {foot}
    </span>
  );
}

/** Matches MaxAnswerRunes in internal/store/kudos.go and 0045_kudo_answers.sql. */
const MAX_ANSWER_RUNES = 80;

/**
 * A kudo's first few words, to tell two notes from the same person apart in
 * a control's accessible name. Capped in characters too, for an unbroken word.
 */
function openingWords(text: string) {
  const words = text.trim().split(/\s+/);
  let out = words.slice(0, 6).join(" ");
  if (out.length > 40) out = out.slice(0, 40).trimEnd();
  return out.length < text.trim().length ? `${out}…` : out;
}

/** What `onAnswer` and `onWithdraw` settle to. "gone": the kudo itself was
 *  withdrawn, and the caller has already said so and moved focus. "taken": an
 *  answer was already given (another tab, say), and the caller has fetched it. */
export type AnswerResult = boolean | "gone" | "taken";

/**
 * The recipient's one line back, written under the note: "Sam: …". Everyone
 * who sees the kudo sees the answer; only the recipient (`mine`) ever gets a
 * control. With no answer, a witness sees nothing at all — there is no
 * "unanswered" state, and the control never prompts. No edit: withdraw, then
 * answer again.
 */
export function KudoAnswer({
  answer,
  by,
  thanker,
  about,
  mine,
  onAnswer,
  onWithdraw,
}: {
  answer?: string;
  /** The recipient's name as this viewer reads it ("You" for themselves). */
  by: string;
  /** Who is being answered, for the control's accessible name. */
  thanker: string;
  /** The kudo's own words: their opening keeps two notes' controls apart. */
  about: string;
  mine: boolean;
  /** Settles true once saved, false to keep the field open. */
  onAnswer: (text: string) => Promise<AnswerResult>;
  onWithdraw: () => Promise<AnswerResult>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Why Enter did nothing, said where the hint is rather than not at all.
  const [nudge, setNudge] = useState("");
  // Words a 409 turned away: kept on the page rather than silently dropped.
  const [unsent, setUnsent] = useState("");
  // What this viewer just saved, shown until the room's own copy arrives: a
  // refetch that fails, or a socket still reconnecting, must not hold the
  // field. `null` is "nothing pending"; `{ value: undefined }` a withdrawal.
  const [saved, setSaved] = useState<{ value?: string } | null>(null);
  const shown = saved ? saved.value : answer;
  const [focus, setFocus] = useState<"answer" | "line" | "withdraw" | "keep" | null>(null);
  const answerRef = useRef<HTMLButtonElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const withdrawRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set only by this viewer's own send or withdraw, from the control that
  // held focus: the one change focus may follow. Nobody else's answer, and
  // no refetch, ever moves it.
  const owned = useRef(false);
  const counterId = useId();
  const promptId = useId();
  const left = MAX_ANSWER_RUNES - [...text.trim()].length;
  const opening = openingWords(about);

  // Focus follows the control that replaced the one just used, once it exists.
  useEffect(() => {
    const el =
      focus === "answer"
        ? answerRef.current
        : focus === "line"
          ? lineRef.current
          : focus === "withdraw"
            ? withdrawRef.current
            : focus === "keep"
              ? keepRef.current
              : null;
    if (el) {
      el.focus({ preventScroll: true });
      setFocus(null);
    }
  }, [focus, shown, open, confirming]);

  // The answer arriving or leaving — ours, the one a 409 revealed, one given
  // in another tab, or a retry the standup's error row made — settles every
  // local state it could strand: an open field would otherwise reappear
  // pre-filled the next time the answer is withdrawn. Reset during render, so
  // the stale field never reaches the page.
  const [settled, setSettled] = useState(answer);
  if (settled !== answer) {
    setSettled(answer);
    setSaved(null);
    setOpen(false);
    setText("");
    setNudge("");
    setBusy(false);
    setConfirming(false);
    if (!answer) setUnsent("");
  }
  // What this viewer's own send or withdraw unmounted held focus; it is
  // caught here rather than left on the page. Only then: a change that came
  // from anywhere else leaves focus, and the scroll, where they were.
  const lastShown = useRef(shown);
  useLayoutEffect(() => {
    if (lastShown.current === shown) return;
    lastShown.current = shown;
    if (!owned.current) return;
    owned.current = false;
    const el = document.activeElement;
    if (el && el !== document.body) return;
    (shown ? lineRef.current : answerRef.current)?.focus({ preventScroll: true });
  }, [shown]);

  async function send(from: EventTarget) {
    if (busy) return;
    if (!text.trim()) {
      setNudge("Write something first.");
      return;
    }
    if (left < 0) {
      setNudge(`An answer is 80 characters at most.`);
      return;
    }
    const words = text.trim();
    owned.current = from === document.activeElement;
    setBusy(true);
    setUnsent("");
    const ok = await onAnswer(words);
    setBusy(false);
    if (ok === true) {
      // Shown from the write itself: the room's copy replaces it on arrival.
      setSaved({ value: words });
      setOpen(false);
      setText("");
      return;
    }
    if (ok === "taken") {
      // An answer was already given, and is on its way in. These words were
      // never sent: they stay in the field with the reason until it lands,
      // and after that under it, rather than vanish. Focus is still ours to
      // hand to the answer when it arrives.
      setUnsent(words);
      setNudge("You already answered this.");
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    owned.current = false;
    // Gone: the note is going, and the owner has already moved focus.
    if (ok === "gone") return;
    inputRef.current?.focus({ preventScroll: true });
  }

  async function withdraw(from: EventTarget) {
    if (busy) return;
    owned.current = from === document.activeElement;
    setBusy(true);
    const ok = await onWithdraw();
    setBusy(false);
    if (ok === true) {
      setSaved({ value: undefined });
      setConfirming(false);
      setUnsent("");
      return;
    }
    owned.current = false;
  }

  function cancel() {
    if (busy) return;
    owned.current = false;
    setUnsent("");
    setOpen(false);
    setText("");
    setNudge("");
    setFocus("answer");
  }

  function keep() {
    if (busy) return;
    setConfirming(false);
    setFocus("withdraw");
  }

  // A held key auto-repeats, and a repeat is never a second decision.
  const noRepeat = (e: KeyboardEvent) => {
    if (e.repeat) e.preventDefault();
  };

  const unsentNote = unsent && (
    <span data-testid="answer-unsent" className="mt-1 block break-words text-[12px] leading-[1.45] text-ink-soft">
      You already answered this, so these words were not sent: “{unsent}”
    </span>
  );

  if (shown) {
    return (
      <span className="mt-1.5 block">
        {/* Focusable so a send can hand focus to what it made, rather than to
            the control that would take it straight back. */}
        <span
          ref={lineRef}
          tabIndex={-1}
          data-testid="kudo-answer"
          className="block min-w-0 break-words text-[13px] leading-[1.45] text-ink-soft"
        >
          <span className="sr-only">{by} replied: </span>
          <span aria-hidden="true" className="font-semibold text-ink">
            {by}:
          </span>{" "}
          {shown}
        </span>
        {mine && unsentNote}
        {mine &&
          (confirming ? (
            // Esc answers "Keep it", as it would in any other dialog.
            <span
              className="-mb-2 -ml-2 flex flex-wrap items-center"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                keep();
              }}
            >
              <span id={promptId} aria-live="polite" className="w-full px-2 pt-1 text-[13px] text-ink-soft">
                {busy ? "Withdrawing…" : "Withdraw your answer?"}
              </span>
              <button
                ref={keepRef}
                type="button"
                className={quietAction}
                aria-describedby={promptId}
                aria-disabled={busy || undefined}
                onKeyDown={noRepeat}
                onClick={keep}
              >
                Keep it
              </button>
              <button
                type="button"
                className={quietAction}
                aria-describedby={promptId}
                aria-disabled={busy || undefined}
                onKeyDown={noRepeat}
                onClick={(e) => void withdraw(e.currentTarget)}
              >
                Withdraw it
              </button>
            </span>
          ) : (
            /* Nothing undoes a withdrawal and an answer cannot be edited, so
               the first press only asks — as the kudo's own Withdraw does. */
            <button
              ref={withdrawRef}
              type="button"
              className={`${quietAction} -mb-2 -ml-2`}
              aria-label={`Withdraw answer to ${thanker}: ${opening}`}
              onKeyDown={noRepeat}
              onClick={() => {
                setConfirming(true);
                setFocus("keep");
              }}
            >
              Withdraw answer
            </button>
          ))}
      </span>
    );
  }
  if (!mine) return null;
  if (!open) {
    return (
      <>
        <button
          ref={answerRef}
          type="button"
          className={`${quietAction} -mb-2 -ml-2 mt-0.5`}
          aria-label={`Answer ${thanker}: ${opening}`}
          onKeyDown={noRepeat}
          onClick={() => {
            setUnsent("");
            setOpen(true);
          }}
        >
          Answer
        </button>
        {unsentNote}
      </>
    );
  }
  return (
    <span className="mt-2 block">
      <input
        ref={inputRef}
        // Opened by a press on Answer, so taking focus is expected.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        // Dimmed while it sends, so it does not look open to more typing.
        className={`${inputClass} w-full py-1.5 text-[13px] ${busy ? "cursor-default opacity-60" : ""}`}
        aria-label={`Your answer to ${thanker}`}
        aria-describedby={left <= 20 ? counterId : undefined}
        aria-invalid={left < 0 || undefined}
        // Read-only, not disabled, while it sends: a disabled field throws
        // focus to the page, and a keyboard user loses their place.
        readOnly={busy}
        aria-disabled={busy || undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNudge("");
        }}
        onKeyDown={(e) => {
          // Mid-composition, Enter picks the input method's candidate; it
          // is not the person saying they are done. 229 is Safari's tell.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            if (!e.repeat) void send(e.currentTarget);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
      />
      <span className="flex items-center justify-between gap-2 text-[12px] text-ink-soft">
        <span data-testid="answer-hint" aria-live="polite" className={nudge && !busy ? "text-stop" : ""}>
          {busy ? "Sending…" : nudge || "Enter to send"}
        </span>
        <span className="flex items-center gap-2">
          {left <= 20 && (
            <span id={counterId} data-testid="answer-left" className={left < 0 ? "text-stop" : ""}>
              {left < 0 ? (
                <>
                  <span className="font-mono tabular-nums">{-left}</span> over
                </>
              ) : (
                <>
                  <span className="font-mono tabular-nums">{left}</span> left
                </>
              )}
            </span>
          )}
          {/* Esc is not on a phone's keyboard. */}
          <button
            type="button"
            className={`${quietAction} -mr-2 text-[12px]`}
            aria-disabled={busy || undefined}
            onClick={cancel}
          >
            Cancel
          </button>
        </span>
      </span>
    </span>
  );
}

/**
 * The answer's controls: quiet text rather than a pill, so an unanswered note
 * never reads as an item on a list to clear. The hit area is still 44px.
 */
const quietAction = `${TOUCH_HIT} inline-flex items-center px-2 text-[13px] text-ink-soft underline-offset-2 hover:text-ink hover:underline aria-disabled:opacity-60`;

/** A small pill inside a full-size hit area: the target is 44px, the face is not. */
const smallPill = `${TOUCH_HIT} pill-hit inline-flex items-center justify-center px-2 disabled:opacity-50`;
const smallPillFace =
  "pill-face rounded-full border border-line-strong px-3 py-1 text-[12px] font-bold text-ink-soft hover:bg-felt-deep";
