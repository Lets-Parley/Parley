import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
    if (url.endsWith("/api/plugins/panels")) {
      return Promise.resolve(
        new Response(JSON.stringify(panels), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("plugin panels in a poker room", () => {
  it("frames an installed plugin's UI in the room", async () => {
    servePanels([
      { name: "retro", version: "1.0.0", grants: ["session:read"] },
    ]);
    renderApp(<PokerRoom env={envelope()} me={me} />);

    const frame = await screen.findByTitle("retro plugin panel");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/plugin-ui/retro/1.0.0");
  });

  it("renders no sandbox at all on an instance with no plugins", async () => {
    servePanels([]);
    renderApp(<PokerRoom env={envelope()} me={me} />);

    await waitFor(() =>
      expect(
        screen.getAllByText("Log in with a passkey").length,
      ).toBeGreaterThan(0),
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("marks plugin frames inert while a host modal is open", async () => {
    const user = userEvent.setup();
    servePanels([
      { name: "retro", version: "1.0.0", grants: ["session:read"] },
    ]);
    // Revealed, because Reset only asks for confirmation on a revealed round.
    renderApp(<PokerRoom env={envelope({ revealed: true })} me={me} />);

    const frame = await screen.findByTitle("retro plugin panel");
    expect(frame.hasAttribute("inert")).toBe(false);
    // Reset the round is the facilitator's confirmation modal; opening it must
    // take the frame out of the focus order, or a Tab from the dialog walks
    // into content the overlay has covered.
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(
      screen.getByRole("heading", { name: "Reset this round?" }),
    ).toBeTruthy();
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(true));

    // And it is released again when the modal closes, so a plugin panel is
    // not left permanently unreachable by the keyboard.
    await user.click(screen.getByRole("button", { name: "Keep votes" }));
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(false));
  });
});
