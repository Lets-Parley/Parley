import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, type Envelope } from "../lib/api";
import { MeetMainStage, MeetSidePanel } from "./MeetAddon";

const SDK = "https://www.gstatic.com/meetjs/addons/1.1.0/meet.addons.js";
/** A session id as the server mints them: a UUID. */
const SID = "0b6f3e2a-8c1d-4f5e-9a7b-2c3d4e5f6a7b";
const meetRow = { name: "meet", label: "Google Meet", sdkScript: SDK, cloudProjectNumber: "123" };

function envelope(facilitatorId: string): Envelope {
  return {
    id: SID,
    kind: "poker",
    title: "Sprint 12",
    phase: "voting",
    revealed: false,
    version: 1,
    facilitatorId,
    facilitatorConnected: true,
    endedAt: null,
    presence: ["ada"],
    orgSlug: "acme",
    spaceSlug: "platform",
    participants: [{ userId: "ada", name: "Ada", avatarHue: 1, spectator: false }],
    serverTime: "2026-09-22T10:00:00Z",
    state: {
      deck: { name: "fib", values: ["1", "2", "3"], ordinal: false },
      autoReveal: false,
      openVoting: false,
      currentStoryId: "st1",
      stories: [
        {
          id: "st1",
          ref: "",
          title: "Rate-limit the join endpoint",
          notes: "",
          position: 1,
          estimate: null,
          status: "voting",
          votedUserIds: [],
        },
      ],
    },
  };
}

let calls: { url: string; init: RequestInit }[];
let sockets: { url: string; protocols?: string | string[] }[];
let startActivity: ReturnType<typeof vi.fn>;
let providers: (typeof meetRow)[];
let facilitator = "ada";
let startingData: string | undefined;

function respond(url: string, method: string): unknown {
  if (url === "/api/auth") return { mode: "open", embedProviders: providers };
  if (url === "/api/me") return { id: "ada", name: "Ada", avatarHue: 1 };
  if (url === "/api/spaces") return [{ slug: "platform", name: "Platform", orgSlug: "acme", protected: false }];
  if (url === "/api/orgs/acme/spaces/platform")
    return {
      slug: "platform",
      name: "Platform",
      protected: false,
      members: [],
      sessions: [{ id: SID, kind: "poker", title: "Sprint 12", createdAt: "", endedAt: null, here: 1 }],
    };
  if (url === `/api/sessions/${SID}`) return envelope(facilitator);
  if (url === "/api/embed/handoff") return { displayCode: "ABC-123", signinPath: "/embed/signin?c=xyz" };
  if (url === "/api/embed/session") return { token: "fresh" };
  if (url.endsWith("/actions/vote") && method === "POST") return undefined;
  throw new Error(`unexpected ${method} ${url}`);
}

beforeEach(() => {
  sessionStorage.clear();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
  calls = [];
  sockets = [];
  providers = [meetRow];
  facilitator = "ada";
  startingData = JSON.stringify({ sessionId: SID });
  startActivity = vi.fn(() => Promise.resolve());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = respond(url, init.method ?? "GET");
      return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string, protocols?: string | string[]) {
        sockets.push({ url, protocols });
      }
      close() {}
    },
  );
  vi.stubGlobal("meet", {
    addon: {
      createAddonSession: vi.fn(async () => ({
        createSidePanelClient: async () => ({ startActivity }),
        createMainStageClient: async () => ({
          getActivityStartingState: async () => ({ additionalData: startingData }),
        }),
      })),
    },
  });
});

/** jsdom never fetches a script, so the test plays the browser's part. */
async function loadSDK() {
  const script = await waitFor(() => {
    const s = document.head.querySelector<HTMLScriptElement>(`script[src="${SDK}"]`);
    if (!s) throw new Error("the SDK was never added");
    return s;
  });
  script.dispatchEvent(new Event("load"));
}

async function openRoom() {
  fireEvent.click(await screen.findByRole("button", { name: "Platform" }));
  fireEvent.click(await screen.findByRole("button", { name: /Sprint 12/ }));
  await screen.findByRole("heading", { name: "Rate-limit the join endpoint" });
}

describe("Meet side panel", () => {
  beforeEach(() => sessionStorage.setItem("parley.embed.token", "tok"));

  it("uses the bearer, never the cookie, for every fetch and the socket", async () => {
    renderApp(<MeetSidePanel />);
    await loadSDK();
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/actions/vote"))).toBe(true));
    for (const c of calls) {
      expect(c.init.credentials, c.url).toBe("omit");
      expect((c.init.headers as Record<string, string>).Authorization, c.url).toBe("Bearer tok");
    }
    expect(sockets.length).toBeGreaterThan(0);
    for (const s of sockets) expect(s.protocols).toEqual(["parley.embed", "tok"]);
  });

  it("sends the bearer on its very first fetch and puts the cookie back when it unmounts", async () => {
    const page = renderApp(<MeetSidePanel />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // Children's effects run before their parent's, so a bearer installed by
    // an ordinary effect in the page would let this first request go out
    // with the cookie instead.
    expect(calls[0].init.credentials, calls[0].url).toBe("omit");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    await screen.findByRole("button", { name: "Platform" });
    page.unmount();
    calls = [];
    await api("GET", "/api/me");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("lets the facilitator start the main stage on this room", async () => {
    renderApp(<MeetSidePanel />);
    await loadSDK();
    await openRoom();
    fireEvent.click(await screen.findByRole("button", { name: "Show on main stage" }));
    expect(startActivity).toHaveBeenCalledWith({
      mainStageUrl: `${location.origin}/embed/meet/mainstage`,
      additionalData: JSON.stringify({ sessionId: SID }),
    });
  });

  it("gives a non-facilitator no start control", async () => {
    facilitator = "someone-else";
    renderApp(<MeetSidePanel />);
    await loadSDK();
    await openRoom();
    expect(screen.queryByRole("button", { name: "Show on main stage" })).toBeNull();
  });

  it("never references the SDK when Meet is not enabled", async () => {
    providers = [];
    renderApp(<MeetSidePanel />);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth")).toBe(true));
    await screen.findByRole("button", { name: "Platform" });
    expect(document.head.querySelector("script[src*='gstatic']")).toBeNull();
  });
});

describe("Meet sign-in", () => {
  it("opens the sign-in page from the click itself and falls back to the URL", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    renderApp(<MeetSidePanel />);
    await screen.findByText("ABC-123");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(open).toHaveBeenCalledWith("/embed/signin?c=xyz", "_blank");
    expect(screen.getByText(`${location.origin}/embed/signin?c=xyz`)).toBeTruthy();
    await waitFor(() => expect(sessionStorage.getItem("parley.embed.token")).toBe("fresh"), { timeout: 4000 });
    expect(localStorage.length).toBe(0);
  });

  it("cuts the sign-in tab's way back to the frame", async () => {
    const tab = { opener: window as unknown };
    vi.stubGlobal("open", vi.fn(() => tab));
    renderApp(<MeetSidePanel />);
    await screen.findByText("ABC-123");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(tab.opener).toBeNull();
    expect(screen.queryByText(/blocked the new tab/)).toBeNull();
  });

  it("has no axe violations at 320px", async () => {
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = renderApp(<MeetSidePanel />);
    await screen.findByText("ABC-123");
    await expectNoViolations(container);
    sessionStorage.setItem("parley.embed.token", "tok");
    const signedIn = renderApp(<MeetSidePanel />);
    await loadSDK();
    fireEvent.click(await screen.findByRole("button", { name: "Platform" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sprint 12/ }));
    await screen.findByRole("group", { name: "Your vote" });
    await expectNoViolations(signedIn.container);
  });
});

describe("Meet main stage", () => {
  it("renders the presenter view of the room the facilitator shared", async () => {
    sessionStorage.setItem("parley.embed.token", "tok");
    renderApp(<MeetMainStage />);
    await loadSDK();
    expect(await screen.findByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(calls.find((c) => c.url === `/api/sessions/${SID}`)?.init.credentials).toBe("omit");
  });

  for (const crafted of ["../me", "x?y", "../../api/me#", 42, { toString: () => SID }]) {
    it(`never turns a crafted sessionId (${JSON.stringify(crafted)}) into a request`, async () => {
      sessionStorage.setItem("parley.embed.token", "tok");
      startingData = JSON.stringify({ sessionId: crafted });
      renderApp(<MeetMainStage />);
      await loadSDK();
      await screen.findByText(/No room was shared/);
      await new Promise((r) => setTimeout(r, 50));
      for (const c of calls) expect(c.url, c.url).not.toMatch(/^\/api\/(sessions|me)/);
      expect(sockets).toEqual([]);
    });
  }
});
