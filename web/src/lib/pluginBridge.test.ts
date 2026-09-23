import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Envelope } from "./api";
import {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  CrashBreaker,
  createPluginBridge,
  overMessageCap,
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
            // Neither value appears in the deck above. A vote value that
            // collides with a deck value proves nothing when the assertion is
            // "this string is absent from the payload": the deck is pushed
            // whether or not the round is revealed, so the string would be
            // there either way.
            { userId: "u1", value: "8" },
            { userId: "u2", value: "13" },
          ],
          results: { median: "5", spread: 5, consensus: false, counts: {} },
        },
      ],
    },
    ...over,
  } as Envelope;
}

const READ = ["session:read"] as const;

/** The install the frame under test belongs to. */
const RETRO = "retro";

// A room running a ceremony the framed plugin provides: the envelope names the
// install, exactly as the server builds it for a plugin-owned kind.
function pluginKindEnvelope(over: Partial<Envelope> = {}): Envelope {
  return {
    ...envelope(),
    kind: "acme-retro",
    plugin: { name: RETRO, version: "1.0.0", grants: ["session:read"] },
    state: { columns: ["went-well"], hidden: "ok-from-statefunc" },
    ...over,
  } as unknown as Envelope;
}

// A standup room as its StateFunc sends it to members. Every value below is
// something the consent copy says a plugin cannot read.
function standupEnvelope(): Envelope {
  return {
    ...envelope(),
    kind: "standup",
    phase: "open",
    state: {
      entries: [
        { userId: "u1", yesterday: "shipped-the-sso-fix", today: "on-call", blockers: "vendor-outage" },
      ],
      away: [{ userId: "u2", note: "medical-leave" }],
      members: [{ userId: "u3", name: "Priya Castellanos" }],
    },
  } as unknown as Envelope;
}

describe("redactSession", () => {
  it("builds the plugin's own room field by field", () => {
    const out = redactSession(pluginKindEnvelope(), READ, RETRO);
    expect(Object.keys(out!).sort()).toEqual(
      [
        "endedAt",
        "facilitatorId",
        "id",
        "kind",
        "participants",
        "phase",
        "presence",
        "revealed",
        "state",
        "title",
        "version",
      ].sort(),
    );
    // The kind's StateFunc already decided what is client-safe, so its
    // document is what the frame gets.
    expect(out!.state).toEqual({ columns: ["went-well"], hidden: "ok-from-statefunc" });
    expect(JSON.stringify(out)).not.toContain("alpha-squad");
    expect(JSON.stringify(out)).not.toContain('"plugin"');
  });

  it("hands a plugin with no session:read grant nothing at all", () => {
    expect(redactSession(pluginKindEnvelope(), [], RETRO)).toBeNull();
  });

  // The consent screen promises session:read "cannot read a planning poker or
  // standup room, or any other plugin's rooms" (internal/plugin/describe.go).
  // A frame in chrome on such a room is told nothing about it — not its state,
  // not who is seated, not its title.
  it("hands a plugin nothing about a poker room, revealed or not", () => {
    expect(redactSession(envelope({ revealed: false }), READ, RETRO)).toBeNull();
    expect(redactSession(envelope({ revealed: true }), READ, RETRO)).toBeNull();
  });

  it("hands a plugin nothing about a standup room", () => {
    expect(redactSession(standupEnvelope(), READ, RETRO)).toBeNull();
  });

  it("hands a plugin nothing about another plugin's room", () => {
    const other = pluginKindEnvelope({
      plugin: { name: "someone-else", version: "1.0.0", grants: ["session:read"] },
    } as Partial<Envelope>);
    expect(redactSession(other, READ, RETRO)).toBeNull();
  });

  it("hands a plugin nothing about a room whose ceremony is switched off", () => {
    const off = { ...pluginKindEnvelope(), plugin: undefined, kindUnavailable: true, state: null } as unknown as Envelope;
    expect(redactSession(off, READ, RETRO)).toBeNull();
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
      plugin: RETRO,
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

  // The cap is documented in bytes, so it has to be measured in bytes. A
  // string's .length counts UTF-16 code units, and CJK text is three bytes to
  // the unit — measured that way the cap was three times the documented budget
  // for exactly the text most likely to be large.
  it("measures the message cap in bytes rather than UTF-16 code units", async () => {
    // Just under the cap in code units, three times over it in UTF-8.
    const cjk = "\u4e00".repeat(MAX_MESSAGE_BYTES - 100);
    expect(cjk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(overMessageCap(cjk)).toBe(true);
    // ASCII of the same code-unit length is a byte apiece and stays under.
    expect(overMessageCap("a".repeat(MAX_MESSAGE_BYTES - 100))).toBe(false);

    const { b, failures, actions } = bridge();
    b.handshake();
    b.receive(JSON.stringify({ type: "act", action: "reveal", payload: { note: cjk } }));
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

  // The action name is a path segment. Left unscreened it is a path
  // *expression*: dot segments are normalised by the same URL parser fetch
  // uses, so "../../../me" leaves /api/sessions/{id}/actions/ entirely and
  // POSTs to /api/me — renaming the user — on the user's own cookie, with no
  // audit record, because pluginRouteAudit is only mounted under
  // /api/sessions/{id}. Every unknown name defaults to POST, and the request
  // is genuinely same-origin so the cross-site guard waves it through. The
  // screen is here, on the host side, before the name is ever a URL.
  it("refuses an action name that could climb out of the actions path", async () => {
    const escapes = [
      "../../../me",
      "../../OTHER/actions/vote",
      "../../../orgs/acme/spaces/eng/passcode",
      "..%2f..%2fme",
      "reveal/../../me",
      "",
      "reveal?x=1",
      "reveal#x",
      // Alphabet-legal, but an action name is a short identifier, not a novel.
      "a".repeat(65),
      "a".repeat(60000),
    ];
    for (const name of escapes) {
      const { b, actions, failures } = bridge();
      b.handshake();
      b.receive(JSON.stringify({ type: "act", action: name, payload: {} }));
      await Promise.resolve();
      expect(actions, `action ${JSON.stringify(name)} reached the host`).toEqual([]);
      expect(failures).toContain("malformed");
      b.close();
    }
    // The control: an ordinary name still gets through, so the screen refuses
    // the climb rather than refusing everything.
    const ok = bridge();
    ok.b.handshake();
    ok.b.receive(JSON.stringify({ type: "act", action: "reveal", payload: {} }));
    await Promise.resolve();
    expect(ok.actions).toEqual([{ action: "reveal", payload: {} }]);
    ok.b.close();
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
    const huge = pluginKindEnvelope({ title: "x".repeat(MAX_MESSAGE_BYTES) });
    b.sendState(huge);
    expect(failures).toContain("oversize-outbound");
    b.close();
  });

  // Coalescing is a correctness property, not only a throttle: the frame must
  // end up holding the *newest* state. Keeping the oldest instead would leave
  // a plugin rendering a round that has already moved on, with nothing to tell
  // it so — and the change is one word, so it needs its own test.
  it("coalesces two pushes in one interval onto the newer state", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(pluginKindEnvelope({ title: "Sprint 42" }));
    b.sendState(pluginKindEnvelope({ title: "Sprint 43" }));
    vi.advanceTimersByTime(500);
    const body = sent.join("");
    expect(body).toContain("Sprint 43");
    expect(body).not.toContain("Sprint 42");
    // And exactly one push landed, which is the throttling half.
    expect(sent.length).toBe(1);
    b.close();
  });

  // The exact message a frame receives, read by its raw keys: a reflected type
  // would pass for any payload the projection happened to type-check against.
  it("pushes the plugin's own room into the frame, and exactly that", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(pluginKindEnvelope());
    vi.advanceTimersByTime(500);
    expect(sent.length).toBe(1);
    const message = JSON.parse(sent[0]) as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(["state", "type"]);
    expect(message.type).toBe("state");
    expect(message.state).toEqual({
      id: "s1",
      kind: "acme-retro",
      title: "Sprint 42",
      phase: "voting",
      revealed: false,
      version: 7,
      facilitatorId: "u1",
      endedAt: null,
      presence: ["u1", "u2"],
      participants: [
        { userId: "u1", name: "Dana Whitfield", avatarHue: 120, spectator: false },
        { userId: "u2", name: "Ravi Menon", avatarHue: 20, spectator: false },
      ],
      state: { columns: ["went-well"], hidden: "ok-from-statefunc" },
    });
    b.close();
  });

  it("pushes nothing into the frame from a standup room", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    b.close();
  });

  it("pushes nothing into the frame from a poker room", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(envelope({ revealed: false }));
    b.sendState(envelope({ revealed: true }));
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    b.close();
  });

  it("pushes nothing into the frame from another plugin's room", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(
      pluginKindEnvelope({
        plugin: { name: "someone-else", version: "1.0.0", grants: ["session:read"] },
      } as Partial<Envelope>),
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    b.close();
  });

  // A toolbar or export-menu frame is keyed by install name, so the same frame
  // and bridge survive the user walking from the plugin's own room into a
  // standup room. Building no view for the standup room is not enough on its
  // own: the frame would go on holding the retro room's title, roster and
  // board. The host has to say the room is gone.
  it("clears the frame when the user moves from its own room to a standup room", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(pluginKindEnvelope({ title: "Retro 9" }));
    vi.advanceTimersByTime(500);
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    expect(sent.length).toBe(2);
    expect(JSON.parse(sent[1])).toEqual({ type: "state", state: null });
    // And nothing of the standup room came with the clear.
    expect(sent[1]).not.toContain("shipped-the-sso-fix");
    expect(sent[1]).not.toContain("Sprint 42");
    b.close();
  });

  it("hands the frame its own room when the user arrives from a standup room", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    // A frame that never held a room is not sent a clear either.
    expect(sent).toEqual([]);
    b.sendState(pluginKindEnvelope({ title: "Retro 9" }));
    vi.advanceTimersByTime(500);
    expect(sent.length).toBe(1);
    const message = JSON.parse(sent[0]) as { type: string; state: { title: string } };
    expect(message.type).toBe("state");
    expect(message.state.title).toBe("Retro 9");
    b.close();
  });

  it("clears the frame once across two rooms it does not provide", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(pluginKindEnvelope());
    vi.advanceTimersByTime(500);
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    b.sendState(envelope());
    vi.advanceTimersByTime(500);
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    expect(sent.map((s) => (JSON.parse(s) as { state: unknown }).state === null)).toEqual([false, true]);
    b.close();
  });

  // The clear goes through the coalescer, so a view still waiting for the
  // interval when the user leaves is replaced rather than delivered late.
  it("never delivers a pending view of a room the user has already left", () => {
    const sent: string[] = [];
    const { b } = bridge({ send: (body: string) => sent.push(body) });
    b.handshake();
    b.sendState(pluginKindEnvelope({ title: "Retro 9" }));
    b.sendState(standupEnvelope());
    vi.advanceTimersByTime(500);
    expect(sent.join("")).not.toContain("Retro 9");
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
