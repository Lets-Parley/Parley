export type ConnectionStatus = "live" | "reconnecting" | "stale" | "removed";

// The server closes with 1008 (policy violation) when the socket is no longer
// allowed in the room — the usual cause being that you were removed from the
// space. Retrying cannot fix that, so it is a terminal state, not a drop.
const CLOSE_POLICY_VIOLATION = 1008;

type Options = {
  sessionId: string;
  onState: (state: unknown) => void;
  onStatus: (status: ConnectionStatus) => void;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000; // must stay well under the 60s facilitator grace
const STALE_AFTER_MS = 10_000;

// Connects to /ws and keeps reconnecting with jittered capped exponential
// backoff — a naive fixed-interval loop would synchronize every client in the
// room into a reconnect stampede after a deploy.
export function connectSession({ sessionId, onState, onStatus }: Options): () => void {
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
      try {
        onState(JSON.parse(ev.data));
      } catch {
        // Ignore unparseable frames.
      }
    };
    ws.onclose = (ev) => {
      if (closed) return;
      if (ev?.code === CLOSE_POLICY_VIOLATION) {
        // Terminal: reconnecting would loop forever behind a banner that only
        // ever said "stale", which is not what happened.
        closed = true;
        clearTimeout(retryTimer);
        clearTimeout(staleTimer);
        onStatus("removed");
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
