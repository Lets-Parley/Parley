import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      if (path === "/api/me") return apiMeResponse;
      if (path === "/api/auth") return { mode: "open" };
      if (path.startsWith("/api/spaces/")) return { name: "Platform Team", members: [], sessions: [] };
      if (path.endsWith("/links")) return { links: [] };
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

// What GET /api/me answers. Swapped per-case: a link guest whose storage is
// gone recovers its identity from exactly this route.
let apiMeResponse: Me = me;
// The kind under test is swapped per-case; the mock reads it at render time.
let mockKind = "standup";
// Who the room says is running it. Swapped per-case: the guest-link panel is
// the facilitator's alone.
let mockFacilitatorId = "dana";
// The room state is kind-shaped (poker carries stories/deck, standup carries
// entries) — swapped alongside mockKind so a poker render gets poker state.
let mockState: unknown = envelope.state;

vi.mock("../lib/useSession", () => ({
  useSession: () => ({
    data: { ...envelope, kind: mockKind, facilitatorId: mockFacilitatorId, state: mockState },
    isLoading: false,
    isError: false,
    status: "stale",
    refetch: () => {},
  }),
}));

beforeEach(() => {
  mockKind = "standup";
  mockFacilitatorId = "dana";
  mockState = envelope.state;
  apiMeResponse = me;
  localStorage.clear();
  sessionStorage.clear();
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

// Poker's guest guards (isFacilitator, canSpectate, Export CSV) only fire on
// poker's own state shape — a standup fixture never exercises them, so this
// mirrors the standup fixture with a poker-shaped state alongside it.
const pokerState = {
  deck: { name: "fibonacci", values: ["1", "2", "3", "5", "8"], ordinal: false },
  currentStoryId: "story-1",
  stories: [
    {
      id: "story-1",
      ref: "PLAT-412",
      title: "Rate-limit the join endpoint",
      notes: "",
      position: 1,
      estimate: null,
      status: "voting",
      votedUserIds: [],
    },
  ],
};

describe.each([
  ["standup", envelope.state],
  ["poker", pokerState],
])("SessionPage for a link guest (%s)", (kind, state) => {
  const guest = { id: "guest-1", name: "Priya Raman", avatarHue: 200 };

  beforeEach(() => {
    mockKind = kind;
    mockState = state;
    sessionStorage.setItem(
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

  // Split into one assertion per control (rather than one packed it()) so a
  // regression report names which control broke instead of just the first.
  it("has no space breadcrumb, or other way out into the space", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(document.querySelector('a[href="/s/platform-team"]')).toBe(null);
  });

  it("offers no export", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByText("Export CSV")).toBe(null);
  });

  it("offers no end-session control", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByRole("button", { name: /end session/i })).toBe(null);
  });

  it("offers no guest-links panel of its own", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByRole("button", { name: /guest links/i })).toBe(null);
  });

  it("offers no profile dialog — renaming itself is refused, so it is not offered", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByRole("button", { name: /your profile/i })).toBe(null);
  });

  it("offers no sidebar toggle either", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBe(null);
  });

  // A guest link is aimed at someone on a borrowed or shared machine, so the
  // seat has to be droppable on purpose: closing the tab leaves the HttpOnly
  // cookie valid for the whole life of the link.
  it("can leave the room, which spends the credential and strands nothing", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    await userEvent.click(screen.getByRole("button", { name: /leave room/i }));

    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some((c) => c[0] === "DELETE" && c[1] === "/api/me"),
      ).toBe(true),
    );
    // A dead link, not a seat — and the cached identity goes with it, so a
    // reload cannot paint the room back from session storage.
    expect(await screen.findByText(/no seat at this table/i)).toBeTruthy();
    expect(screen.queryByTestId("link-guest-banner")).toBe(null);
    expect(sessionStorage.getItem("parley.link-guest")).toBe(null);
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

/**
 * Local storage is a cache, not the identity. A guest in a private window, on a
 * second device, or after clearing site data holds a live cookie and nothing
 * else — and used to be dropped into the name gate, whose POST the server then
 * refuses to a link principal. That was a screen with no way out.
 */
describe("SessionPage for a link guest whose storage was cleared", () => {
  const linkMe: Me = {
    id: "guest-1",
    name: "Priya Raman",
    avatarHue: 200,
    linkSessionId: "sess-1",
    linkExpiresAt: "2099-01-01T10:00:00.000Z",
  };

  beforeEach(() => {
    // Nothing remembered — exactly what a cleared browser looks like.
    localStorage.clear();
    sessionStorage.clear();
    apiMeResponse = linkMe;
  });

  it("lands in the room rather than the name gate", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    expect(await screen.findByTestId("link-guest-banner")).toBeTruthy();
    expect(screen.queryByText(/What should we call you\?/i)).toBe(null);
  });

  // The shared-machine story, pinned as it actually behaves rather than as the
  // seat guarantee was once written. Session storage is tab-scoped, so a closed
  // tab does take the cached name and hue with it — but the HttpOnly cookie is
  // scoped to the *browsing session*, not the tab, so it survives as long as
  // any window of that browser stays open. The next person to open the room URL
  // is recovered into the same seat from the cookie alone. Only closing the
  // whole browser, or clicking Leave room, actually ends it.
  //
  // Limitation named, per the issue: real cookie lifetime is a browser
  // behaviour neither jsdom nor Go's httptest can evaluate. What this pins is
  // the half that is ours — an empty session storage is not by itself enough to
  // unseat a guest.
  it("is reseated from the cookie alone when the tab's storage is gone", async () => {
    expect(sessionStorage.getItem("parley.link-guest")).toBe(null);
    renderApp(routed, { route: "/session/sess-1" });

    await screen.findByTestId("link-guest-banner");
    // It asked the server who it is, and was seated as the same guest.
    expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(true);
    expect(screen.queryByText(/What should we call you\?/i)).toBe(null);
  });

  it("still shows no facilitator or space controls", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    expect(screen.queryByRole("button", { name: /your profile/i })).toBe(null);
    expect(screen.queryByRole("button", { name: /guest links/i })).toBe(null);
    expect(document.querySelector('a[href="/s/platform-team"]')).toBe(null);
  });

  it("says when the seat runs out, from the server's own expiry", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    const banner = await screen.findByTestId("link-guest-banner");
    expect(banner.textContent).toMatch(
      new RegExp(new Date(linkMe.linkExpiresAt!).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  // A guest link is aimed at someone on a borrowed or shared machine, so the
  // seat has to be droppable on purpose: closing the tab leaves the HttpOnly
  // cookie valid for the whole life of the link.
  it("can leave the room, which spends the credential and strands nothing", async () => {
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    await userEvent.click(screen.getByRole("button", { name: /leave room/i }));

    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some((c) => c[0] === "DELETE" && c[1] === "/api/me"),
      ).toBe(true),
    );
    // A dead link, not a seat — and the cached identity goes with it, so a
    // reload cannot paint the room back from session storage.
    expect(await screen.findByText(/no seat at this table/i)).toBeTruthy();
    expect(screen.queryByTestId("link-guest-banner")).toBe(null);
    expect(sessionStorage.getItem("parley.link-guest")).toBe(null);
  });

  it("never asks the space route it is refused", async () => {
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/session/sess-1" });
    await screen.findByTestId("link-guest-banner");
    const paths = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .slice(before)
      .map(([, path]) => path);
    expect(paths.filter((p) => String(p).startsWith("/api/spaces/"))).toEqual([]);
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
