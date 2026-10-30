import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Me } from "../lib/api";
import { errorText } from "../lib/api";
import { notificationAudio } from "../lib/notificationAudio";
import { saveNotificationSounds } from "../lib/notificationSettings";
import { useToast } from "../lib/ui";
import { buttonQuiet } from "./Modal";

export function NotificationSoundButton({
  me,
  blocked,
  onBlockedChange,
}: {
  me: Me;
  blocked: boolean;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const qc = useQueryClient();
  const say = useToast();
  const [saving, setSaving] = useState(false);
  const audioRequest = useRef(0);
  const enabled = me.notificationSounds ?? false;

  async function toggle() {
    const request = ++audioRequest.current;
    const next = !enabled;
    const activation = next ? notificationAudio.activate() : undefined;
    if (!next) {
      notificationAudio.stop();
      onBlockedChange(false);
    }
    setSaving(true);
    qc.setQueryData<Me | null>(["me"], (current) =>
      current ? { ...current, notificationSounds: next } : current,
    );
    try {
      await saveNotificationSounds(qc, next);
      if (next) {
        void activation?.then(async (ready) => {
          if (request !== audioRequest.current) return;
          onBlockedChange(!ready);
          if (ready) await notificationAudio.play("poker-start");
        });
      }
    } catch (error) {
      qc.setQueryData<Me | null>(["me"], (current) =>
        current ? { ...current, notificationSounds: enabled } : current,
      );
      say(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function recover() {
    const ready = await notificationAudio.activate();
    onBlockedChange(!ready);
    if (ready) await notificationAudio.play("poker-start");
  }

  return (
    <>
      <button
        type="button"
        className={buttonQuiet + " shrink-0 px-3 py-1.5 text-[12px]"}
        aria-label={enabled ? "Mute notification sounds" : "Unmute notification sounds"}
        aria-pressed={enabled}
        disabled={saving}
        onClick={() => void toggle()}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="hidden h-4 w-4 md:max-lg:block" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
          {enabled ? <path d="M11 5.5a3.5 3.5 0 0 1 0 5" /> : <path d="m11 6 3 4m0-4-3 4" />}
        </svg>
        <span className="md:max-lg:hidden">{enabled ? "Sounds on" : "Sounds off"}</span>
      </button>
      {enabled && blocked && (
        <button type="button" className={buttonQuiet} onClick={() => void recover()}>
          Enable audio in this tab
        </button>
      )}
    </>
  );
}
