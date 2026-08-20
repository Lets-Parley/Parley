export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

export type Me = { id: string; name: string; avatarHue: number };
/** Where a member currently has a socket open, within this space only. */
export type SeatRef = { sessionId: string; title: string };
export type Person = {
  userId: string;
  name: string;
  avatarHue: number;
  spectator: boolean;
  /** Space standing. Absent in session payloads, which do not carry roles. */
  role?: SpaceRole;
  at?: SeatRef;
};
export type SpaceRole = "owner" | "member";
export type SpaceView = {
  slug: string;
  name: string;
  /** Whether joining needs the room code. Visible to strangers so the gate knows. */
  protected: boolean;
  /** The room code itself — only ever present for members. */
  passcode?: string;
  members?: Person[];
  sessions?: SessionSummary[];
  /** The kinds a new session may use — retired kinds are omitted. Members only. */
  kinds?: string[];
};
export type SessionSummary = {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  endedAt: string | null;
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
  participants: Person[];
  serverTime: string;
  state: PokerState;
};

/**
 * The verb each action answers on. Most actions are transitions on the session
 * and take POST; the two that are not say so — a standup entry is an upsert of
 * the caller's own row (PUT) and a story edit is a partial update (PATCH). The
 * server routes on (verb, action) and answers 405 for the wrong one, so this
 * table has to match internal/session's registry.
 */
const actionVerbs: Record<string, string> = { standup: "PUT", story: "PATCH" };

/**
 * Every kind-specific write goes through one server route:
 * /api/sessions/{id}/actions/{name}, sent with the verb that action declares.
 * Core routes a kind does not own — close, reopen, spectator, facilitator, the
 * CSV export — are not actions and keep their own paths.
 */
export function action<T = unknown>(sessionId: string, name: string, body?: unknown): Promise<T> {
  return api<T>(actionVerbs[name] ?? "POST", `/api/sessions/${sessionId}/actions/${name}`, body);
}
