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
        {enabled ? "Sounds on" : "Sounds off"}
      </button>
      {enabled && blocked && (
        <button type="button" className={buttonQuiet} onClick={() => void recover()}>
          Enable audio in this tab
        </button>
      )}
    </>
  );
}
