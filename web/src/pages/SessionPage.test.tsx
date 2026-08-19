import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";
import { SessionPage } from "./SessionPage";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

const envelope: Envelope = {
  id: "sess-1",
  kind: "standup",
  title: "Daily",
  phase: "speaking",
  revealed: false,
  version: 1,
  facilitatorId: "dana",
  facilitatorConnected: true,
  endedAt: null,
  presence: ["marcus"],
  spaceSlug: "platform-team",
  participants: [{ userId: "dana", name: "Dana Whitfield", avatarHue: 120, spectator: false }],
  serverTime: "2026-08-18T10:00:00.000Z",
  state: {
    entries: [{ userId: "dana", yesterday: "", today: "", blockers: "", position: 1, skipped: false }],
    currentSpeakerId: "dana",
    speakerStartedAt: "2026-08-18T10:00:00.000Z",
    secondsPerPerson: 90,
  },
} as unknown as Envelope;

// api() is called by useMe, the sidebar space query, and AppShell's auth-mode
// query. Only the session's own connection status matters for this test, so
// every other call is answered with a harmless stand-in.
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.startsWith("/api/spaces/")) return { name: "Platform Team", members: [], sessions: [] };
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

// The kind under test is swapped per-case; the mock reads it at render time.
let mockKind = "standup";

vi.mock("../lib/useSession", () => ({
  useSession: () => ({
    data: { ...envelope, kind: mockKind },
    isLoading: false,
    isError: false,
    status: "stale",
    refetch: () => {},
  }),
}));

beforeEach(() => {
  mockKind = "standup";
});

describe("SessionPage wiring", () => {
  it("passes the live connection status through to the room, so a stale link stays silent", async () => {
    renderApp(<SessionPage />);
    // StandupRoom's announcer defaults to "live" when no status prop is wired
    // through — this pins that SessionPage actually threads its own status
    // rather than relying on that permissive default.
    // The connection banner also carries role="status", so pick out the
    // turn announcer specifically — the sr-only <p>.
    const announcer = () =>
      screen.getAllByRole("status").find((el) => el.tagName === "P")!;
    await waitFor(() => expect(announcer()).toBeTruthy());
    expect(announcer().textContent).toBe("");
  });

  // The kind fan-out used to be a ternary whose else-branch was standup, so a
  // session of any unrecognised kind silently rendered the standup room —
  // wrong controls, wrong actions, against real session state.
  it("renders no room at all for a kind it does not know", async () => {
    mockKind = "acme.retro";
    renderApp(<SessionPage />);
    expect(await screen.findByText(/doesn't know how to open/i)).toBeTruthy();
    // "yesterday" is a StandupRoom-only field label.
    expect(screen.queryByText("yesterday")).toBe(null);
  });
});
