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

/** A table of `n` seats, all online, with the first `voted` of them voted. */
function bigEnv(seats: number, voted: number, online = seats, over: Partial<Envelope> = {}) {
  const people = Array.from({ length: seats }, (_, i) =>
    makePerson({ userId: `u${i}`, name: `Person${i} Surname` }),
  );
  const env = envelope({
    participants: people,
    presence: people.slice(0, online).map((p) => p.userId),
    facilitatorId: "u0",
    facilitatorConnected: true,
    ...over,
  });
  env.state.stories[0].votedUserIds = people.slice(0, voted).map((p) => p.userId);
  return env;
}

const cue = () => screen.getByTestId("table-field").getAttribute("data-cue");

describe("PokerRoom daybreak cue", () => {
  it("steps the field with the room, and only reaches day on the reveal", () => {
    const { rerender } = renderApp(<PokerRoom env={bigEnv(5, 0)} me={me} />);
    expect(cue()).toBe("overcast");
    rerender(<PokerRoom env={bigEnv(5, 1)} me={me} />);
    expect(cue()).toBe("first-light");
    rerender(<PokerRoom env={bigEnv(5, 5)} me={me} />);
    expect(cue()).toBe("daybreak");
    rerender(<PokerRoom env={bigEnv(5, 5, 5, { revealed: true })} me={me} />);
    expect(cue()).toBe("day");
  });

  // Criterion 5, at the layer that owns the accumulator. A Table-level test
  // would only prove Table renders its prop.
  it("does not step down when a silent seat reconnects", () => {
    const { rerender } = renderApp(<PokerRoom env={bigEnv(3, 2, 2)} me={me} />);
    expect(screen.getByRole("status").textContent).toContain("2 of 2");
    expect(cue()).toBe("daybreak");
    rerender(<PokerRoom env={bigEnv(3, 2, 3)} me={me} />);
    expect(screen.getByRole("status").textContent).toContain("2 of 3");
    expect(cue()).toBe("daybreak");
  });

  it("holds daybreak when reconnections drag the ratio back under a threshold", () => {
    // 2 of 5 is r=0.40 — DAYBREAK. Two reconnections make it 2 of 7, r=0.29,
    // which is FIRST LIGHT raw. The accumulator must not walk the light back.
    const { rerender } = renderApp(<PokerRoom env={bigEnv(7, 2, 5)} me={me} />);
    expect(cue()).toBe("daybreak");
    rerender(<PokerRoom env={bigEnv(7, 2, 7)} me={me} />);
    expect(screen.getByRole("status").textContent).toContain("2 of 7");
    expect(cue()).toBe("daybreak");
  });

  // Criterion 6. env.version cannot express this: the server bumps it on every
  // vote too, so the accumulator would reset mid-round. The signal is the vote
  // count falling to zero, which only a reset can do.
  it("returns to overcast on a reset that never revealed anything", () => {
    const { rerender } = renderApp(<PokerRoom env={bigEnv(5, 3)} me={me} />);
    expect(cue()).toBe("daybreak");
    // Same story, revealed still false — the two things the old effect watched.
    const after = bigEnv(5, 0);
    expect(after.state.currentStoryId).toBe("story-1");
    expect(after.revealed).toBe(false);
    rerender(<PokerRoom env={after} me={me} />);
    expect(cue()).toBe("overcast");
  });

  // The reveal flag is load-bearing in the DOWNWARD direction only. Going up,
  // the ratchet reaches DAY on rank alone and would look right even with the
  // epoch never bumping; coming back down with the votes still standing, only
  // the epoch reset can let the light fall.
  it("falls back off day when a reveal is taken back with the votes still in", () => {
    const { rerender } = renderApp(
      <PokerRoom env={bigEnv(5, 1, 5, { revealed: true })} me={me} />,
    );
    expect(cue()).toBe("day");
    const hidden = bigEnv(5, 1);
    expect(hidden.state.currentStoryId).toBe("story-1");
    expect(hidden.state.stories[0].votedUserIds.length).toBe(1);
    rerender(<PokerRoom env={hidden} me={me} />);
    expect(screen.getByRole("status").textContent).toContain("1 of 5");
    expect(cue()).toBe("first-light");
  });

  it("clears the picked card on a pre-reveal reset", () => {
    const voted = bigEnv(5, 3);
    voted.state.deck = { name: "fibonacci", values: ["1", "2", "3"], ordinal: false };
    const { rerender } = renderApp(<PokerRoom env={voted} me={me} />);
    const three = screen.getByRole("button", { name: "3" });
    three.click();
    const cleared = bigEnv(5, 0);
    cleared.state.deck = voted.state.deck;
    rerender(<PokerRoom env={cleared} me={me} />);
    expect(screen.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("PokerRoom ended session", () => {
  it("takes the live table down with the hand", () => {
    // <Hand> was gated on !ended and <Table> was not, so an ended session
    // showed a live table underneath its own "this session has ended" card.
    renderApp(
      <PokerRoom env={envelope({ endedAt: "2026-08-18T10:00:10.000Z" })} me={me} />,
    );
    expect(screen.getByText("This session has ended")).toBeTruthy();
    expect(screen.queryByTestId("table-field")).toBeNull();
    expect(screen.queryByText(/YOUR HAND/)).toBeNull();
  });
});

describe("PokerRoom hand placement", () => {
  it("keeps the hand stuck to the bottom of the viewport", () => {
    // At 390px a 15-seat table is four ranks tall; the page scrolls and the
    // hand must not scroll away with it.
    const { container } = renderApp(<PokerRoom env={envelope()} me={me} />);
    const hand = container.querySelector("section.sticky, .sticky > section");
    expect(hand).toBeTruthy();
    const sticky = container.querySelector(".sticky") as HTMLElement;
    expect(sticky.className).toContain("bottom-0");
    // ponytail: sticky works only while Hand is the last child of the column.
    expect(sticky.parentElement?.lastElementChild).toBe(sticky);
  });
});

describe("PokerRoom end session", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("asks before ending the session for everyone", async () => {
    // It shipped as a bare text link one cursor-width from Export CSV, and
    // one click killed the room live.
    const del = vi.spyOn(globalThis, "fetch");
    renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={dana} />);
    screen.getByRole("button", { name: "End session" }).click();
    expect(del).not.toHaveBeenCalled();
    expect(await screen.findByText("End this session?")).toBeTruthy();
    screen.getByRole("button", { name: "Keep playing" }).click();
  });
});
