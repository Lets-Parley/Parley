import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Me } from "../lib/api";
import { useToast } from "../lib/ui";
import { Avatar } from "./Avatar";
import { avatarIconIds, avatarIconLabels } from "./avatarIcons";
import { buttonPrimary, buttonQuiet, ErrorRow, inputClass, labelClass, Modal } from "./Modal";
import { useAuthMode, clearSessionMemory } from "./NameGate";

/**
 * Everything about you that this server holds: your name and the mark on your
 * chip.
 *
 * Which controls appear follows the auth mode, and between them they always
 * come to exactly one. In open mode the identity is a name in a cookie, so the
 * name is yours to change and there is no meaningful session to end. Under an
 * identity provider the name comes from the provider — the server refuses to
 * change it — and signing out is the thing that does mean something. The
 * avatar is yours either way: choosing a mark is not choosing a name.
 *
 * The picker is one native radio group, not a grid of aria-pressed buttons:
 * roving tabindex, arrow keys, the single tab stop and the selected-state
 * announcement all come from the platform, and the fieldset legend names the
 * group once. A bounded single-select set is what a radio group is for.
 *
 * The write is an explicit Save rather than a commit on close, so a failure has
 * somewhere to be said while the dialog is still on screen: the strip above the
 * footer keeps the choices and offers one retry. Nobody else is pushed the
 * change — they see it on their next envelope or reload — but the caller's own
 * queries are invalidated, so every chip on their own screen updates without a
 * reload.
 */
export function ProfileDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const say = useToast();
  const mode = useAuthMode();
  const oidc = mode.data?.mode === "oidc";
  const nameFieldId = useId();
  const [picked, setPicked] = useState(me.avatarIcon ?? "");
  const [name, setName] = useState(me.name);
  /** What the server holds. Save is dimmed while the form still matches it. */
  const [stored, setStored] = useState({ icon: me.avatarIcon ?? "", name: me.name });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const trimmed = name.trim();
  // An empty name is not a change to offer — the server would refuse it, and
  // dimming Save says so before the round trip.
  const dirty = picked !== stored.icon || (!oidc && trimmed !== stored.name && trimmed !== "");

  // Local sign-out: the cookie and its token row go, the identity provider's
  // own session is left alone. Someone on a shared machine must sign out there
  // too, which is why this says "Sign out" and not "Sign out everywhere".
  async function signOut() {
    try {
      await api("DELETE", "/api/me");
    } finally {
      clearSessionMemory();
      window.location.href = "/";
    }
  }

  async function save() {
    setSaving(true);
    try {
      if (picked !== stored.icon) {
        await api("PATCH", "/api/me/avatar", { icon: picked });
      }
      // Last, because it rotates the session cookie: a failure after that
      // point would leave the retry button holding a token the server has
      // already replaced.
      if (!oidc && trimmed !== stored.name) {
        await api("POST", "/api/me", { name: trimmed });
      }
      // Only three keys carry an avatar: me, the space roster and the session
      // envelope. An unfiltered invalidateQueries() would refetch every mounted
      // query in an active room instead, for a change nobody else can see yet.
      // The keys are prefixes — the dialog knows neither slug nor session id.
      await Promise.all(
        [["me"], ["space"], ["session"]].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
      setStored({ icon: picked, name: trimmed });
      setFailed(null);
      say("Profile saved");
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
      // No mark stored yet means this is the first pass, not an edit of one.
      title={stored.icon ? "Your profile" : "Create your avatar"}
      onClose={onClose}
      width="26rem"
    >
      <div className="mt-3 flex flex-col items-center gap-2">
        {/* Previewed against the name being typed, so the initials fallback
            shows what it will actually say. */}
        <Avatar name={trimmed || me.name} hue={me.avatarHue} icon={picked} size="md" />
        <button
          type="button"
          className={buttonQuiet + " px-3 py-1 text-[12px]"}
          onClick={() => setPicked(avatarIconIds[Math.floor(Math.random() * avatarIconIds.length)])}
        >
          Randomize
        </button>
      </div>

      {oidc ? (
        <p className="mt-4 text-[12px] text-ink-soft text-pretty">
          Your name comes from your organisation's sign-in, so it is not
          editable here.
        </p>
      ) : (
        <div className="mt-4">
          <label htmlFor={nameFieldId} className={labelClass + " mt-0"}>
            Display name
          </label>
          <input
            id={nameFieldId}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={64}
          />
        </div>
      )}

      <fieldset className="mt-4 border-0 p-0">
        <legend className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Choose your mark
        </legend>
        <div className="grid grid-cols-5 gap-2">
          {["", ...avatarIconIds].map((id) => (
            <label
              key={id}
              className={
                "relative flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-chip border-2 p-2 text-center text-[11px] font-bold focus-within:outline focus-within:outline-2 focus-within:outline-accent " +
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
                name={trimmed || me.name}
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

      <div className="mt-4 flex items-center gap-3">
        {/* Only where it means something. In open mode the identity is just a
            name in a cookie, and "sign out" would promise more than it does. */}
        {oidc && (
          <button
            type="button"
            className={buttonQuiet + " px-3 py-1.5 text-[12px]"}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {dirty && <span className="text-[12px] text-ink-faint">Not saved yet</span>}
          <button
            type="button"
            className={buttonPrimary}
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
