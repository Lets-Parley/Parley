import { useQuery } from "@tanstack/react-query";
import { action, api, type Envelope } from "../lib/api";
import { orgPluginPanelsApi } from "../lib/paths";
import { PluginPanel, type PluginSlot } from "./PluginPanel";
import { type Panel, panelHasSlot } from "./PluginPanels";

/**
 * Plugin UI in host chrome — toolbar, space/org nav, or the export cluster.
 *
 * Same iframe and MessageChannel as a nested panel. The list is the room's
 * when a session envelope is in hand, and the org's nav list otherwise; a
 * plugin that did not declare this slot is not in that list.
 */
export function PluginChrome({
  slot,
  env,
  orgSlug,
  modalOpen = false,
}: {
  slot: Exclude<PluginSlot, "room">;
  env?: Envelope;
  orgSlug?: string;
  modalOpen?: boolean;
}) {
  const sessionId = env?.id;
  const { data } = useQuery({
    queryKey: sessionId ? ["plugin-panels", sessionId] : ["plugin-panels-org", orgSlug],
    queryFn: () =>
      sessionId
        ? api<Panel[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/plugins/panels`)
        : api<Panel[]>("GET", orgPluginPanelsApi(orgSlug ?? "")),
    enabled: Boolean(sessionId || orgSlug),
    staleTime: Infinity,
    retry: false,
  });
  const items = (data ?? []).filter((p) => panelHasSlot(p, slot));
  if (!items.length) return null;
  return (
    <>
      {items.map((p) => (
        <PluginPanel
          key={p.name}
          slot={slot}
          name={p.name}
          version={p.version}
          grants={p.grants}
          env={env}
          modalOpen={modalOpen}
          onAction={
            env
              ? (name, payload) =>
                  action(env.id, name, payload, { "X-Parley-Plugin-Route": p.name })
              : async () => undefined
          }
        />
      ))}
    </>
  );
}
