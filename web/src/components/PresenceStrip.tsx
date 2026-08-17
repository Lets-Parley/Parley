import type { Person } from "../lib/api";
import { Avatar } from "./Avatar";

export function PresenceStrip({
  participants,
  presence,
  votedUserIds,
  facilitatorId,
}: {
  participants: Person[];
  presence: string[];
  votedUserIds: string[];
  facilitatorId: string;
}) {
  const online = new Set(presence);
  const voted = new Set(votedUserIds);
  const voters = participants.filter((p) => online.has(p.userId) && !p.spectator);
  const spectators = participants.filter((p) => online.has(p.userId) && p.spectator);

  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      {voters.map((p) => (
        <span key={p.userId} className="flex flex-col items-center gap-1">
          <Avatar
            name={p.name}
            hue={p.avatarHue}
            facilitator={p.userId === facilitatorId}
          />
          <span
            className={
              "block h-3 w-2.5 rounded-[2px] transition-colors " +
              (voted.has(p.userId) ? "bg-card-back shadow-rest" : "border border-dashed border-line")
            }
            title={voted.has(p.userId) ? `${p.name} has voted` : `${p.name} is thinking`}
          />
        </span>
      ))}
      {spectators.length > 0 && (
        <span className="ml-2 flex items-center gap-1 border-l border-line pl-3 opacity-70">
          {spectators.map((p) => (
            <Avatar key={p.userId} name={p.name} hue={p.avatarHue} size="sm" spectator />
          ))}
        </span>
      )}
      <span className="ml-2 whitespace-nowrap font-mono text-sm text-ink-soft">
        {votedUserIds.filter((id) => online.has(id)).length} of {voters.length} voted
      </span>
    </div>
  );
}
