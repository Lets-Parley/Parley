import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectSession, type ConnectionStatus } from "./socket";

/** Every socket the module under test opened, in order. */
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  close() {
    this.closed = true;
  }
  /** Drive the socket the way a browser would. */
  open() {
    this.onopen?.();
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  send(data: string) {
    this.onmessage?.({ data });
  }
}

function connect() {
  const onState = vi.fn();
  const statuses: ConnectionStatus[] = [];
  const stop = connectSession({
    sessionId: "sess 1",
    onState,
    onStatus: (s) => statuses.push(s),
  });
  return { onState, statuses, stop };
}

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "parley.test:8080" });
  // Deterministic jitter: always the top of the jitter window.
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectSession", () => {
  it("opens a ws:// socket for the session, url-encoding the id", () => {
    connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://parley.test:8080/ws?session=sess%201");
  });

  it("upgrades to wss:// on a secure page", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "parley.test" });
    connect();
    expect(sockets[0].url).toBe("wss://parley.test/ws?session=sess%201");
  });

  it("reports live on open and hands parsed frames to the caller", () => {
    const { onState, statuses } = connect();
    sockets[0].open();
    expect(statuses).toEqual(["live"]);
    sockets[0].send('{"version":3}');
    expect(onState).toHaveBeenCalledWith({ version: 3 });
  });

  it("ignores an unparseable frame instead of tearing the room down", () => {
    const { onState } = connect();
    sockets[0].open();
    expect(() => sockets[0].send("not json")).not.toThrow();
    expect(onState).not.toHaveBeenCalled();
  });

  it("reconnects after a drop, with jittered backoff inside the expected window", () => {
    const { statuses } = connect();
    sockets[0].open();
    sockets[0].drop();
    expect(statuses).toEqual(["live", "reconnecting"]);

    // First backoff is 500ms, so the delay lives in [250, 500).
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(251);
    expect(sockets).toHaveLength(2);
  });

  it("never fires two clients at the same instant — the delay carries jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    connect();
    sockets[0].drop();
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1); // floor of the window is 250ms, not 0
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it("backs off exponentially and caps well under the facilitator grace", () => {
    connect();
    let opened = 1;
    for (let i = 0; i < 12; i++) {
      sockets[sockets.length - 1].drop();
      vi.advanceTimersByTime(15_000);
      expect(sockets).toHaveLength(++opened);
    }
    // The cap matters: a 60s+ backoff would outlast the grace period and
    // strand the table with nobody able to take the chair.
    sockets[sockets.length - 1].drop();
    vi.advanceTimersByTime(14_999);
    expect(sockets).toHaveLength(opened);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(opened + 1);
  });

  it("resets the backoff once a connection succeeds", () => {
    connect();
    for (let i = 0; i < 5; i++) {
      sockets[sockets.length - 1].drop();
      vi.advanceTimersByTime(15_000);
    }
    sockets[sockets.length - 1].open();
    const before = sockets.length;
    sockets[before - 1].drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(before + 1);
  });

  it("calls the board stale once it has been down long enough to distrust", () => {
    const { statuses } = connect();
    sockets[0].open();
    sockets[0].drop();
    vi.advanceTimersByTime(9_999);
    expect(statuses).not.toContain("stale");
    vi.advanceTimersByTime(1);
    expect(statuses).toContain("stale");
  });

  it("clears the stale warning when it comes back", () => {
    const { statuses } = connect();
    sockets[0].drop();
    vi.advanceTimersByTime(500);
    sockets[1].open();
    vi.advanceTimersByTime(60_000);
    expect(statuses).not.toContain("stale");
  });

  it("closes the socket on a transport error so the reconnect path takes over", () => {
    connect();
    sockets[0].onerror?.();
    expect(sockets[0].closed).toBe(true);
  });

  it("stops reconnecting once the caller lets go", () => {
    const { stop, statuses } = connect();
    sockets[0].open();
    stop();
    expect(sockets[0].closed).toBe(true);
    sockets[0].drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(["live"]);
  });

  it("stops reconnecting when the server closes with 1008 — retrying cannot help", () => {
    const { statuses } = connect();
    sockets[0].open();
    sockets[0].drop(1008);
    expect(statuses).toEqual(["live", "removed"]);
    // No retry, and no delayed "stale" claim about a connection that is gone
    // for a reason we can name.
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(["live", "removed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still reconnects on an ordinary close code", () => {
    const { statuses } = connect();
    sockets[0].open();
    sockets[0].drop(1006);
    expect(statuses).toEqual(["live", "reconnecting"]);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
  });

  it("leaves no timer behind after stop", () => {
    const { stop } = connect();
    sockets[0].drop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
