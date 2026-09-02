import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Person } from "../lib/api";
import { cueVar, type CueState } from "../lib/cue";
import { safeDisplayName } from "../lib/displayName";
import { TOUCH_HIT } from "../lib/breakpoints";
import { voteTally } from "../lib/derive";
import {
  BOOT_PX,
  EMOJI_RADIUS,
  FLIP_MS,
  flipDeltas,
  measureKick,
  measurePileOn,
  measureSeats,
  planDropIn,
  planKick,
  pileOnOutlier,
  planPileOn,
  playKick,
  playPileOn,
  releaseFlip,
  revealSettledAt,
  flipStartsAt,
  hopStartsAt,
  CARD_HOP_MS,
  staggerFor,
  type Box,
} from "../lib/motion";
import { useRosterDelta } from "../lib/rosterDelta";
import type { ConnectionStatus } from "../lib/socket";
import { Avatar } from "./Avatar";

const ROTATIONS = [-2, 3, -1, 2, -3, 1, 2];

export function faceOf(value: string): string {
  return value === "coffee" ? "☕" : value;
}

/** The card a seat is showing right now. */
function SeatCard({
  state,
  value,
  index,
  consensus,
}: {
  state: "back" | "face" | "empty" | "away";
  value?: string;
  index: number;
  consensus: boolean;
}) {
  const rot = ROTATIONS[index % ROTATIONS.length];
  // The card's own text equivalent. The seat's name lives on the Avatar, so
  // this says only what the card says — never the person's name a second time.
  const label =
    state === "back"
      ? "voted"
      : state === "face"
        ? value
          ? `voted ${value}`
          : "no card"
        : state === "away"
          ? "away"
          : "no card yet";

  if (state === "back") {
    return (
      <span
        role="img"
        aria-label={label}
        className="flex h-[70px] w-[50px] items-center justify-center rounded-chip bg-card-back shadow-rest"
        /* deal-in composes the resting angle into every stop. modal-drop used
           to run here, and because it animates `transform` it overrode the
           inline rotate() for its whole 250ms and then released — so every
           card visibly kicked into its angle at the moment it landed. */
        style={
          { "--rot": `${rot}deg`, animation: "deal-in 260ms linear both" } as CSSProperties
        }
      >
        <span className="h-3 w-3 rotate-45 border-2 border-pip opacity-55" />
      </span>
    );
  }
  if (state === "face") {
    // Both keyframes carry rotate(var(--rot)) in every stop, and the card keeps
    // the same angle it was dealt at: a card that turns over square, or that
    // loses its angle again when it bounces, reads as a shutter rather than as
    // an object. Timings come from the beat sheet in lib/motion/plan.ts — the
    // literals that used to live here had drifted out of step with it.
    const flip = `flip-in var(--dur-flip) linear ${flipStartsAt(index)}ms both`;
    const hop = consensus
      ? `, card-hop ${CARD_HOP_MS}ms linear ${hopStartsAt(index)}ms`
      : "";
    return (
      <span
        role="img"
        aria-label={label}
        className="flex h-[70px] w-[50px] items-center justify-center rounded-chip border border-line bg-surface font-mono text-2xl shadow-rest"
        style={{ "--rot": `${rot}deg`, animation: flip + hop } as CSSProperties}
      >
        {value ? faceOf(value) : "—"}
      </span>
    );
  }
  if (state === "away") {
    return (
      <span
        role="img"
        aria-label={label}
        className="flex h-[70px] w-[50px] items-center justify-center rounded-chip border-2 border-dashed border-line font-mono text-[11px] text-ink-faint"
      >
        zzz
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      className="h-[70px] w-[50px] rounded-chip border-2 border-dashed border-line"
    />
  );
}

const CELEBRATION_MS = 820;
/** Where in the jump the two hands actually meet, as a fraction of its run. */
const IMPACT = 0.48;
const BITS = 14;
const CONFETTI_COLORS = ["#ffd54a", "#ff7ab8", "#6fe3c4", "#8ab6ff", "#fff1b8"];

/**
 * Deterministic stand-in for Math.random, keyed by (pair, particle, axis).
 *
 * Not for the aesthetics — for stability. This app re-renders the table on
 * every websocket frame (a presence blip, a late vote, a cue change), and a
 * fresh random per render would rewrite each particle's animation string and
 * restart all of them mid-flight.
 */
function scatter(pair: number, k: number, axis: number): number {
  const x = Math.sin(pair * 127.1 + k * 311.7 + axis * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * When the celebration may start, and how far apart the pairs fire.
 *
 * The start waits out the slowest card: flip-in is staggered by index, and
 * card-hop runs 450ms from 620 + index*40. Starting on a fixed delay meant
 * the first pair jumped while the last cards were still turning over.
 */
export function celebrationBeats(seatCount: number, groupCount: number) {
  // Both budgets live in lib/motion so the high-five and the pile-on cannot
  // drift apart — two copies would disagree, and then one animation starts
  // underneath the other.
  return { start: revealSettledAt(seatCount), stagger: staggerFor(groupCount) };
}

type Celebration = { animation?: string; burst: boolean; beat: number; pair: number };

/**
 * Pairs seats off for the high-five, one pass per rendered rank.
 *
 * Pairing on index alone breaks the moment the seats wrap: an odd-length rank
 * hands its last seat a partner on the row below, and the two lean at each
 * other across the whole table. `rows` carries each seat's measured rank, so
 * pairing happens inside a rank. A rank's odd seat out trails onto its rank's
 * last pair and jumps solo on that pair's own beat, rather than getting a
 * later beat of its own — the only rank that gets its own beat for a solo is
 * one with just a single seat, which has no pair to trail.
 */
export function planCelebration(rows: number[], celebrate: boolean): Celebration[] {
  const plan: Celebration[] = rows.map(() => ({ burst: false, beat: 0, pair: 0 }));
  if (!celebrate) return plan;
  const groups: number[][] = [];
  for (const rank of new Set(rows)) {
    const inRank = rows.map((r, i) => (r === rank ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < inRank.length; i += 2) {
      const slice = inRank.slice(i, i + 2);
      // The leftover seat of an odd rank rides along on the rank's last
      // pair instead of starting a group of its own — it doesn't get a beat
      // (or a slot in groupCount's stagger budget) that the pair beside it
      // doesn't already have.
      if (slice.length === 1 && i > 0) groups[groups.length - 1].push(...slice);
      else groups.push(slice);
    }
  }
  const { start, stagger } = celebrationBeats(rows.length, groups.length);
  groups.forEach((group, g) => {
    const beat = start + g * stagger;
    group.forEach((seat, side) => {
      const lone = group.length === 1;
      const name = lone || side === 2 ? "solo" : side === 0 ? "right" : "left";
      plan[seat] = {
        animation: `highfive-${name} ${CELEBRATION_MS}ms linear ${beat}ms both`,
        // One burst per pair, owned by the right seat and thrown into the gap.
        burst: side === 0 && group.length > 1,
        beat,
        pair: g,
      };
    });
  });
  return plan;
}

/** The impact flash and its confetti, anchored between a pair's two seats. */
function Burst({ pair, beat }: { pair: number; beat: number }) {
  const at = beat + CELEBRATION_MS * IMPACT;
  return (
    <span
      aria-hidden
      data-testid="highfive-burst"
      className="pointer-events-none absolute left-[calc(100%+6px)] top-[23px] z-[3] h-0 w-0"
    >
      {/* Pulled 34ms early so the flash is at its brightest ON the contact
          frame. Peaking after it reads as two separate events. */}
      <span
        className="absolute -left-[17px] -top-[17px] h-[34px] w-[34px] rounded-full opacity-0"
        style={{
          background: "radial-gradient(circle,#fff 0%,#ffe27a 45%,transparent 70%)",
          animation: `highfive-flash 420ms ease-out ${at - 34}ms both`,
        }}
      />
      {Array.from({ length: BITS }, (_, k) => {
        const angle = scatter(pair, k, 1) * 2 * Math.PI;
        const speed = 30 + scatter(pair, k, 2) * 40;
        const spin = (scatter(pair, k, 5) < 0.5 ? -1 : 1) * (200 + scatter(pair, k, 6) * 430);
        return (
          <span
            key={k}
            className="absolute h-[9px] w-[6px] rounded-[1px] opacity-0"
            style={
              {
                background: CONFETTI_COLORS[k % CONFETTI_COLORS.length],
                "--dx": `${Math.round(Math.cos(angle) * speed)}px`,
                "--dy0": `${Math.round(-12 - scatter(pair, k, 3) * 26)}px`,
                "--dy": `${Math.round(42 + scatter(pair, k, 4) * 44)}px`,
                "--spin": `${Math.round(spin)}deg`,
                animation: `highfive-confetti ${Math.round(560 + scatter(pair, k, 7) * 300)}ms linear ${Math.round(at - 24 + scatter(pair, k, 8) * 40)}ms both`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

export function Table({
  seated,
  spectators,
  online,
  votedUserIds,
  votes,
  revealed,
  consensus,
  facilitatorId,
  meId,
  cueState = null,
  status = "live",
  onRemove,
  kicked = null,
}: {
  seated: Person[];
  spectators: Person[];
  online: Set<string>;
  votedUserIds: string[];
  votes: Map<string, string>;
  revealed: boolean;
  consensus: boolean;
  facilitatorId: string;
  meId: string;
  /** Owned and accumulated by PokerRoom. null when the light is cut. */
  cueState?: CueState | null;
  /** The socket's state, and the only thing that tells a rejoin from a blip. */
  status?: ConnectionStatus;
  /**
   * Offered only to a facilitator in a live room. Its presence is the whole
   * permission check on this side — the seat never decides for itself.
   */
  onRemove?: (person: Person) => void;
  /**
   * Somebody was removed from the room, as its own event.
   *
   * It cannot be inferred from the envelope. `participants` is the SPACE's
   * roster, not the session's, so a removed person is still in it and simply
   * stops being present — which is exactly what closing a laptop looks like.
   * Booting every seat that goes quiet would boot half the room; hence a
   * frame that says a removal happened, and a sequence number so a second
   * removal of the same person is a second event.
   */
  kicked?: { userId: string; seq: number } | null;
}) {
  const { joined } = useRosterDelta([...online], status, meId);

  // Who the kick has already carried off. Held here because nothing upstream
  // can: `seated` still contains them, and will until they are removed from
  // the space itself. Cleared when their presence comes back — a rejoin gets
  // its seat, and its drop-in, like anybody else arriving.
  //
  // The roster delta's `left` is deliberately NOT the trigger: it fires for
  // every dropped connection in the room, and a boot per closed laptop is not
  // the feature. Only the `kicked` event says a removal happened.
  //
  // Pruned against presence rather than against the join delta: the delta
  // holds its last value for as long as nothing changes, so a seat kicked in
  // the same breath as somebody else's arrival was un-departed by a "join"
  // that had already happened and put straight back in the row. Observed in a
  // browser, not theorised. Each entry therefore waits until it has actually
  // been seen absent before a return can clear it, which also survives the
  // envelope that still lists the victim as present arriving after the kick.
  const [departed, setDeparted] = useState<{ id: string; absent: boolean }[]>([]);
  const kept = departed
    .map((d) => (d.absent || online.has(d.id) ? d : { ...d, absent: true }))
    .filter((d) => !(d.absent && online.has(d.id)));
  if (kept.length !== departed.length || kept.some((d, i) => d !== departed[i])) setDeparted(kept);
  // The seat being launched: still in the row, holding its gap open, but not
  // drawn — its clone is the thing in flight.
  const [flying, setFlying] = useState<string | null>(null);
  const onTable =
    kept.length > 0 ? seated.filter((p) => !kept.some((d) => d.id === p.userId)) : seated;

  const { votedCount, canVote, voted } = voteTally(onTable, online, votedUserIds, votes);

  // Which rendered rank each seat landed in. Measured rather than derived:
  // how many seats fit a rank depends on the viewport and on whether the
  // StoryQueue aside is sharing the row, which no arithmetic here can know.
  // Reduced motion cancels every animation globally in tokens.css, so the
  // whole celebration — the particle nodes included — is skipped outright.
  const ranksRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<number[]>([]);
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const celebrate = consensus && revealed && rows.length === onTable.length && !reduced;

  // Near-unanimity is the moment a room most wants a reaction and the one the
  // table used to answer with silence. Consensus and near-consensus are
  // mutually exclusive, so this is its own trigger rather than a reuse.
  const pileOnRef = useRef<HTMLDivElement>(null);
  const outlier = revealed
    ? pileOnOutlier(
        onTable.flatMap((p) => {
          const value = votes.get(p.userId);
          return value === undefined ? [] : [{ userId: p.userId, value }];
        }),
      )
    : null;

  useEffect(() => {
    const layer = pileOnRef.current;
    if (!layer || !outlier || reduced) return;
    const target = layer.parentElement?.querySelector(
      `[data-seat-user="${CSS.escape(outlier)}"] [data-avatar]`,
    );
    if (!target) return;
    const throwers = Array.from(
      layer.parentElement?.querySelectorAll("[data-seat-user] [data-avatar]") ?? [],
    ).filter((el) => el !== target);
    const geometry = measurePileOn({ layer, throwers, target, emojiRadius: EMOJI_RADIUS });
    if (!geometry) return;
    return playPileOn(layer, planPileOn(geometry));
  }, [outlier, reduced, onTable.length]);

  // The kick. Everything is solved before a node exists, and the row is gated
  // on the launch's exit rather than on the contact: at contact the seat is
  // only hidden, so its gap is held open under the thing the eye is following.
  // Its own overlay, never the pile-on's — either teardown empties the layer
  // it owns, and one shared layer would strand whichever animation was second.
  const kickRef = useRef<HTMLDivElement>(null);
  const kickSeq = kicked?.seq ?? 0;
  const victim = kicked?.userId ?? null;
  useEffect(() => {
    const layer = kickRef.current;
    if (!layer || !victim) return;
    // A removal nobody can animate is still a removal.
    const close = () =>
      setDeparted((d) => (d.some((x) => x.id === victim) ? d : [...d, { id: victim, absent: false }]));
    const seat = layer.parentElement?.querySelector<HTMLElement>(
      `[data-seat-user="${CSS.escape(victim)}"]`,
    );
    const avatar = seat?.querySelector("[data-avatar]");
    if (reduced || !seat || !avatar) {
      close();
      return;
    }
    const plan = planKick(measureKick({ layer, seat, avatar, bootPx: BOOT_PX }));
    // Null where there is no arc to swing through. The glyph is never created,
    // so there is nothing left standing on the felt.
    if (!plan) {
      close();
      return;
    }
    return playKick(layer, plan, seat, {
      onContact: () => setFlying(victim),
      onExit: () => {
        setFlying(null);
        close();
      },
    });
    // Keyed on the sequence number: the same person removed twice is two kicks.
  }, [kickSeq, victim, reduced]);

  useLayoutEffect(() => {
    const el = ranksRef.current;
    if (!el) return;
    // A single measurement, before paint: the celebration is a one-shot, so a
    // resize mid-jump is not worth a ResizeObserver that outlives it.
    const tops = Array.from(el.children, (c) => (c as HTMLElement).offsetTop);
    const order = [...new Set(tops)].sort((x, y) => x - y);
    setRows(tops.map((t) => order.indexOf(t)));
  }, [onTable.length, revealed]);

  const plan = planCelebration(rows, celebrate);

  // Held in a ref rather than state: the animation string has to survive every
  // later websocket frame untouched, or React rewrites it and restarts the
  // fall halfway down. Nothing schedules a timer to clean these up — a
  // finished CSS animation costs nothing, and the map is bounded by the roster.
  const dropsRef = useRef(new Map<string, CSSProperties>());
  if (!reduced && joined.length > 0) {
    for (const d of planDropIn({ joined, seatCount: onTable.length, revealed })) {
      dropsRef.current.set(d.userId, {
        "--drop-d": `${d.distancePx}px`,
        animation: `seat-drop ${Math.round(d.durationMs)}ms linear ${Math.round(d.delayMs)}ms both`,
      } as CSSProperties);
    }
  }
  for (const id of dropsRef.current.keys()) {
    if (!onTable.some((p) => p.userId === id)) dropsRef.current.delete(id);
  }

  // FLIP, every render: the row has already re-laid-out by the time this runs,
  // so the seats that moved are pushed back to where they were and released.
  // A joiner is absent from the previous map and so is left to its own drop.
  const seatBoxes = useRef<Map<string, Box>>(new Map());
  useLayoutEffect(() => {
    const el = ranksRef.current;
    if (!el) return;
    const last = measureSeats(el);
    if (!reduced) releaseFlip(el, flipDeltas(seatBoxes.current, last), FLIP_MS);
    seatBoxes.current = last;
  });

  // Background-colour only, and never a transform or filter: this div is an
  // ancestor of the per-seat `perspective: 600px` containers, and either one
  // would flatten the flip's 3D context.
  const field = cueState ? `var(${cueVar(cueState)})` : "var(--color-felt-deep)";
  const count = revealed
    ? `${votedCount} ${votedCount === 1 ? "vote" : "votes"} on the table`
    : `${votedCount} of ${canVote} voted`;

  return (
    <div className="pt-3.5">
      <div
        data-testid="table-field"
        data-cue={cueState ?? "off"}
        className="relative rounded-panel px-2 py-4"
        style={{
          background: field,
          // Killed outright by tokens.css's prefers-reduced-motion rule. There
          // is no JS interpolation to stop, which is the point.
          transition: "background-color var(--dur-flip) var(--ease-settle)",
        }}
      >
        {!revealed && (
          // The projected-screen question is "are we waiting on anyone?", and
          // it used to be answered in 11px under the field. The numerals are
          // tabular so the row does not shimmer as votes land. aria-hidden:
          // the live region below is the single voice for this.
          <p
            data-testid="waiting-count"
            aria-hidden="true"
            className="mb-3 text-center font-mono text-[1.5rem] font-semibold tabular-nums text-ink-soft"
          >
            {votedCount}
            <span className="text-ink-faint"> / {canVote}</span>
            <span className="ml-2 align-middle text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              voted
            </span>
          </p>
        )}

        {/* Ranks, not a scroller. A seat is 74px plus a 12px gap — 86px —
            measured in Chrome at 876a033, not calculated. 15 seats never fit
            one rank: 1280 wraps 10/5 into a 869px row, the widest measured
            anywhere. 1024 is the odd one and takes THREE ranks (7/7/1),
            because `lg` is where the StoryQueue aside joins the row while 768
            still stacks it below — so 1024's row measures 613px, 68px
            NARROWER than 768's 681px, and the count goes up as the viewport
            does. On a phone it is 3-4 seats a rank depending on whether the
            platform reserves space for a scrollbar; not measured on a real
            mobile viewport. Centred: wrapped ranks that centre read as a
            table, left-aligned they read as a roster. */}
        <div
          ref={ranksRef}
          data-testid="seat-ranks"
          className="mx-auto flex flex-wrap items-start justify-center gap-x-3 gap-y-9"
        >
          {onTable.map((p, i) => {
            const away = !online.has(p.userId);
            // After the reveal an away seat used to become a blank "face" card,
            // making "left the meeting" and "never voted" the same object.
            // Absence stays drawn as absence.
            const state = revealed
              ? // A present seat that never voted still turns an empty card
                // over; an away one has nothing to turn. Without the second
                // branch "left the meeting" and "abstained" became the same
                // object at the moment the table is read.
                !votes.has(p.userId) && away
                ? "away"
                : "face"
              : voted.has(p.userId)
                ? "back"
                : away
                  ? "away"
                  : "empty";
            const five = plan[i] ?? { burst: false, beat: 0, pair: 0 };
            return (
              <div
                key={p.userId}
                data-seat-user={p.userId}
                className="group/seat relative flex w-[74px] shrink-0 flex-col items-center gap-2.5"
                style={
                  p.userId === flying
                    ? { ...dropsRef.current.get(p.userId), visibility: "hidden" }
                    : dropsRef.current.get(p.userId)
                }
              >
                {onRemove && p.userId !== meId && (
                  // The control, not the decision: it is rendered only where
                  // PokerRoom passes a handler, and the server checks the role
                  // again on the way in.
                  <button
                    type="button"
                    aria-label={`Remove ${safeDisplayName(p.name)}`}
                    onClick={() => onRemove(p)}
                    // 44px hit area, 20px visible chrome — a full-size disc
                    // overlapped neighbours on 74px seats.
                    className={`absolute -right-2 -top-2 z-[5] ${TOUCH_HIT} flex items-center justify-center`}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-bold leading-none text-ink-faint opacity-60 shadow-rest transition hover:text-stop hover:opacity-100">
                      <span aria-hidden>×</span>
                    </span>
                  </button>
                )}
                <span className="block" data-avatar style={{ animation: five.animation }}>
                  <Avatar
                    name={p.name}
                    hue={p.avatarHue}
                    icon={p.avatarIcon}
                    size="lg"
                    facilitator={p.userId === facilitatorId}
                    dim={away}
                  />
                </span>
                {five.burst && <Burst pair={five.pair} beat={five.beat} />}
                {/* The name truncates inside its own min-w-0 span so the
                    " · you" / " · guest" tells sit outside the truncating
                    element and can never be the part an ellipsis eats — the
                    guest tell in particular is a defence, not a decoration. */}
                <div className="flex max-w-full items-baseline gap-0.5 text-xs font-bold text-ink-soft">
                  <span className="min-w-0 truncate">
                    {safeDisplayName(p.name).split(/\s+/)[0]}
                  </span>
                  {p.userId === meId && (
                    <span className="shrink-0 whitespace-nowrap font-normal text-ink-faint"> · you</span>
                  )}
                  {/* Any name is available to a link guest, so the seat says
                      where it came from rather than trusting the name. */}
                  {p.guest && (
                    <span className="shrink-0 whitespace-nowrap font-normal text-ink-faint"> · guest</span>
                  )}
                </div>
                <div className="flex h-[74px] items-start" style={{ perspective: "600px" }}>
                  <SeatCard
                    state={state}
                    value={votes.get(p.userId)}
                    index={i}
                    consensus={consensus}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {spectators.length > 0 && (
          // Once seats wrap, an inline hairline divider has nothing to divide —
          // spectators become their own labelled row below the ranks.
          // No group opacity here: it multiplied through to the text and
          // dropped the heading to 2.8:1.
          <div
            data-testid="spectator-rail"
            className="mx-auto mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-line pt-3"
          >
            <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-faint">
              spectators
            </div>
            {spectators.map((p) => (
              <div key={p.userId} className="flex items-center gap-2">
                <Avatar
                  name={p.name}
                  hue={p.avatarHue}
                  icon={p.avatarIcon}
                  size="sm"
                  spectator
                />
                <span className="text-xs font-semibold text-ink-soft">
                  {safeDisplayName(p.name)}
                  {p.userId === meId && " (you)"}
                  {p.guest && <span className="font-normal text-ink-faint"> · guest</span>}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* The thrown emoji live here rather than inside a seat: a seat is
            `overflow: visible` but it also wraps, and an arc anchored in one
            would be re-laid-out mid-flight. aria-hidden — the reveal and its
            statistics already say everything this decorates. */}
        <div
          ref={pileOnRef}
          aria-hidden
          data-testid="pileon-layer"
          className="pointer-events-none absolute inset-0 z-[4] overflow-visible"
        />

        {/* The boot and the seat it launches. Its own layer, above the throws:
            a kick landing mid-pile-on empties this one when it is done and
            leaves the other's emoji in flight. */}
        <div
          ref={kickRef}
          aria-hidden
          data-testid="kick-layer"
          className="pointer-events-none absolute inset-0 z-[6] overflow-visible"
        />
      </div>

      {/* One live region for the whole table. The cue itself has no words: it
          is a wash of colour over the field, and its steps are internal
          codenames that meant nothing to anyone reading them. The count is the
          plain-language form of the same fact, so it is the only voice here. */}
      <p role="status" className="mt-1.5 text-center font-mono text-[11px] text-ink-faint">
        {/* Pre-reveal the count is already on the field at 1.5rem, so it is
            spoken here and drawn there — never printed twice. */}
        <span className={revealed ? undefined : "sr-only"}>{count}</span>
      </p>
    </div>
  );
}
