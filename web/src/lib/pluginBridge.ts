import { isActionName, type Envelope, type Person, type Results } from "./api";
import { THEME_TOKENS, type ThemeToken } from "./theme";

/**
 * The host half of the plugin UI bridge.
 *
 * A plugin's UI runs in an iframe sandboxed without `allow-same-origin`, so it
 * has an opaque origin, no cookies, no access to this document, and — under
 * `connect-src 'none'` — no way to reach the network at all. Everything it
 * ever sees arrives here first.
 *
 * # Authentication is by channel identity, not by origin
 *
 * An opaque frame reports its origin as the string `"null"`, and so does every
 * other opaque frame on the page, in another tab, or inside an ad. Checking
 * `event.origin === "null"` therefore proves nothing. The port is the
 * credential instead: one `MessageChannel` is created here, one half is
 * transferred to the frame in the handshake, and after that the host reads
 * nothing from `window.onmessage`. A port is unforgeable and unicast, so a
 * message that arrives on it came from the frame we handed it to.
 *
 * # Redaction happens here, before anything crosses
 *
 * `redactSession` builds the plugin's view field by field rather than deleting
 * fields out of the envelope. A projection that never writes a vote value
 * cannot forget to remove one, which is the same discipline `poker.buildState`
 * holds on the server: before the reveal, vote values are structurally absent
 * rather than filtered.
 */

/**
 * The largest single message either side may send, in bytes of UTF-8.
 *
 * 64 KiB is comfortably more than a session envelope for a room of fifty and
 * comfortably less than a payload that costs a frame to serialise. The cap is
 * on the encoded string because that is the thing that actually crosses, and
 * because measuring it is what stops a plugin wedging the host tab by handing
 * it a megabyte to parse on the main thread.
 *
 * Bytes, not JavaScript string length. A string's `.length` counts UTF-16 code
 * units, and a CJK or emoji-heavy payload is up to three bytes per unit — so a
 * cap read off `.length` was three times the documented budget for exactly the
 * text most likely to be large.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/**
 * Whether a message is over the wire cap.
 *
 * The two length bounds settle almost every message without encoding it at
 * all: a UTF-16 code unit is never fewer than one byte and never more than
 * three, so a string longer than the cap is certainly over it and a string a
 * third of the cap is certainly under. Only the band between them is encoded,
 * which keeps the inbound check cheaper than the parse it exists to avoid.
 */
export function overMessageCap(body: string): boolean {
  if (body.length > MAX_MESSAGE_BYTES) return true;
  if (body.length * 3 <= MAX_MESSAGE_BYTES) return false;
  return encoder.encode(body).length > MAX_MESSAGE_BYTES;
}

/**
 * The most messages a plugin may send per second.
 *
 * Real plugin UI sends a message per user gesture; 30 is an order of magnitude
 * above any human and an order of magnitude below a busy loop. Exceeding it is
 * treated as a fault rather than throttled, because a plugin that floods is
 * either broken or hostile and both want the same answer.
 */
export const MAX_MESSAGES_PER_SECOND = 30;

/**
 * The floor between two state pushes into the frame, in milliseconds.
 *
 * This is the host's own half of the bound: a room in a fast round can change
 * state many times a second, and re-serialising the envelope each time would
 * let the room's traffic — not the plugin's — become the load. Pushes coalesce
 * and the newest state wins, so the frame is never shown a stale frame it
 * cannot recover from.
 */
export const STATE_PUSH_INTERVAL_MS = 100;

/** How long the frame has to answer the handshake before it is given up on. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Why a bridge stopped trusting its frame. */
export type BridgeFailure =
  "handshake-timeout" | "oversize" | "oversize-outbound" | "flood" | "ungranted" | "malformed";

/** A participant, as a plugin sees one. */
export type PluginPerson = Pick<Person, "userId" | "name" | "avatarHue" | "spectator">;

/** One story, as a plugin sees it. Vote values appear only after the reveal. */
export type PluginStory = {
  id: string;
  title: string;
  estimate: string | null;
  status: string;
  votedUserIds: string[];
  votes?: { userId: string; value: string }[];
  results?: Results;
};

/** The whole of what a plugin is ever told about a session. */
export type PluginSession = {
  id: string;
  kind: string;
  title: string;
  phase: string;
  revealed: boolean;
  version: number;
  facilitatorId: string;
  endedAt: string | null;
  presence: string[];
  participants: PluginPerson[];
  /**
   * Poker panels get the poker projection. A plugin-owned kind gets the
   * document its StateFunc already built — still only after session:read.
   */
  state: unknown;
};

function pokerState(env: Envelope, revealed: boolean): {
  currentStoryId: string | null;
  deck: { name: string; values: string[]; ordinal: boolean };
  stories: PluginStory[];
} {
  return {
    currentStoryId: env.state?.currentStoryId ?? null,
    deck: {
      name: env.state?.deck?.name ?? "",
      values: [...(env.state?.deck?.values ?? [])],
      ordinal: env.state?.deck?.ordinal ?? false,
    },
    stories: (env.state?.stories ?? []).map((s) => {
      const story: PluginStory = {
        id: s.id,
        title: s.title,
        estimate: s.estimate,
        status: s.status,
        votedUserIds: [...s.votedUserIds],
      };
      if (revealed && s.votes) {
        story.votes = s.votes.map((v) => ({
          userId: v.userId,
          value: v.value,
        }));
      }
      if (revealed && s.results) story.results = s.results;
      return story;
    }),
  };
}

/** The grant that lets a plugin see session state at all. */
export const GRANT_SESSION_READ = "session:read";
/** The grant that lets a plugin propose an action the host then performs. */
export const GRANT_SESSION_ACT = "session:act";

/**
 * The plugin's view of a session, built from the envelope a grant at a time.
 *
 * Returns null when the plugin holds no `session:read` grant: no grant means
 * no state, not a smaller state.
 *
 * Hidden votes are the reason this is a projection rather than a filter. The
 * `votes` and `results` fields are written only when the round is revealed, so
 * a pre-reveal value has no path into the returned object — there is nothing
 * to strip and therefore nothing to forget to strip.
 */
export function redactSession(env: Envelope, grants: readonly string[]): PluginSession | null {
  if (!grants.includes(GRANT_SESSION_READ)) return null;
  const revealed = env.revealed === true;
  return {
    id: env.id,
    kind: env.kind,
    title: env.title,
    phase: env.phase,
    revealed,
    version: env.version,
    facilitatorId: env.facilitatorId,
    endedAt: env.endedAt,
    presence: [...env.presence],
    // Nothing about the space or the org: which team a room belongs to is not
    // the plugin's business, and the envelope carries it for the app's routing.
    participants: env.participants.map((p) => ({
      userId: p.userId,
      name: p.name,
      avatarHue: p.avatarHue,
      spectator: p.spectator,
    })),
    // Poker shares its envelope with nested panels, so hidden votes have to
    // be projected here. A plugin-owned kind's StateFunc already decided what
    // is client-safe; rewriting that as poker stories would empty the room.
    state: env.kind === "poker" ? pokerState(env, revealed) : (env.state ?? {}),
  };
}

/** The design tokens as the frame receives them: name to colour, nothing else. */
export function currentTokens(root: HTMLElement = document.documentElement): Record<string, string> {
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS as readonly ThemeToken[]) {
    const value = computed.getPropertyValue(`--color-${token}`).trim();
    if (value) tokens[token] = value;
  }
  return tokens;
}

/**
 * A per-plugin crash breaker.
 *
 * A plugin whose frame keeps dying is not retried forever: after `limit`
 * crashes inside `windowMs` the panel stops reloading it and says so. The
 * window slides, so a plugin that crashed twice last hour starts today with a
 * clean slate.
 */
export class CrashBreaker {
  private readonly crashes: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit = 3, windowMs = 60_000, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  crashed(): void {
    this.crashes.push(this.now());
  }

  open(): boolean {
    const cutoff = this.now() - this.windowMs;
    while (this.crashes.length && this.crashes[0] < cutoff) this.crashes.shift();
    return this.crashes.length >= this.limit;
  }

  reset(): void {
    this.crashes.length = 0;
  }
}

export type PluginBridgeOptions = {
  /** The frame's `contentWindow`. The handshake is the only thing sent to it. */
  target: Window;
  grants: readonly string[];
  /**
   * Performs an action the plugin proposed, using the user's own session. The
   * plugin never sees a credential, and can only ask for what the user could
   * already do — the server re-checks every one of them.
   */
  onAction: (action: string, payload: unknown) => Promise<unknown>;
  onFailure: (reason: BridgeFailure) => void;
  handshakeTimeoutMs?: number;
  /** Overridden in tests; by default the port does the sending. */
  send?: (body: string) => void;
};

export type PluginBridge = {
  /** Transfers the port. Called once, on frame load. */
  handshake: () => void;
  /** Pushes redacted state into the frame, coalesced. */
  sendState: (env: Envelope) => void;
  /** Pushes the current design tokens so plugin UI re-themes with the app. */
  sendTokens: (tokens: Record<string, string>) => void;
  /** Test seam: feed one raw inbound message as the port would. */
  receive: (body: unknown) => void;
  close: () => void;
};

export function createPluginBridge(opts: PluginBridgeOptions): PluginBridge {
  const channel = new MessageChannel();
  let closed = false;
  let shook = false;
  let pending: string | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const stamps: number[] = [];

  const timeout = setTimeout(() => {
    if (!shook) {
      // An explicit failure, never a blank rectangle: the panel renders a card
      // saying the plugin did not answer.
      opts.onFailure("handshake-timeout");
    }
  }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);

  const send =
    opts.send ??
    ((body: string) => {
      channel.port1.postMessage(body);
    });

  function post(message: unknown, failure: BridgeFailure): void {
    if (closed) return;
    const body = JSON.stringify(message);
    if (overMessageCap(body)) {
      opts.onFailure(failure);
      return;
    }
    send(body);
  }

  function receive(raw: unknown): void {
    if (closed) return;
    if (typeof raw !== "string") {
      opts.onFailure("malformed");
      return;
    }
    if (overMessageCap(raw)) {
      // Dropped before parsing. Parsing is the expensive half, so a cap that
      // only ran afterwards would not bound anything.
      opts.onFailure("oversize");
      return;
    }
    const now = Date.now();
    while (stamps.length && stamps[0] <= now - 1000) stamps.shift();
    if (stamps.length >= MAX_MESSAGES_PER_SECOND) {
      opts.onFailure("flood");
      close();
      return;
    }
    stamps.push(now);

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      opts.onFailure("malformed");
      return;
    }
    if (!message || typeof message !== "object") {
      opts.onFailure("malformed");
      return;
    }
    const { type, action, payload } = message as Record<string, unknown>;
    if (type === "hello" || type === "ready") return;
    if (type !== "act" || typeof action !== "string") {
      opts.onFailure("malformed");
      return;
    }
    // The name the frame sent becomes a path segment. Unscreened it is a path
    // expression rather than a name: "../../../me" is normalised out of
    // /api/sessions/{id}/actions/ by the same URL parser fetch uses, and the
    // request that results carries the user's own cookie, is genuinely
    // same-origin, and lands outside the only route group that audits plugin
    // actions. So the name is screened here, before it reaches onAction, and
    // a name that is not a plain action name is malformed input like any
    // other — it is not a capability refusal, because no capability would
    // have permitted it.
    if (!isActionName(action)) {
      opts.onFailure("malformed");
      return;
    }
    if (!opts.grants.includes(GRANT_SESSION_ACT)) {
      // The grant is checked here, on the host side, because this is the only
      // side that can be trusted to check it.
      opts.onFailure("ungranted");
      return;
    }
    void opts.onAction(action, payload ?? {});
  }

  // The pending push is held as the finished body rather than as the envelope.
  // Redacting and serialising is the expensive half, the size check needs the
  // finished string anyway, and doing it once per sendState rather than once
  // for the check and again at the flush is the difference between one pass
  // over the envelope and three.
  function flush(): void {
    pushTimer = null;
    const body = pending;
    pending = null;
    if (body === null || closed) return;
    send(body);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (pushTimer) clearTimeout(pushTimer);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  }

  channel.port1.onmessage = (event: MessageEvent) => receive(event.data);
  channel.port1.start();

  return {
    handshake() {
      if (shook || closed) return;
      shook = true;
      clearTimeout(timeout);
      // "*" is the only target origin an opaque frame can be addressed by, and
      // it is safe precisely because the payload is a port and nothing else:
      // there is no secret in this message to misdirect.
      opts.target.postMessage({ parley: "bridge" }, "*", [channel.port2]);
    },
    sendState(env: Envelope) {
      if (closed) return;
      const session = redactSession(env, opts.grants);
      if (!session) return;
      const body = JSON.stringify({ type: "state", state: session });
      if (overMessageCap(body)) {
        opts.onFailure("oversize-outbound");
        pending = null;
        return;
      }
      // Coalescing: the newest state wins and at most one push lands per
      // interval, so a busy room cannot become the frame's load. Newest, not
      // oldest — a frame left holding a superseded round has no way to know
      // it is stale.
      pending = body;
      if (pushTimer) return;
      pushTimer = setTimeout(flush, STATE_PUSH_INTERVAL_MS);
    },
    sendTokens(tokens: Record<string, string>) {
      post({ type: "tokens", tokens }, "oversize-outbound");
    },
    receive,
    close,
  };
}

/**
 * The path a plugin's sandbox document is served from. It is the one route on
 * this instance that is allowed to be framed — see internal/api/pluginframe.go.
 */
export function pluginFramePath(name: string, version: string): string {
  return `/plugin-ui/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

/**
 * The sandbox attribute, spelled out once so it is impossible to widen by
 * accident.
 *
 * `allow-scripts` and nothing else. `allow-same-origin` is the attribute that
 * would undo the whole thing: with it the frame shares this document's origin,
 * which means cookies, the API as the user, and a monkey-patchable fetch — a
 * grant it can bypass in three lines. Without it the frame gets an opaque
 * origin without needing a second HTTP origin to serve it from.
 */
export const PLUGIN_SANDBOX = "allow-scripts";
