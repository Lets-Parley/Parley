import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { api } from "../lib/api";
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
      if (path.endsWith("/links")) return { links: [] };
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

// The kind under test is swapped per-case; the mock reads it at render time.
let mockKind = "standup";
// Who the room says is running it. Swapped per-case: the guest-link panel is
// the facilitator's alone.
let mockFacilitatorId = "dana";

vi.mock("../lib/useSession", () => ({
  useSession: () => ({
    data: { ...envelope, kind: mockKind, facilitatorId: mockFacilitatorId },
    isLoading: false,
    isError: false,
    status: "stale",
    refetch: () => {},
  }),
}));

beforeEach(() => {
  mockKind = "standup";
  mockFacilitatorId = "dana";
  localStorage.clear();
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
  });
});

/**
 * A link guest holds a capability to take part in one room and nothing else.
 * Every control it must not see is refused by the server too — the point of
 * these assertions is that it is never offered one that would 403.
 */
// The guest identity is looked up by the room id from the URL, so these cases
// mount the real route rather than the bare page.
const routed = (
  <Routes>
    <Route path="/session/:id" element={<SessionPage />} />
  </Routes>
);

describe("SessionPage for a link guest", () => {
  const guest = { id: "guest-1", name: "Priya Raman", avatarHue: 200 };

  beforeEach(() => {
    localStorage.setItem(
      "parley.link-guest",
      JSON.stringify({
        sessionId: "sess-1",
        me: guest,
        expiresAt: "2099-01-01T10:00:00.000Z",
      }),
    );
  });

  it("says what the link is and when it runs out", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    expect((await screen.findByTestId("link-guest-banner")).textContent).toMatch(/guest link/i);
  });

  it("offers none of the controls a link guest is refused", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");

    // No space breadcrumb, and no other way out into the space.
    expect(document.querySelector('a[href="/s/platform-team"]')).toBe(null);
    // No export, no facilitator controls, no guest-link panel of its own.
    expect(screen.queryByText("Export CSV")).toBe(null);
    expect(screen.queryByRole("button", { name: /end session/i })).toBe(null);
    expect(screen.queryByRole("button", { name: /guest links/i })).toBe(null);
    // And no profile dialog: renaming itself is refused, so it is not offered.
    expect(screen.queryByRole("button", { name: /your profile/i })).toBe(null);
  });

  it("never asks the space route it is refused", async () => {
    // The mock accumulates across this file, so only this render's calls count.
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    const paths = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .slice(before)
      .map(([, path]) => path);
    expect(paths.filter((p) => String(p).startsWith("/api/spaces/"))).toEqual([]);
    expect(paths).not.toContain("/api/me");
  });
});

describe("SessionPage guest-link panel", () => {
  it("is offered to the facilitator", async () => {
    mockFacilitatorId = "marcus";
    renderApp(routed, { route: "/session/sess-1" });
    expect(await screen.findByRole("button", { name: /guest links/i })).toBeTruthy();
  });

  it("is absent for anyone who is not the facilitator", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByRole("button", { name: /your profile/i });
    expect(screen.queryByRole("button", { name: /guest links/i })).toBe(null);
  });
});
