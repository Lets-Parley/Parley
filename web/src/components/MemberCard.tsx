import { useNavigate } from "react-router-dom";
import type { Person } from "../lib/api";
import { Avatar } from "./Avatar";

/**
 * Who is that, and can I go sit with them? Presence comes from the space
 * roster, so the card only ever claims a seat the server actually sees.
 */
export function MemberCard({
  member,
  isYou,
  activeSessionId,
  onClose,
}: {
  member: Person;
  isYou: boolean;
  activeSessionId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const at = member.at;
  // Both undefined must not read as "same session" — a member with no seat is
  // not sitting at the table you happen to be looking at.
  const here = !!at && at.sessionId === activeSessionId;

  const where = isYou
    ? at
      ? `you · ${at.title}`
      : "you"
    : at
      ? here
        ? `at this table now`
        : at.title
      : "not in a session right now";

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center backdrop-blur-[4px]"
      style={{ background: "color-mix(in oklab, var(--color-felt) 60%, transparent)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={member.name}
        onClick={(e) => e.stopPropagation()}
        className="relative w-[300px] rounded-panel border border-line bg-surface p-5 shadow-lift"
        style={{ animation: "modal-drop 240ms var(--ease-settle)" }}
      >
        <div className="flex items-center gap-3">
          <Avatar name={member.name} hue={member.avatarHue} size="md" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold">{member.name}</p>
            <p className="font-mono text-[10px] text-ink-faint">{where}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {at && !here && !isYou ? (
            <button
              className="rounded-chip bg-accent px-3 py-2.5 text-[13px] font-bold text-accent-ink"
              onClick={() => {
                onClose();
                navigate(`/session/${at.sessionId}`);
              }}
            >
              Go to {at.title}
            </button>
          ) : (
            <p className="rounded-chip bg-felt-deep px-3 py-2.5 text-center text-[13px] font-semibold text-ink-faint">
              {isYou ? "That's you" : here ? "Already at this table" : "Nothing to join yet"}
            </p>
          )}
          <p className="text-[11px] text-ink-faint text-pretty">
            {member.spectator
              ? "At the rail this round — watching, no hand."
              : "You can only open sessions in spaces you're a member of."}
          </p>
        </div>

        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3 text-[13px] text-ink-faint hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
