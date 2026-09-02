import { useRef } from "react";
import type { ConnectionStatus } from "./socket";

export type RosterDelta = { joined: string[]; left: string[] };

const NOTHING: RosterDelta = { joined: [], left: [] };

/**
 * Who arrived and who went, between one envelope and the next.
 *
 * There is no join event anywhere in Parley: useSession replaces the whole
 * envelope, guarded only by a monotonic version. So the signal is
 * `env.presence` — `env.participants` is durable and only ever grows, and
 * diffing it would announce somebody who left months ago.
 *
 * The baseline is RE-SEEDED across a reconnect rather than diffed. useSession
 * invalidates and refetches whenever status returns to "live" and ws.go hands
 * every new socket a full envelope, so a naive differ animates the entire room
 * as joining after every network blip. Presence is age-based rather than
 * connection-based (a 50s pong deadline in presence.go), so a drop longer than
 * the freshness window does read as a leave followed by a join — which is
 * correct: a rejoin should drop in again.
 *
 * Nothing is debounced here. hub.go already merges presence changes inside
 * 1500ms into one rebroadcast, so a meeting-start burst arrives as a single
 * diff of several ids; a client-side coalescer would only fight it.
 *
 * The viewer's own id is never in `joined`. The page renders you seated over
 * HTTP and the socket registers you afterwards, so your own id first appears
 * in presence on a later envelope, when the differ already has a baseline and
 * reads you as a newcomer to the seat you are sitting in. Excluding you is an
 * invariant rather than a widened seeding window: a seat must never drop in on
 * the screen of the person occupying it, whatever the envelope order, and a
 * wider window would also swallow a genuine joiner arriving in the same
 * rebroadcast. The `left` half is untouched — you can still be seen to go.
 *
 * Adjusting a ref during render is the same idiom useRoundEpoch uses, and the
 * unchanged case returns the *previous* object so a seat already mid-drop is
 * never handed a freshly-built delta.
 */
export function useRosterDelta(
  presence: string[],
  status: ConnectionStatus,
  meId: string,
): RosterDelta {
  const prev = useRef<{ ids: Set<string>; live: boolean; delta: RosterDelta } | null>(null);
  const p = prev.current;
  const ids = new Set(presence);
  const live = status === "live";

  // First envelope after mount, anything seen while the socket is not live,
  // and the first envelope after it comes back: seed, never diff.
  if (!p || !p.live || !live) {
    prev.current = { ids, live, delta: NOTHING };
    return NOTHING;
  }

  const joined = presence.filter((id) => !p.ids.has(id) && id !== meId);
  const left = [...p.ids].filter((id) => !ids.has(id));
  const delta = joined.length > 0 || left.length > 0 ? { joined, left } : p.delta;
  prev.current = { ids, live, delta };
  return delta;
}
