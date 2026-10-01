import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PokerRoom } from "../pages/PokerRoom";
import { makePerson, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";

const me: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 40 };

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "sess-1",
    kind: "poker",
    title: "Sprint 12",
    phase: "voting",
    revealed: false,
    version: 1,
    facilitatorId: "dana",
    facilitatorConnected: true,
    endedAt: null,
    presence: ["dana"],
    orgSlug: "acme",
    spaceSlug: "platform-team",
    participants: [makePerson({ userId: "dana", name: "Dana Whitfield" })],
    serverTime: "2026-08-18T10:00:30.000Z",
    state: {
      deck: {
        name: "fibonacci",
        values: ["1", "2", "3", "5", "8"],
        ordinal: false,
      },
      autoReveal: false,
      openVoting: false,
      currentStoryId: "story-1",
      stories: [
        {
          id: "story-1",
          title: "Log in with a passkey",
          estimate: null,
          status: "voting",
          votedUserIds: [],
        },
      ],
    },
    ...over,
  } as Envelope;
}

/** The panel list the room fetches, and nothing else. */
function servePanels(panels: unknown[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/plugins/panels")) {
      return Promise.resolve(new Response(JSON.stringify(panels), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("plugin panels in a poker room", () => {
  it("frames an installed plugin's UI in the room", async () => {
    servePanels([{ name: "retro", version: "1.0.0", grants: ["session:read"] }]);
    renderApp(<PokerRoom env={envelope()} me={me} />);

    const frame = await screen.findByTitle("retro plugin panel");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/plugin-ui/retro/1.0.0");
  });

  it("renders no sandbox at all on an instance with no plugins", async () => {
    servePanels([]);
    renderApp(<PokerRoom env={envelope()} me={me} />);

    await waitFor(() => expect(screen.getAllByText("Log in with a passkey").length).toBeGreaterThan(0));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not nest a plugin that only declared toolbar chrome", async () => {
    servePanels([{ name: "bar", version: "1.0.0", grants: ["session:read"], slots: ["toolbar"] }]);
    renderApp(<PokerRoom env={envelope()} me={me} />);
    await waitFor(() => expect(screen.getAllByText("Log in with a passkey").length).toBeGreaterThan(0));
    expect(screen.queryByTitle("bar plugin panel")).toBeNull();
  });

  it("frames export-menu chrome next to Export CSV and not as a nested panel", async () => {
    servePanels([
      { name: "ship", version: "1.0.0", grants: ["session:read"], slots: ["export-menu"] },
    ]);
    renderApp(<PokerRoom env={envelope()} me={me} />);
    const frame = await screen.findByTitle("ship plugin export-menu");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(screen.queryByTitle("ship plugin panel")).toBeNull();
  });

  it("frames export-menu chrome for a link guest when the list includes it", async () => {
    servePanels([
      { name: "ship", version: "1.0.0", grants: ["session:read"], slots: ["export-menu"] },
    ]);
    renderApp(<PokerRoom env={envelope()} me={me} guest />);
    expect(await screen.findByTitle("ship plugin export-menu")).toBeTruthy();
    expect(screen.queryByText("Export CSV")).toBeNull();
  });

  it("marks plugin frames inert while a host modal is open", async () => {
    const user = userEvent.setup();
    servePanels([{ name: "retro", version: "1.0.0", grants: ["session:read"] }]);
    // Revealed, because Reset only asks for confirmation on a revealed round.
    renderApp(<PokerRoom env={envelope({ revealed: true })} me={me} />);

    const frame = await screen.findByTitle("retro plugin panel");
    expect(frame.hasAttribute("inert")).toBe(false);
    // Reset the round is the facilitator's confirmation modal. What is
    // asserted here is that opening it sets `inert` on the frame; jsdom does
    // not implement what `inert` then does, so the focus behavior it buys —
    // a Tab from the dialog not walking into content the overlay has covered —
    // is verified in a real browser rather than here.
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("heading", { name: "Reset this round?" })).toBeTruthy();
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(true));

    // And it is released again when the modal closes, so a plugin panel is
    // not left permanently unreachable by the keyboard.
    await user.click(screen.getByRole("button", { name: "Keep votes" }));
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(false));
  });

  // The nested panel is handed the viewer's id like any other slot, and in a
  // poker room that must come to nothing: no view, so no viewer.
  it("posts no state and no viewer id into a panel frame in a poker room", async () => {
    servePanels([{ name: "retro", version: "1.0.0", grants: ["session:read", "session:act"] }]);
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    renderApp(<PokerRoom env={envelope()} me={me} />);
    fireEvent.load(await screen.findByTitle("retro plugin panel"));
    // Longer than the push interval, so a view that was built would have landed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bodies = posted.mock.calls.map((c) => String(c[0]));
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('"type":"tokens"');
    expect(bodies.join("")).not.toContain("dana");
    expect(bodies.join("")).not.toContain("state");
    posted.mockRestore();
  });
});
