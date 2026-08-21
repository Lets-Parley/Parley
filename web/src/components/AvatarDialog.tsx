import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Me } from "../lib/api";
import { useToast } from "../lib/ui";
import { Avatar } from "./Avatar";
import { avatarAccessoryIds, avatarAccessoryLabels } from "./avatarAccessories";
import { avatarIconIds, avatarIconLabels } from "./avatarIcons";
import { Modal } from "./Modal";

/**
 * Pick the mark that goes on your chip.
 *
 * Two native radio groups, not a custom grid: roving tabindex, arrow keys and the
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
  const [worn, setWorn] = useState(me.avatarAccessory ?? "");

  async function save() {
    onClose();
    // Nothing chosen that was not already stored: no request, no broadcast.
    if (picked === (me.avatarIcon ?? "") && worn === (me.avatarAccessory ?? "")) return;
    try {
      await api("PATCH", "/api/me/avatar", { icon: picked, accessory: worn });
      // Every screen carries a person somewhere — me, the roster, the session
      // envelope. Refetching the lot is one line and always right.
      await qc.invalidateQueries();
    } catch (e) {
      say(errorText(e));
    }
  }

  return (
    <Modal title="Your avatar" onClose={() => void save()} width="22rem">
      <fieldset className="mt-4 border-0 p-0">
        <legend className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Choose your mark
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {["", ...avatarIconIds].map((id) => (
            <label
              key={id}
              className={
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-chip border p-2 text-center text-[11px] font-bold focus-within:outline focus-within:outline-2 focus-within:outline-accent " +
                (picked === id ? "border-accent bg-felt-deep" : "border-line hover:bg-felt-deep")
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
                accessory={worn}
                size="md"
                decorative
              />
              <span>{id ? avatarIconLabels[id] : "Initials"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-5 border-0 p-0">
        <legend className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Add an accessory
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {["", ...avatarAccessoryIds].map((id) => (
            <label
              key={id}
              className={
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-chip border p-2 text-center text-[11px] font-bold focus-within:outline focus-within:outline-2 focus-within:outline-accent " +
                (worn === id ? "border-accent bg-felt-deep" : "border-line hover:bg-felt-deep")
              }
            >
              <input
                type="radio"
                name="avatar-accessory"
                value={id}
                checked={worn === id}
                onChange={() => setWorn(id)}
                className="sr-only"
              />
              <Avatar
                name={me.name}
                hue={me.avatarHue}
                icon={picked}
                accessory={id}
                size="md"
                decorative
              />
              <span>{id ? avatarAccessoryLabels[id] : "None"}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </Modal>
  );
}
