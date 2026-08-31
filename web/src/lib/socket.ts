export type ConnectionStatus = "live" | "reconnecting" | "stale" | "removed" | "kicked";

// The server closes with 1008 (policy violation) when the socket is no longer
// allowed in the room — the usual cause being that you were removed from the
// space. Retrying cannot fix that, so it is a terminal state, not a drop.
const CLOSE_POLICY_VIOLATION = 1008;

// 4001 is the room's own removal: the facilitator ejected you from this
// meeting, and you are still perfectly welcome in the space. A separate code
// because the two need separate screens — reusing 1008 would tell somebody
// they had lost access to everything over one round of planning poker. The
// close frame carries the facilitator's message, capped server-side at the
// 123 bytes a control frame can hold.
const CLOSE_REMOVED_FROM_SESSION = 4001;

type Options = {
  sessionId: string;
  onState: (state: unknown) => void;
  /**
   * Somebody else was removed from this room. An event, not a snapshot: the
   * envelope says who is present, never who just stopped being.
   */
  onKick?: (userId: string) => void;
  /** `reason` is set only for a terminal close that carries one. */
  onStatus: (status: ConnectionStatus, reason?: string) => void;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000; // must stay well under the 60s facilitator grace
const STALE_AFTER_MS = 10_000;

// Connects to /ws and keeps reconnecting with jittered capped exponential
// backoff — a naive fixed-interval loop would synchronize every client in the
// room into a reconnect stampede after a deploy.
export function connectSession({ sessionId, onState, onKick, onStatus }: Options): () => void {
  let ws: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let retryTimer: number | undefined;
  let staleTimer: number | undefined;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws?session=${encodeURIComponent(sessionId)}`;

  function open() {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempts = 0;
      clearTimeout(staleTimer);
      onStatus("live");
    };
    ws.onmessage = (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return; // Ignore unparseable frames.
      }
      // Every other frame on this socket is a session envelope, and the room
      // is rendered from the newest one. A kick is an event with no version,
      // so it has to be split off here or it would be stored as the envelope
      // and blank the whole table.
      const kick = (frame as { kick?: { userId?: unknown } } | null)?.kick;
      if (kick) {
        if (typeof kick.userId === "string" && kick.userId) onKick?.(kick.userId);
        return;
      }
      onState(frame);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (closed) return;
      if (ev?.code === CLOSE_POLICY_VIOLATION || ev?.code === CLOSE_REMOVED_FROM_SESSION) {
        // Terminal: reconnecting would loop forever behind a banner that only
        // ever said "stale", which is not what happened.
        closed = true;
        clearTimeout(retryTimer);
        clearTimeout(staleTimer);
        if (ev.code === CLOSE_REMOVED_FROM_SESSION) onStatus("kicked", ev.reason ?? "");
        else onStatus("removed");
        return;
      }
      onStatus("reconnecting");
      clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => onStatus("stale"), STALE_AFTER_MS);
      const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts);
      const delay = backoff / 2 + Math.random() * (backoff / 2);
      attempts += 1;
      retryTimer = window.setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  }

  open();

  return () => {
    closed = true;
    clearTimeout(retryTimer);
    clearTimeout(staleTimer);
    ws?.close();
  };
}
