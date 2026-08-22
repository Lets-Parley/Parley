import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Me } from "../lib/api";
import { useToast } from "../lib/ui";
import { Avatar } from "./Avatar";
import { avatarIconIds, avatarIconLabels } from "./avatarIcons";
import { buttonPrimary, buttonQuiet, ErrorRow, Modal } from "./Modal";

/**
 * Pick the mark that goes on your chip.
 *
 * One native radio group, not a grid of aria-pressed buttons: roving tabindex,
 * arrow keys, the single tab stop and the selected-state announcement all come
 * from the platform, and the fieldset legend names the group once. A bounded
 * single-select set is what a radio group is for.
 *
 * The write is an explicit Save rather than a commit on close, so a failure has
 * somewhere to be said while the picker is still on screen: the strip above the
 * footer keeps the choice and offers one retry. Nobody else is pushed the
 * change — they see it on their next envelope or reload — but the caller's own
 * queries are invalidated, so every chip on their own screen updates without a
 * reload.
 */
export function AvatarDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const say = useToast();
  const [picked, setPicked] = useState(me.avatarIcon ?? "");
  /** What the server holds. Save is dimmed while `picked` still matches it. */
  const [stored, setStored] = useState(me.avatarIcon ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    try {
      await api("PATCH", "/api/me/avatar", { icon: picked });
      // Only three keys carry an avatar: me, the space roster and the session
      // envelope. An unfiltered invalidateQueries() would refetch every mounted
      // query in an active room instead, for a change nobody else can see yet.
      // The keys are prefixes — the dialog knows neither slug nor session id.
      await Promise.all(
        [["me"], ["space"], ["session"]].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
      setStored(picked);
      setFailed(null);
      say("Avatar saved");
    } catch (e) {
      // Nothing is discarded and nothing is re-rendered: the choice stays
      // picked, and the strip below carries the retry.
      setFailed(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      // Nothing stored yet means this is the first pass, not an edit of one.
      title={stored ? "Edit avatar" : "Create your avatar"}
      onClose={onClose}
      width="26rem"
    >
      <div className="mt-3 flex flex-col items-center gap-2">
        <Avatar name={me.name} hue={me.avatarHue} icon={picked} size="md" />
        <button
          type="button"
          className={buttonQuiet + " px-3 py-1 text-[12px]"}
          onClick={() => setPicked(avatarIconIds[Math.floor(Math.random() * avatarIconIds.length)])}
        >
          Randomize
        </button>
      </div>

      <fieldset className="mt-4 border-0 p-0">
        <legend className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Choose your mark
        </legend>
        <div className="grid grid-cols-5 gap-2">
          {["", ...avatarIconIds].map((id) => (
            <label
              key={id}
              className={
                "relative flex cursor-pointer flex-col items-center gap-1.5 rounded-chip border-2 p-2 text-center text-[11px] font-bold focus-within:outline focus-within:outline-2 focus-within:outline-accent " +
                // Never colour alone: the selected card takes the accent
                // border and the corner pip below.
                (picked === id ? "border-accent bg-felt-deep" : "border-line hover:bg-felt-deep") +
                // No portrait is a real choice, and a dashed card says so.
                (id === "" ? " border-dashed" : "")
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
              {picked === id && (
                <span
                  data-pip
                  aria-hidden
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent"
                />
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {failed && (
        <div className="mt-4">
          <ErrorRow
            fail={{ msg: failed, retry: save }}
            onDismiss={() => setFailed(null)}
            onRetry={() => void save()}
          />
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-3">
        {picked !== stored && (
          <span className="text-[12px] text-ink-faint">Not saved yet</span>
        )}
        <button
          type="button"
          className={buttonPrimary}
          disabled={saving || picked === stored}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
