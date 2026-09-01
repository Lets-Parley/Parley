import { useEffect, useRef, useState } from "react";
import type { Envelope, Person } from "../lib/api";
import { GRACE_SECONDS, claimState } from "../lib/derive";
import { useCountdown, useToast } from "../lib/ui";
import { safeDisplayName } from "../lib/displayName";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";

/**
 * Say who is driving now, on every screen in the room.
 *
 * There is no facilitator event on the wire — the envelope simply arrives with
 * a different facilitatorId — so the announcement is derived from that change,
 * which means everyone gets it, not only whoever pressed the button. The
 * mounting envelope seeds the ref rather than announcing: opening a room is not
 * a handover.
 */
export function useFacilitatorAnnouncement(
  env: Pick<Envelope, "facilitatorId" | "participants">,
  meId: string,
) {
  const say = useToast();
  const seen = useRef(env.facilitatorId);
  const participants = env.participants;
  useEffect(() => {
    if (seen.current === env.facilitatorId) return;
    seen.current = env.facilitatorId;
    if (env.facilitatorId === meId) {
      say("You're the facilitator now");
      return;
    }
    const who = participants.find((p) => p.userId === env.facilitatorId);
    say(`${safeDisplayName(who?.name ?? "Someone")} is the facilitator now`);
  }, [env.facilitatorId, meId, participants, say]);
}

/**
 * Hand the room over on purpose. One press to open the roster, one press on a
 * name to move the chair — the recipient is in the room already, so there is
 * nothing to accept.
 */
export function FacilitatorHandoff({
  env,
  onTransfer,
}: {
  env: Pick<Envelope, "participants" | "facilitatorId">;
  /** Resolves true when the chair actually moved; the roster closes on true. */
  onTransfer: (person: Person) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  // A link guest has no members row, so the transfer endpoint refuses it
  // (store.ErrNotEligible) — offering the name would only produce a 403 the
  // room cannot act on. The holder is left out too: handing the chair to
  // yourself is not an action.
  const candidates = env.participants.filter(
    (p) => !p.guest && p.userId !== env.facilitatorId,
  );
  return (
    <>
      <button
        className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-accent"
        onClick={() => setOpen(true)}
      >
        Hand off
      </button>
      {open && (
        <Modal title="Hand the room to someone else" onClose={() => setOpen(false)}>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            They take the chair straight away — no waiting, and the room is told who is
            driving.
          </p>
          {candidates.length === 0 ? (
            <p className="mt-4 text-sm text-ink-faint">
              There is nobody else here who can take it yet.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-1.5">
              {candidates.map((p) => (
                <li key={p.userId}>
                  <button
                    className="flex w-full items-center gap-3 rounded-chip border border-line px-3 py-2 text-left text-sm font-bold transition hover:bg-felt-deep"
                    onClick={async () => {
                      if (await onTransfer(p)) setOpen(false);
                    }}
                  >
                    <Avatar name={p.name} hue={p.avatarHue} icon={p.avatarIcon} size="sm" decorative />
                    {safeDisplayName(p.name)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * The stranded-facilitator card: who dropped, how long is left, and the button
 * that becomes live the moment the grace period runs out. Renders nothing while
 * there is a facilitator on the call.
 */
export function FacilitatorClaim({
  env,
  isFacilitator,
  guest,
  onClaim,
}: {
  env: Envelope;
  isFacilitator: boolean;
  /** A guest may never take the chair, so it is never offered. */
  guest: boolean;
  onClaim: () => Promise<boolean>;
}) {
  const { showClaim, graceLeft } = claimState(env, isFacilitator || guest);
  const claimLeft = useCountdown(graceLeft);
  const facilitator = env.participants.find((p) => p.userId === env.facilitatorId);
  if (!showClaim || !facilitator) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-5 py-4 shadow-lift"
      style={{ animation: "modal-drop 300ms var(--ease-settle)" }}
    >
      <span className="relative opacity-60">
        <Avatar
          name={facilitator.name}
          hue={facilitator.avatarHue}
          icon={facilitator.avatarIcon}
          size="md"
        />
        <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-brass ring-2 ring-surface" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-extrabold">
          {safeDisplayName(facilitator.name)} — the facilitator — lost connection
        </p>
        <p className="mt-0.5 text-[13px] text-ink-soft">
          {claimLeft && claimLeft > 0
            ? `If they aren't back in ${claimLeft}s, anyone at the table can take over.`
            : "The grace period is over — anyone can take over now."}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        {claimLeft !== null && claimLeft > 0 && <GraceRing left={claimLeft} total={GRACE_SECONDS} />}
        <button
          // Zero is the moment it becomes claimable, so test for null
          // explicitly — a falsy check disables the button exactly when
          // the grace period has run out.
          disabled={claimLeft === null || claimLeft > 0}
          onClick={onClaim}
          className={
            "rounded-full px-4 py-2.5 text-sm font-bold shadow-rest " +
            (claimLeft === 0
              ? "bg-brass text-accent-ink"
              : "cursor-default bg-felt-deep text-ink-faint")
          }
        >
          {claimLeft === 0
            ? "Claim facilitator"
            : `Claim in 0:${String(claimLeft ?? 0).padStart(2, "0")}`}
        </button>
      </div>
    </div>
  );
}

/** The facilitator grace period, draining. */
function GraceRing({ left, total }: { left: number; total: number }) {
  const circumference = 88;
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <circle cx="17" cy="17" r="14" fill="none" stroke="var(--color-line)" strokeWidth="3" />
      <circle
        cx="17"
        cy="17"
        r="14"
        fill="none"
        stroke="var(--color-brass)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={Math.round(circumference - (left / total) * circumference)}
        transform="rotate(-90 17 17)"
      />
    </svg>
  );
}
