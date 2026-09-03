import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Envelope } from "./api";
import {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  CrashBreaker,
  createPluginBridge,
  redactSession,
} from "./pluginBridge";

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "s1",
    kind: "poker",
    title: "Sprint 42",
    phase: "voting",
    revealed: false,
    version: 7,
    facilitatorId: "u1",
    facilitatorConnected: true,
    endedAt: null,
    presence: ["u1", "u2"],
    spaceSlug: "alpha-squad",
    orgSlug: "default",
    participants: [
      { userId: "u1", name: "Dana Whitfield", avatarHue: 120, spectator: false },
      { userId: "u2", name: "Ravi Menon", avatarHue: 20, spectator: false },
    ],
    serverTime: "2026-01-01T00:00:00Z",
    state: {
      deck: { name: "Fibonacci", values: ["1", "2", "3"], ordinal: true },
      autoReveal: false,
      openVoting: false,
      currentStoryId: "st1",
      stories: [
        {
          id: "st1",
          title: "Log in with a passkey",
          estimate: null,
          status: "voting",
          votedUserIds: ["u1", "u2"],
          // A server that regressed, a cache poisoned by a stale frame, a
          // future field: the bridge must not depend on this being absent.
          votes: [
            { userId: "u1", value: "8" },
            { userId: "u2", value: "3" },
          ],
          results: { median: "5", spread: 5, consensus: false, counts: {} },
        },
      ],
    },
    ...over,
  } as Envelope;
}

const READ = ["session:read"] as const;

describe("redactSession", () => {
  it("keeps hidden votes hidden before the reveal", () => {
    const out = redactSession(envelope({ revealed: false }), READ);
    const story = out!.state.stories[0];
    expect(story.votes).toBeUndefined();
    expect(story.results).toBeUndefined();
    // Who voted is not what they voted: the count is the whole point of the
    // pre-reveal screen, so it must survive.
    expect(story.votedUserIds).toEqual(["u1", "u2"]);
    // And no vote value survives anywhere in the payload, whatever shape a
    // future field arrives in.
    expect(JSON.stringify(out)).not.toContain('"8"');
  });

  it("releases votes once the round is revealed", () => {
    const out = redactSession(envelope({ revealed: true }), READ);
    expect(out!.state.stories[0].votes).toEqual([
      { userId: "u1", value: "8" },
      { userId: "u2", value: "3" },
    ]);
    expect(out!.state.stories[0].results).toBeTruthy();
  });

  it("hands a plugin with no session:read grant nothing at all", () => {
    expect(redactSession(envelope({ revealed: true }), [])).toBeNull();
  });

  it("does not leak the space or org a session lives in", () => {
    const out = redactSession(envelope({ revealed: true }), READ);
    expect(JSON.stringify(out)).not.toContain("alpha-squad");
  });
});

/** A stand-in for the frame's contentWindow: it records the transferred port. */
function fakeFrame() {
  const channel = new MessageChannel();
  const posted: unknown[] = [];
  const target = {
    postMessage(message: unknown, _origin: string, transfer?: Transferable[]) {
      posted.push(message);
      if (transfer && transfer[0]) {
        // The frame's half of the channel, as the real bootstrap would take it.
        (transfer[0] as MessagePort).start();
      }
    },
  };
  return { channel, target, posted };
}

describe("createPluginBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function bridge(over: Record<string, unknown> = {}) {
    const failures: string[] = [];
    const actions: { action: string; payload: unknown }[] = [];
    const f = fakeFrame();
    const b = createPluginBridge({
      target: f.target as unknown as Window,
      grants: ["session:read", "session:act"],
      onAction: (action, payload) => {
        actions.push({ action, payload });
        return Promise.resolve();
      },
      onFailure: (reason) => failures.push(reason),
      ...over,
    });
    return { b, failures, actions, ...f };
  }

  it("renders an explicit failure rather than a blank rectangle when the frame never answers", () => {
    const { b, failures } = bridge();
    vi.advanceTimersByTime(20_000);
    expect(failures).toContain("handshake-timeout");
    b.close();
  });

  it("never reads a message that did not arrive on the port", async () => {
    const { b, posted, actions } = bridge();
    b.handshake();
    // The handshake is one postMessage carrying exactly one port, and the
    // bridge sends nothing else to the window.
    expect(posted.length).toBe(1);
    b.handshake();
    expect(posted.length).toBe(1);
    // Any frame on the page reports origin "null", so origin proves nothing
    // and the port is the credential. A window message is therefore never
    // read, however well-formed it is.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        data: JSON.stringify({ type: "act", action: "reveal", payload: {} }),
      }),
    );
    await Promise.resolve();
    expect(actions).toEqual([]);
    // The control: the same message on the port is acted on, so the assertion
    // above is about the route and not about the message.
    b.receive(JSON.stringify({ type: "act", action: "reveal", payload: {} }));
    await Promise.resolve();
    expect(actions.length).toBe(1);
    b.close();
  });

  it("drops an oversize message from the plugin instead of processing it", async () => {
    const { b, failures, actions } = bridge();
    b.handshake();
    b.receive(JSON.stringify({ type: "act", action: "x".repeat(MAX_MESSAGE_BYTES + 100) }));
    await Promise.resolve();
    expect(actions).toEqual([]);
    expect(failures).toContain("oversize");
    b.close();
  });

  it("trips the breaker when a plugin floods the port", async () => {
    const { b, failures, actions } = bridge();
    b.handshake();
    for (let i = 0; i < MAX_MESSAGES_PER_SECOND + 5; i++) {
      b.receive(JSON.stringify({ type: "act", action: "reveal", payload: {} }));
    }
    await Promise.resolve();
    expect(failures).toContain("flood");
    expect(actions.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_SECOND);
    b.close();
  });

  it("refuses an action the plugin was not granted", async () => {
    const { b, actions, failures } = bridge({ grants: ["session:read"] });
    b.handshake();
    b.receive(JSON.stringify({ type: "act", action: "reveal", payload: {} }));
    await Promise.resolve();
    expect(actions).toEqual([]);
    expect(failures).toContain("ungranted");
    b.close();
  });

  it("mediates a granted action itself and never hands the plugin a credential", async () => {
    const { b, actions, posted } = bridge();
    b.handshake();
    b.receive(JSON.stringify({ type: "act", action: "reveal", payload: { storyId: "st1" } }));
    await Promise.resolve();
    expect(actions).toEqual([{ action: "reveal", payload: { storyId: "st1" } }]);
    expect(JSON.stringify(posted)).not.toMatch(/cookie|token|authorization/i);
    b.close();
  });

  it("bounds what the host pushes into the frame too", () => {
    const { b, failures } = bridge();
    b.handshake();
    const huge = envelope({ title: "x".repeat(MAX_MESSAGE_BYTES) });
    b.sendState(huge);
    expect(failures).toContain("oversize-outbound");
    b.close();
  });

  it("pushes only the redacted projection into the frame", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(envelope({ revealed: false }));
    vi.advanceTimersByTime(500);
    expect(sent.join("")).not.toContain('"8"');
    expect(sent.join("")).toContain("Log in with a passkey");
    b.close();
  });
});

describe("CrashBreaker", () => {
  it("opens after repeated crashes and closes again after the cooldown", () => {
    const now = { t: 0 };
    const breaker = new CrashBreaker(3, 60_000, () => now.t);
    expect(breaker.open()).toBe(false);
    breaker.crashed();
    breaker.crashed();
    expect(breaker.open()).toBe(false);
    breaker.crashed();
    expect(breaker.open()).toBe(true);
    now.t = 60_001;
    expect(breaker.open()).toBe(false);
  });

  it("does not open on crashes spread beyond the window", () => {
    const now = { t: 0 };
    const breaker = new CrashBreaker(3, 60_000, () => now.t);
    breaker.crashed();
    now.t = 30_000;
    breaker.crashed();
    now.t = 90_000;
    breaker.crashed();
    expect(breaker.open()).toBe(false);
  });
});
