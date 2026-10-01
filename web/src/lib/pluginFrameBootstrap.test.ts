import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The frame's half of the bridge is served inline inside a document the Go
 * handler assembles, and for a long time neither test runner could execute it:
 * the Go side could only assert on its text, which is how a test that passed
 * against a fully defanged guard came to be written.
 *
 * It now lives in one .js file that Go embeds and this test reads, so what is
 * executed here is byte-for-byte what ships in the frame. The assertions below
 * are about behavior — whether a port is accepted — not about the shape of
 * the source, so rephrasing a condition cannot turn them red and gutting one
 * cannot leave them green.
 */
// Vitest runs with web/ as its root, so the Go package is one level up. Vite
// rewrites import.meta.url to an http URL, which is why this is not a URL.
const BOOTSTRAP = readFileSync(
  resolve(process.cwd(), "../internal/api/pluginframe_bootstrap.js"),
  "utf8",
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete (window as unknown as Record<string, unknown>).parley;
  delete (window as unknown as Record<string, unknown>).parleyBridgeReady;
});

/**
 * Runs the real bootstrap against the real window, remembering the listener it
 * installs so one test's frame cannot answer the next test's handshake. The
 * bootstrap removes its own listener once it has taken a port; this cleanup is
 * for the runs where it correctly refuses one and keeps listening.
 */
function loadBootstrap(): void {
  const added: EventListenerOrEventListenerObject[] = [];
  const real = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type === "message") added.push(fn);
    return real(type as keyof WindowEventMap, fn as EventListener, opts as AddEventListenerOptions);
  }) as typeof window.addEventListener;
  try {
    new Function(BOOTSTRAP)();
  } finally {
    window.addEventListener = real as typeof window.addEventListener;
  }
  cleanups.push(() => {
    for (const fn of added) window.removeEventListener("message", fn);
  });
}

/**
 * How long a refusal is given to prove itself. Only the negative cases wait
 * it out — an accepted port answers as soon as its hello arrives — so it is
 * long enough to survive a loaded machine rather than tuned to be quick.
 */
const SETTLE_MS = 250;

/**
 * Offers the frame a port and reports whether it took it. Acceptance is
 * observable from the far end: the bootstrap's first act on a port it has
 * accepted is to send {"type":"hello"}.
 */
async function offerPort(opts: {
  source: MessageEventSource | null;
  data: unknown;
  withPort?: boolean;
}): Promise<boolean> {
  const channel = new MessageChannel();
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  let accepted = false;
  // Waiting for the hello, rather than for a fixed number of turns. A
  // MessagePort has its own task queue, so "one macrotask" was an assumption
  // about scheduling and not a fact about delivery — and this test failed once
  // inside a full harness run, which is a red required mutation leg for every
  // PR afterwards. An acceptance now resolves the moment the hello lands; only
  // a refusal, which is a negative and has nothing to wait for, spends the
  // whole budget below.
  let helloLanded: () => void;
  const hello = new Promise<void>((resolve) => {
    helloLanded = resolve;
  });
  channel.port2.onmessage = (e: MessageEvent) => {
    const message = JSON.parse(String(e.data)) as { type?: string };
    if (message.type === "hello") {
      accepted = true;
      helloLanded();
    }
  };
  channel.port2.start();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: opts.data,
      source: opts.source,
      ports: opts.withPort === false ? [] : [channel.port1],
    }),
  );

  await Promise.race([
    hello,
    new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
  ]);
  return accepted;
}

/** A sender that is not window.parent — a sibling plugin's frame stands in. */
function notTheParent(): MessageEventSource {
  const channel = new MessageChannel();
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  return channel.port1 as unknown as MessageEventSource;
}

describe("the plugin frame's handshake", () => {
  it("refuses a port from anyone but its embedder", async () => {
    loadBootstrap();

    expect(
      await offerPort({ source: notTheParent(), data: { parley: "bridge" } }),
    ).toBe(false);

    // And the refusal is not a one-way door: the real host can still get in,
    // which is what proves the frame said no rather than simply broke.
    expect(await offerPort({ source: window.parent, data: { parley: "bridge" } })).toBe(true);
  });

  it("refuses a port that does not carry the host's own marker", async () => {
    loadBootstrap();

    expect(await offerPort({ source: window.parent, data: { parley: "not-bridge" } })).toBe(false);
    expect(await offerPort({ source: window.parent, data: {} })).toBe(false);
    expect(await offerPort({ source: window.parent, data: null })).toBe(false);

    expect(await offerPort({ source: window.parent, data: { parley: "bridge" } })).toBe(true);
  });

  it("refuses a handshake that carries no port to take", async () => {
    loadBootstrap();

    expect(
      await offerPort({ source: window.parent, data: { parley: "bridge" }, withPort: false }),
    ).toBe(false);
  });

  it("takes the embedder's port and then stops listening to the window", async () => {
    loadBootstrap();

    expect(await offerPort({ source: window.parent, data: { parley: "bridge" } })).toBe(true);
    expect((window as unknown as Record<string, unknown>).parleyBridgeReady).toBe(true);

    // A second handshake, impeccably formed and from the embedder itself, is
    // ignored: the listener is gone, so there is no second port to swap in.
    expect(await offerPort({ source: window.parent, data: { parley: "bridge" } })).toBe(false);
  });
});

type FrameApi = {
  act: (action: string, payload?: unknown) => Promise<{ ok: boolean; reason?: string }> | undefined;
  onTokens: (fn: (tokens: Record<string, string>) => void) => void;
  scheme: () => string | null;
};

/**
 * Completes the handshake as the host would and returns the host's end of the
 * port, with everything the frame has sent on it so far.
 */
async function connect(): Promise<{ host: MessagePort; fromFrame: Array<Record<string, unknown>> }> {
  const channel = new MessageChannel();
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const fromFrame: Array<Record<string, unknown>> = [];
  channel.port2.onmessage = (e: MessageEvent) => {
    fromFrame.push(JSON.parse(String(e.data)) as Record<string, unknown>);
  };
  channel.port2.start();
  window.dispatchEvent(
    new MessageEvent("message", { data: { parley: "bridge" }, source: window.parent, ports: [channel.port1] }),
  );
  await vi.waitFor(() => expect(fromFrame.some((m) => m.type === "hello")).toBe(true));
  return { host: channel.port2, fromFrame };
}

function frameApi(): FrameApi {
  return (window as unknown as { parley: FrameApi }).parley;
}

describe("the plugin frame's theme", () => {
  afterEach(() => document.documentElement.removeAttribute("style"));

  it("sets color-scheme from the host's scheme so native controls follow the theme", async () => {
    loadBootstrap();
    const { host } = await connect();
    const root = document.documentElement;

    host.postMessage(JSON.stringify({ type: "tokens", tokens: { ink: "#f0f0f0" }, scheme: "dark" }));
    await vi.waitFor(() => expect(root.style.getPropertyValue("color-scheme")).toBe("dark"));
    expect(frameApi().scheme()).toBe("dark");
  });

  it("refuses a scheme that is not light or dark", async () => {
    loadBootstrap();
    const { host } = await connect();
    const root = document.documentElement;

    host.postMessage(JSON.stringify({ type: "tokens", tokens: { ink: "#f0f0f0" }, scheme: "dark" }));
    await vi.waitFor(() => expect(root.style.getPropertyValue("color-scheme")).toBe("dark"));

    // A value CSS would accept but the host never sends, and one it would not.
    for (const scheme of ["light dark", "only light", "dark; background: url(x)", 7, null]) {
      host.postMessage(JSON.stringify({ type: "tokens", tokens: { ink: "#0a0a0a" }, scheme }));
    }
    // The tokens beside the last refused scheme did land, so the refusal was
    // read and not merely still in flight.
    await vi.waitFor(() => expect(root.style.getPropertyValue("--color-ink")).toBe("#0a0a0a"));
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(frameApi().scheme()).toBe("dark");
  });

  it("re-themes on a second tokens message over the same port", async () => {
    loadBootstrap();
    const { host } = await connect();
    const root = document.documentElement;
    const seen: Array<Record<string, string>> = [];
    frameApi().onTokens((t) => seen.push(t));

    host.postMessage(JSON.stringify({ type: "tokens", tokens: { surface: "#ffffff" }, scheme: "light" }));
    await vi.waitFor(() => expect(root.style.getPropertyValue("--color-surface")).toBe("#ffffff"));
    host.postMessage(JSON.stringify({ type: "tokens", tokens: { surface: "#111111" }, scheme: "dark" }));
    await vi.waitFor(() => expect(root.style.getPropertyValue("--color-surface")).toBe("#111111"));

    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(seen).toEqual([{ surface: "#ffffff" }, { surface: "#111111" }]);
  });

  it("keeps working for a host that sends no scheme at all", async () => {
    loadBootstrap();
    const { host } = await connect();
    const root = document.documentElement;

    host.postMessage(JSON.stringify({ type: "tokens", tokens: { surface: "#ffffff" } }));
    await vi.waitFor(() => expect(root.style.getPropertyValue("--color-surface")).toBe("#ffffff"));
    expect(root.style.getPropertyValue("color-scheme")).toBe("");
    expect(frameApi().scheme()).toBe(null);
  });
});

describe("the plugin frame's action results", () => {
  it("resolves act with the host's answer for that action", async () => {
    loadBootstrap();
    const { host, fromFrame } = await connect();

    const accepted = frameApi().act("add-card", { text: "Shipped" })!;
    const refused = frameApi().act("reveal")!;
    await vi.waitFor(() => expect(fromFrame.filter((m) => m.type === "act").length).toBe(2));
    const [first, second] = fromFrame.filter((m) => m.type === "act");
    expect(first).toEqual({ type: "act", id: 1, action: "add-card", payload: { text: "Shipped" } });
    expect(second).toEqual({ type: "act", id: 2, action: "reveal", payload: {} });

    // Answered out of order, so the id and not the arrival order is the match.
    host.postMessage(JSON.stringify({ type: "result", id: 2, ok: false, reason: "forbidden" }));
    host.postMessage(JSON.stringify({ type: "result", id: 1, ok: true }));
    expect(await refused).toEqual({ ok: false, reason: "forbidden" });
    expect(await accepted).toEqual({ ok: true });
  });

  it("ignores a result for an id it never sent, and a second result for one it did", async () => {
    loadBootstrap();
    const { host } = await connect();

    const settled: unknown[] = [];
    void frameApi().act("reveal")!.then((r) => settled.push(r));

    host.postMessage(JSON.stringify({ type: "result", id: 99, ok: true }));
    host.postMessage(JSON.stringify({ type: "result", id: "constructor", ok: true }));
    host.postMessage(JSON.stringify({ type: "result", id: 1, ok: false, reason: "conflict" }));
    host.postMessage(JSON.stringify({ type: "result", id: 1, ok: true }));
    // A later message proves the four above were all read.
    host.postMessage(JSON.stringify({ type: "tokens", tokens: { ink: "#222222" } }));
    await vi.waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--color-ink")).toBe("#222222"),
    );
    expect(settled).toEqual([{ ok: false, reason: "conflict" }]);
  });

  it("hands the plugin a short reason code and nothing longer", async () => {
    loadBootstrap();
    const { host } = await connect();

    const wordy = frameApi().act("reveal")!;
    host.postMessage(
      JSON.stringify({ type: "result", id: 1, ok: false, reason: "only the facilitator can do that" }),
    );
    expect(await wordy).toEqual({ ok: false, reason: "failed" });

    const bare = frameApi().act("reveal")!;
    host.postMessage(JSON.stringify({ type: "result", id: 2, ok: false }));
    expect(await bare).toEqual({ ok: false, reason: "failed" });
  });
});
