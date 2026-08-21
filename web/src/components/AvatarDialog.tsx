import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Me } from "../lib/api";
import { useToast } from "../lib/ui";
import { Avatar } from "./Avatar";
import { avatarIconIds, avatarIconLabels } from "./avatarIcons";
import { Modal } from "./Modal";

/**
 * Pick the mark that goes on your chip.
 *
 * One native radio group, not a custom grid: roving tabindex, arrow keys and the
 * selected-state announcement all come from the platform, and the fieldset
 * legend names each group once.
 *
 * The write happens on close, so trying three icons before dismissing costs one
 * request. Nobody else is pushed the change — they see it on their next
 * envelope or reload — but the caller's own queries are invalidated, so every
 * chip on their own screen updates without a reload. A failure is a toast
 * rather than a row inside the dialog: by then the dialog is gone, and the
 * chip they can see is the evidence it did not take.
 */
export function AvatarDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const say = useToast();
  const [picked, setPicked] = useState(me.avatarIcon ?? "");

  async function save() {
    onClose();
    // Nothing chosen that was not already stored: no request, no broadcast.
    if (picked === (me.avatarIcon ?? "")) return;
    try {
      await api("PATCH", "/api/me/avatar", { icon: picked });
      // Only three keys carry an avatar: me, the space roster and the session
      // envelope. An unfiltered invalidateQueries() would refetch every mounted
      // query in an active room instead, for a change nobody else can see yet.
      // The keys are prefixes — the dialog knows neither slug nor session id.
      await Promise.all(
        [["me"], ["space"], ["session"]].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
    } catch (e) {
      say(errorText(e));
    }
  }

  return (
    <Modal title="Your avatar" onClose={() => void save()} width="26rem">
      <fieldset className="mt-4 border-0 p-0">
        <legend className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Choose your mark
        </legend>
        <div className="grid grid-cols-5 gap-2">
          {["", ...avatarIconIds].map((id) => (
            <label
              key={id}
              className={
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-chip border p-2 text-center text-[11px] font-bold focus-within:outline focus-within:outline-2 focus-within:outline-accent " +
                (picked === id
                  ? "border-accent bg-felt-deep"
                  : "border-line hover:bg-felt-deep")
              }
            >
              <input
                type="radio"
                name="avatar-icon"
                value={id}
                checked={picked === id}
                onChange={() => setPicked(id)}
                className="sr-only"
              />
              <Avatar
                name={me.name}
                hue={me.avatarHue}
                icon={id}
                size="md"
                decorative
              />
              <span>{id ? avatarIconLabels[id] : "Initials"}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </Modal>
  );
}
