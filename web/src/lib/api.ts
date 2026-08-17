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
  at?: SeatRef;
};
export type SpaceView = {
  slug: string;
  name: string;
  members?: Person[];
  sessions?: SessionSummary[];
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
