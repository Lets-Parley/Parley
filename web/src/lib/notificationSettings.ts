import type { QueryClient } from "@tanstack/react-query";
import { api, type Me } from "./api";

const channelName = "parley-notification-settings";
let sender: BroadcastChannel | undefined;

export async function saveNotificationSounds(qc: QueryClient, enabled: boolean) {
  const me = await api<Me>("PATCH", "/api/me/settings", { notificationSounds: enabled });
  qc.setQueryData(["me"], me);
  if ("BroadcastChannel" in globalThis) {
    sender ??= new BroadcastChannel(channelName);
    sender.postMessage("changed");
  }
  return me;
}

export function listenForNotificationChanges(refresh: () => void) {
  if (!("BroadcastChannel" in globalThis)) return () => {};
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = refresh;
  return () => channel.close();
}
