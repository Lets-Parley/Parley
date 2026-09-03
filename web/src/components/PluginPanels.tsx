import { useQuery } from "@tanstack/react-query";
import { action, api, type Envelope } from "../lib/api";
import { PluginPanel } from "./PluginPanel";

/** One installed plugin that ships UI, as /api/plugins/panels reports it. */
export type Panel = { name: string; version: string; grants: string[] };

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
  const { data } = useQuery({
    queryKey: ["plugin-panels"],
    queryFn: () => api<Panel[]>("GET", "/api/plugins/panels"),
    staleTime: Infinity,
    retry: false,
  });
  if (!data?.length) return null;
  return (
    <>
      {data.map((p) => (
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
          onAction={(name, payload) =>
            action(env.id, name, payload, { "X-Parley-Plugin-Route": p.name })
          }
        />
      ))}
    </>
  );
}
