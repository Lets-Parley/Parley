import { useQuery } from "@tanstack/react-query";
import { action, api, type Envelope } from "../lib/api";
import { PluginPanel } from "./PluginPanel";

/** One installed plugin that ships UI, as the room's panel list reports it. */
export type Panel = { name: string; version: string; grants: string[]; slots?: string[] };

/** Whether this install asked to appear in a given piece of chrome. */
export function panelHasSlot(p: Panel, slot: string): boolean {
  return (p.slots ?? ["panel"]).includes(slot);
}

/**
 * Every plugin panel a room should show.
 *
 * The list is fetched once and cached; an instance with no plugins gets an
 * empty array and renders nothing at all, which is what keeps the sandbox off
 * the page for everyone who is not running plugins.
 */
export function PluginPanels({
  env,
  modalOpen = false,
}: {
  env: Envelope;
  /** True while any host modal is open — every frame is marked inert. */
  modalOpen?: boolean;
}) {
  // Keyed by the room, because the list is the room's org's own: the server
  // resolves the tenant from the session rather than from the caller, so a
  // cache shared across rooms would be a cache shared across orgs.
  const { data } = useQuery({
    queryKey: ["plugin-panels", env.id],
    queryFn: () => api<Panel[]>("GET", `/api/sessions/${encodeURIComponent(env.id)}/plugins/panels`),
    staleTime: Infinity,
    retry: false,
  });
  if (!data?.length) return null;
  const nested = data.filter((p) => panelHasSlot(p, "panel"));
  if (!nested.length) return null;
  return (
    <>
      {nested.map((p) => (
        <PluginPanel
          key={p.name}
          name={p.name}
          version={p.version}
          grants={p.grants}
          env={env}
          modalOpen={modalOpen}
          // Host-mediated: the plugin proposes, this performs, with the user's
          // own cookie and against the same route the user's own click would
          // hit. The plugin never receives a credential, and the server
          // re-authorises the call as the user regardless of what the plugin
          // asked for. The header names the plugin as the route so the action
          // is attributable.
          onAction={(name, payload) => action(env.id, name, payload, { "X-Parley-Plugin-Route": p.name })}
        />
      ))}
    </>
  );
}
