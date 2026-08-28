export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A request that never reached the server at all.
 *
 * It extends TypeError because that is what `fetch` itself rejects with, so a
 * caller that discriminates on TypeError keeps working — but it is a distinct
 * type, which is what lets errorText tell a dead connection apart from an
 * ordinary TypeError thrown by our own code further up the call.
 */
export class NetworkError extends TypeError {}

/**
 * The user-facing text for anything `api()` throws.
 *
 * A transport failure carries the browser's own wording — "Failed to fetch" in
 * Chrome, "Load failed" in Safari — which is neither actionable nor consistent,
 * so it is replaced here rather than rendered. Everything else keeps its own
 * message: the server writes those, and they are already written for a reader.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return "Can't reach the server — check your connection and try again.";
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Offline, DNS failure, TLS refusal, the server simply gone. Retagged so
    // the browser's own wording never reaches a screen.
    throw new NetworkError(e instanceof Error ? e.message : "network failure");
  }
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!resp.ok) {
    const msg =
      (data as { error?: string } | undefined)?.error ?? "Something went wrong talking to the server.";
    throw new ApiError(resp.status, msg);
  }
  return data as T;
}

/** avatarIcon is a client-side id, opaque to the server; empty means unset. */
export type Me = {
  id: string;
  name: string;
  avatarHue: number;
  avatarIcon?: string;
  /**
   * Set only for a link guest: the one room this identity may take part in,
   * and when its seat runs out. Absent for an ordinary account, so their
   * presence is what says "this is a link identity" when nothing local does.
   */
  linkSessionId?: string;
  linkExpiresAt?: string;
};
/** Where a member currently has a socket open, within this space only. */
export type SeatRef = { sessionId: string; title: string };
export type Person = {
  userId: string;
  name: string;
  avatarHue: number;
  /** Chosen icon id, opaque to the server. Empty or unknown renders initials. */
  avatarIcon?: string;
  /** Chosen accessory id, opaque to the server. Empty or unknown draws nothing. */
  spectator: boolean;
  /** Seated by a signed link rather than by membership. Set by the server:
      a guest may pick any display name, a member's included. */
  guest?: boolean;
  /** Space standing. Absent in session payloads, which do not carry roles. */
  role?: SpaceRole;
  at?: SeatRef;
};
export type SpaceRole = "owner" | "member";
export type SpaceView = {
  slug: string;
  name: string;
  /** Whether joining needs the passcode. Visible to strangers so the gate knows. */
  protected: boolean;
  /** The passcode itself — only ever present for members. */
  passcode?: string;
  members?: Person[];
  sessions?: SessionSummary[];
  /** Whether the space is listed in its org's directory. Members only — a
      stranger at the door is not told whether the room is listed. Governs
      discovery, never entry: a listed space with a passcode still asks. */
  visibility?: "private" | "org";
  /** Present on create only: where the new space lives. */
  orgSlug?: string;
  /** The kinds a new session may use — retired kinds are omitted. Members only. */
  kinds?: string[];
};
/** One space the caller belongs to, as listed on the landing page. */
export type Membership = {
  slug: string;
  name: string;
  /** The org segment of the space's URL — a slug alone no longer resolves. */
  orgSlug: string;
  protected: boolean;
};
/**
 * One space in an org's directory.
 *
 * The list holds every org-visible space plus the ones the caller belongs to,
 * so a `private` row is always one they are already in. There is deliberately
 * no passcode here: this is a list of doors, not a room anyone has entered.
 */
export type OrgSpace = {
  slug: string;
  name: string;
  visibility: "private" | "org";
  /** Whether the door needs a passcode. Org visibility governs being listed,
      never being let in, so a listed space can still be locked. */
  protected: boolean;
  /** Whether the caller is already a member. */
  member: boolean;
};
/**
 * One page of an org's directory.
 *
 * `next` is an opaque cursor to hand back as `after`, absent once the list has
 * been read to its end. It is a position and not a page number, so a space
 * created or archived while somebody is reading cannot make the next page skip
 * a room or show one twice.
 */
export type OrgSpacePage = {
  spaces: OrgSpace[];
  next?: string;
};
/** One org the caller belongs to, as the switcher lists them. */
export type OrgMembership = {
  slug: string;
  name: string;
  role: "admin" | "member";
};
export type SessionSummary = {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  endedAt: string | null;
  /** People with a socket open on this session right now. Always 0 once ended. */
  here: number;
};
export type HistogramRow = { value: string; count: number };
export type Results = {
  histogram: HistogramRow[];
  average?: number;
  median?: number;
  mode?: string;
  range?: string;
  consensus: boolean;
};
export type Story = {
  id: string;
  /** Ticket reference in the team's tracker; empty for an ad-hoc round. */
  ref: string;
  title: string;
  notes: string;
  position: number;
  estimate: string | null;
  status: "pending" | "voting" | "estimated";
  votedUserIds: string[];
  votes?: { userId: string; value: string }[];
  results?: Results;
};
export type PokerState = {
  deck: { name: string; values: string[]; ordinal: boolean };
  /** When true, the last eligible vote opens the round. Default false. */
  autoReveal: boolean;
  currentStoryId: string | null;
  stories: Story[];
};
export type Envelope = {
  id: string;
  kind: string;
  title: string;
  phase: string;
  revealed: boolean;
  version: number;
  facilitatorId: string;
  facilitatorConnected: boolean;
  facilitatorOfflineSince?: string;
  endedAt: string | null;
  presence: string[];
  spaceSlug: string;
  /** The space's org. Empty for a link guest, along with spaceSlug. */
  orgSlug: string;
  participants: Person[];
  serverTime: string;
  state: PokerState;
};

/**
 * The verb each action answers on. Most actions are transitions on the session
 * and take POST; the ones that are not say so here — standup/ready are upserts
 * (PUT), story and poker config are partial updates (PATCH). The server routes
 * on (verb, action) and answers 405 for the wrong one, so this table has to
 * match internal/session's registry.
 */
const actionVerbs: Record<string, string> = {
  standup: "PUT",
  ready: "PUT",
  story: "PATCH",
  config: "PATCH",
};

/**
 * Every kind-specific write goes through one server route:
 * /api/sessions/{id}/actions/{name}, sent with the verb that action declares.
 * Core routes a kind does not own — close, reopen, spectator, facilitator, the
 * CSV export — are not actions and keep their own paths.
 */
export function action<T = unknown>(sessionId: string, name: string, body?: unknown): Promise<T> {
  return api<T>(actionVerbs[name] ?? "POST", `/api/sessions/${sessionId}/actions/${name}`, body);
}
