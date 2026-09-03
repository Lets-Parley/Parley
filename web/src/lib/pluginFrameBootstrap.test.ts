import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The frame's half of the bridge is served inline inside a document the Go
 * handler assembles, and for a long time neither test runner could execute it:
 * the Go side could only assert on its text, which is how a test that passed
 * against a fully defanged guard came to be written.
 *
 * It now lives in one .js file that Go embeds and this test reads, so what is
 * executed here is byte-for-byte what ships in the frame. The assertions below
 * are about behaviour — whether a port is accepted — not about the shape of
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
  channel.port2.onmessage = (e: MessageEvent) => {
    const message = JSON.parse(String(e.data)) as { type?: string };
    if (message.type === "hello") accepted = true;
  };
  channel.port2.start();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: opts.data,
      source: opts.source,
      ports: opts.withPort === false ? [] : [channel.port1],
    }),
  );

  // The hello crosses the channel asynchronously, so give the port a turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
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
