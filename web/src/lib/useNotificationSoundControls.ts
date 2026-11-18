import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Me } from "./api";
import { errorText } from "./api";
import { notificationAudio } from "./notificationAudio";
import { saveNotificationSounds } from "./notificationSettings";
import { useToast } from "./ui";

export function useNotificationSoundControls(
  me: Me | null,
  onBlockedChange: (blocked: boolean) => void,
) {
  const qc = useQueryClient();
  const say = useToast();
  const [saving, setSaving] = useState(false);
  const audioRequest = useRef(0);
  const enabled = me?.notificationSounds ?? false;

  async function toggle() {
    if (saving) return;
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

  return { enabled, saving, toggle, recover };
}
