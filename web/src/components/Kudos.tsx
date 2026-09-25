import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Kudo, type Person } from "../lib/api";
import { Avatar } from "./Avatar";
import { KudoFlags } from "./KudoFlags";
import { buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";
import { kudosApi } from "../lib/paths";
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
  const rows = useMemo(() => kudos.data?.pages.flat() ?? [], [kudos.data]);
  // A kudo addressed to you is never folded: it is the one you came for.
  const visible = showAll ? rows : rows.filter((k, i) => i < SHOWN || k.toUserId === meId);
  // Whether the fold hides anything: rows past it that are all yours stay
  // shown, and a Show all that reveals nothing is a dead control.
  const folds = rows.some((k, i) => i >= SHOWN && k.toUserId !== meId);
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
      ) : rows.length === 0 ? (
        <p data-testid="kudos-empty" className="mt-3 text-[13px] text-ink-soft text-pretty">
          No kudos yet. The first one is the hardest — say what somebody did and who did it.
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {visible.map((k) => (
              <li
                key={k.id}
                data-testid={`kudo-${k.id}`}
                data-to-me={k.toUserId === meId || undefined}
                className={`flex flex-wrap items-start gap-3 py-3 ${k.toUserId === meId ? toMeRow : ""}`}
              >
                {k.toUserId === meId && <KudoFlags />}
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
                    <span className="font-semibold text-ink">{who(k.toUserId, "you")}</span>
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
            ))}
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

/** A kudo addressed to the viewer: a pip edge and a light wash. The wash is
    kept at 40% so ink-faint still clears AA on it in the dark theme. */
export const toMeRow = "-mx-2 border-l-2 border-pip bg-accent-soft/40 px-2";

/** A small pill inside a full-size hit area: the target is 44px, the face is not. */
const smallPill = `${TOUCH_HIT} inline-flex items-center justify-center px-2 disabled:opacity-50`;
const smallPillFace =
  "rounded-full border border-line-strong px-3 py-1 text-[12px] font-bold text-ink-soft hover:bg-felt-deep";
