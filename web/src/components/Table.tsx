import type { Person } from "../lib/api";
import { cueLabel, cueVar, type CueState } from "../lib/cue";
import { voteTally } from "../lib/derive";
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
        style={{ transform: `rotate(${rot}deg)`, animation: "modal-drop 250ms var(--ease-spring)" }}
      >
        <span className="h-3 w-3 rotate-45 border-2 border-pip opacity-55" />
      </span>
    );
  }
  if (state === "face") {
    const flip = `flip-in var(--dur-flip) var(--ease-settle) ${index * 70}ms both`;
    const hop = consensus ? `, card-hop 450ms var(--ease-spring) ${620 + index * 40}ms` : "";
    return (
      <span
        role="img"
        aria-label={label}
        className="flex h-[70px] w-[50px] items-center justify-center rounded-chip border border-line bg-surface font-mono text-2xl shadow-rest"
        style={{ animation: flip + hop }}
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
}) {
  const { votedCount, canVote, voted } = voteTally(seated, online, votedUserIds, votes);

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
        className="rounded-panel px-2 py-4"
        style={{
          background: field,
          // Killed outright by tokens.css's prefers-reduced-motion rule. There
          // is no JS interpolation to stop, which is the point.
          transition: "background-color var(--dur-flip) var(--ease-settle)",
        }}
      >
        {/* Ranks, not a scroller. 15 seats need two ranks at every desktop
            width — 74px + a 12px gap is 86px a seat, and the widest row the
            sidebar leaves is 884px. Centred: wrapped ranks that centre read as
            a table, left-aligned they read as a roster. */}
        <div
          data-testid="seat-ranks"
          className="mx-auto flex flex-wrap items-start justify-center gap-3"
        >
          {seated.map((p, i) => {
            const away = !online.has(p.userId);
            const state = revealed ? "face" : voted.has(p.userId) ? "back" : away ? "away" : "empty";
            return (
              <div key={p.userId} className="flex w-[74px] shrink-0 flex-col items-center gap-2.5">
                <Avatar
                  name={p.name}
                  hue={p.avatarHue}
                  size="lg"
                  facilitator={p.userId === facilitatorId}
                  dim={away}
                />
                <div className="max-w-full truncate text-xs font-bold text-ink-soft">
                  {p.name.split(/\s+/)[0]}
                  {p.userId === meId && <span className="font-normal text-ink-faint"> · you</span>}
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
                <Avatar name={p.name} hue={p.avatarHue} size="sm" spectator />
                <span className="text-xs font-semibold text-ink-soft">
                  {p.name}
                  {p.userId === meId && " (you)"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* One live region for the whole table: the count and the cue read as a
          single string, because two status nodes talk over each other. */}
      <p role="status" className="mt-1.5 text-center font-mono text-[11px] text-ink-faint">
        {cueState ? `${count} · ${cueLabel(cueState)}` : count}
      </p>
    </div>
  );
}
