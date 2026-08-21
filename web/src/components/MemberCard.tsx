import { useNavigate } from "react-router-dom";
import type { Person } from "../lib/api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";

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
    <Modal title={member.name} onClose={onClose} width="300px">
      <div className="flex items-center gap-3">
        <Avatar name={member.name} hue={member.avatarHue} icon={member.avatarIcon} size="md" />
        <p className="font-mono text-[10px] text-ink-faint">{where}</p>
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
    </Modal>
  );
}
