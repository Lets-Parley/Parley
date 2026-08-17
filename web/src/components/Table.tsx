import type { Person } from "../lib/api";
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

  if (state === "back") {
    return (
      <span
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
        className="flex h-[70px] w-[50px] items-center justify-center rounded-chip border border-line bg-surface font-mono text-2xl shadow-rest"
        style={{ animation: flip + hop }}
      >
        {value ? faceOf(value) : "—"}
      </span>
    );
  }
  if (state === "away") {
    return (
      <span className="flex h-[70px] w-[50px] items-center justify-center rounded-chip border-2 border-dashed border-line font-mono text-[11px] text-ink-faint">
        zzz
      </span>
    );
  }
  return <span className="h-[70px] w-[50px] rounded-chip border-2 border-dashed border-line" />;
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
}) {
  const voted = new Set(votedUserIds);
  const hasVoted = (p: Person) => voted.has(p.userId) || votes.has(p.userId);
  const votedCount = seated.filter(hasVoted).length;
  // Away seats show "zzz" and cannot vote, so counting them in the denominator
  // means "N of N" never arrives while someone is disconnected. Anyone who
  // already voted still counts, even if they dropped afterwards.
  const canVote = seated.filter((p) => online.has(p.userId) || hasVoted(p)).length;

  return (
    <div className="overflow-x-auto pt-3.5">
      <div className="mx-auto flex w-max items-start gap-3 px-2">
        {seated.map((p, i) => {
          const away = !online.has(p.userId);
          const hasVote = voted.has(p.userId) || votes.has(p.userId);
          const state = revealed ? "face" : hasVote ? "back" : away ? "away" : "empty";
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

        {spectators.length > 0 && (
          <>
            <div className="mx-1 w-px self-stretch bg-line" />
            <div className="flex flex-col gap-2 pt-1 opacity-70">
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
          </>
        )}
      </div>

      <p className="mt-1.5 text-center font-mono text-[11px] text-ink-faint">
        {revealed
          ? `${votedCount} ${votedCount === 1 ? "vote" : "votes"} on the table`
          : `${votedCount} of ${canVote} voted`}
      </p>
    </div>
  );
}
