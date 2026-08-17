export type ConnectionStatus = "live" | "reconnecting" | "stale";

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
    ws.onclose = () => {
      if (closed) return;
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
