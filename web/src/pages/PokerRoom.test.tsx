import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { PokerRoom } from "./PokerRoom";
import { makePerson, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

/** Dana is the facilitator; the viewer is Marcus, an ordinary seat. */
function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "sess-1",
    kind: "poker",
    title: "Sprint 12",
    phase: "voting",
    revealed: false,
    version: 1,
    facilitatorId: "dana",
    facilitatorConnected: false,
    facilitatorOfflineSince: "2026-08-18T10:00:00.000Z",
    endedAt: null,
    presence: ["marcus"],
    spaceSlug: "platform-team",
    participants: [
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
    ],
    serverTime: "2026-08-18T10:00:30.000Z",
    state: {
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
    },
    ...over,
  };
}

const claimButton = () => screen.getByRole("button", { name: /^Claim/ }) as HTMLButtonElement;

afterEach(() => vi.restoreAllMocks());

describe("PokerRoom facilitator claim", () => {
  it("enables the claim button at the exact moment the grace period runs out", () => {
    // The shipped bug was `disabled={!claimLeft}`: !0 is true, so the button
    // went inert at precisely the moment it should have become live. This
    // lived in the JSX, so no amount of testing the arithmetic catches it.
    renderApp(
      <PokerRoom env={envelope({ serverTime: "2026-08-18T10:01:00.000Z" })} me={me} />,
    );
    const btn = claimButton();
    expect(btn.textContent).toBe("Claim facilitator");
    expect(btn.disabled).toBe(false);
  });

  it("keeps the button inert while the grace period is still draining", () => {
    renderApp(<PokerRoom env={envelope()} me={me} />);
    const btn = claimButton();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Claim in 0:30");
  });

  it("stays enabled once the grace period is long past", () => {
    renderApp(
      <PokerRoom env={envelope({ serverTime: "2026-08-18T10:05:00.000Z" })} me={me} />,
    );
    expect(claimButton().disabled).toBe(false);
  });

  it("claims the chair on click", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ status: 204, ok: true, text: async () => "" } as Response);
    renderApp(
      <PokerRoom env={envelope({ serverTime: "2026-08-18T10:01:00.000Z" })} me={me} />,
    );
    claimButton().click();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1/facilitator/claim",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("names who dropped and says the grace period is over", () => {
    renderApp(
      <PokerRoom env={envelope({ serverTime: "2026-08-18T10:01:00.000Z" })} me={me} />,
    );
    expect(screen.getByText(/Dana Whitfield — the facilitator — lost connection/)).toBeTruthy();
    expect(screen.getByText(/The grace period is over/)).toBeTruthy();
  });

  it("offers the chair to nobody while the facilitator is connected", () => {
    renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={me} />);
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
  });

  it("offers the chair to nobody once the session has ended", () => {
    renderApp(<PokerRoom env={envelope({ endedAt: "2026-08-18T10:00:10.000Z" })} me={me} />);
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
  });

  it("does not offer the facilitator their own chair", () => {
    const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 200 };
    renderApp(<PokerRoom env={envelope()} me={dana} />);
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
  });
});

describe("PokerRoom story on the table", () => {
  it("names a ref-only story by its ticket reference", () => {
    // A ticket may carry only a reference, and an empty <h1> is not a name.
    const env = envelope();
    env.state.stories[0].title = "";
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.getByRole("heading", { level: 1, name: "PLAT-412" })).toBeTruthy();
  });
});
