import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PokerRoom } from "./PokerRoom";
import { makePerson, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";
import { expectNoViolations } from "../test/axe";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

/**
 * A fetch stub that answers the plugin-panel list itself.
 *
 * The room asks /api/sessions/{id}/plugins/panels for the plugins that ship UI. That request
 * is not what any test below is about, so it is answered with "none" here and
 * every mock keeps describing only the call it cares about.
 */
/** The calls a test is about: everything except the plugin-panel list. */
function roomCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((c) => !String(c[0]).includes("/plugins/panels"));
}

function answering(response: Response) {
  return (input: RequestInfo | URL) => {
    if (String(input).includes("/plugins/panels")) {
      return Promise.resolve(new Response("[]", { status: 200 }));
    }
    return Promise.resolve(response);
  };
}


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
    orgSlug: "acme",
    spaceSlug: "platform-team",
    participants: [
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
    ],
    serverTime: "2026-08-18T10:00:30.000Z",
    state: {
      deck: { name: "fibonacci", values: ["1", "2", "3", "5", "8"], ordinal: false },
      autoReveal: false,
      openVoting: false,
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
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
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

  it("strips bidi overrides from the facilitator name in the claim banner", () => {
    const spoofed = "Alice\u202Ekkad";
    const env = envelope({
      serverTime: "2026-08-18T10:01:00.000Z",
      participants: [
        makePerson({ userId: "dana", name: spoofed }),
        makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
      ],
    });
    renderApp(<PokerRoom env={env} me={me} />);
    const line = screen.getByText(/the facilitator — lost connection/);
    expect(line.textContent).toBe("Alicekkad — the facilitator — lost connection");
    expect(line.textContent).not.toContain("\u202E");
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
    expect(screen.getByRole("heading", { level: 2, name: "PLAT-412" })).toBeTruthy();
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

  function endedWith(
    stories: Envelope["state"]["stories"],
    currentStoryId: string | null = stories[0]?.id ?? null,
  ) {
    const env = envelope({ endedAt: "2026-08-18T10:00:10.000Z" });
    env.state.stories = stories;
    env.state.currentStoryId = currentStoryId;
    return env;
  }

  it("lists unestimated stories in queue order, not alphabetically", () => {
    renderApp(
      <PokerRoom
        env={endedWith([
          {
            id: "s1",
            ref: "PLAT-1",
            title: "Zebra",
            notes: "",
            position: 1,
            estimate: null,
            status: "pending",
            votedUserIds: [],
          },
          {
            id: "s2",
            ref: "PLAT-2",
            title: "Already saved",
            notes: "",
            position: 2,
            estimate: "5",
            status: "estimated",
            votedUserIds: [],
          },
          {
            id: "s3",
            ref: "PLAT-3",
            title: "Apple",
            notes: "",
            position: 3,
            estimate: null,
            status: "pending",
            votedUserIds: [],
          },
        ])}
        me={me}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Not estimated" })).getAllByRole(
      "listitem",
    );
    expect(items.map((li) => li.textContent)).toEqual(["Zebra", "Apple"]);
  });

  it("includes a story left mid-vote, even while it is still current", () => {
    renderApp(
      <PokerRoom
        env={endedWith(
          [
            {
              id: "s1",
              ref: "PLAT-1",
              title: "Saved first",
              notes: "",
              position: 1,
              estimate: "3",
              status: "estimated",
              votedUserIds: ["marcus"],
            },
            {
              id: "s2",
              ref: "PLAT-2",
              title: "Left on the table",
              notes: "",
              position: 2,
              estimate: null,
              status: "voting",
              votedUserIds: ["marcus"],
            },
          ],
          "s2",
        )}
        me={me}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Not estimated" })).getAllByRole(
      "listitem",
    );
    expect(items.map((li) => li.textContent)).toEqual(["Left on the table"]);
  });

  it("lists leftovers by missing estimate, not by status", () => {
    renderApp(
      <PokerRoom
        env={endedWith([
          {
            id: "s1",
            ref: "PLAT-1",
            title: "Number saved, status still voting",
            notes: "",
            position: 1,
            estimate: "5",
            status: "voting",
            votedUserIds: [],
          },
          {
            id: "s2",
            ref: "PLAT-2",
            title: "No number, status already estimated",
            notes: "",
            position: 2,
            estimate: null,
            status: "estimated",
            votedUserIds: [],
          },
        ])}
        me={me}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Not estimated" })).getAllByRole(
      "listitem",
    );
    expect(items.map((li) => li.textContent)).toEqual(["No number, status already estimated"]);
  });

  it("shows a done state when every story was estimated, not an empty list", () => {
    renderApp(
      <PokerRoom
        env={endedWith([
          {
            id: "s1",
            ref: "PLAT-1",
            title: "First",
            notes: "",
            position: 1,
            estimate: "5",
            status: "estimated",
            votedUserIds: [],
          },
          {
            id: "s2",
            ref: "PLAT-2",
            title: "Second",
            notes: "",
            position: 2,
            estimate: "8",
            status: "estimated",
            votedUserIds: [],
          },
        ])}
        me={me}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Not estimated" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Not estimated" })).toBeNull();
    expect(screen.getByText("Every story was estimated.")).toBeTruthy();
  });

  it("has no axe violations on the unfinished list", async () => {
    const { container } = renderApp(
      <PokerRoom
        env={endedWith([
          {
            id: "s1",
            ref: "PLAT-1",
            title: "Unfinished",
            notes: "",
            position: 1,
            estimate: null,
            status: "pending",
            votedUserIds: [],
          },
        ])}
        me={me}
      />,
    );
    await expectNoViolations(container);
  });
});

describe("PokerRoom hand placement", () => {
  it("keeps the hand stuck to the bottom of the viewport", () => {
    // At 390px a 15-seat table is four ranks tall; the page scrolls and the
    // hand must not scroll away with it.
    const { container } = renderApp(<PokerRoom env={envelope()} me={me} />);
    const tray = container.querySelector(".fixed.bottom-0, .lg\\:sticky");
    expect(tray).toBeTruthy();
    expect(tray!.className).toContain("bottom-0");
    expect(tray!.className).toContain("fixed");
    expect(tray!.className).toContain("lg:sticky");
    expect(tray!.parentElement?.lastElementChild).toBe(tray);
  });
});

describe("PokerRoom errors", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("reports a failed reveal beside the button that failed, with a retry", async () => {
    // Every failure used to land in one line between the results panel and the
    // hand — for a header action, a whole column away from the control.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(JSON.stringify({ error: "Nobody has voted yet." }), { status: 409 })));
    const env = envelope({ facilitatorConnected: true });
    env.state.stories[0].votedUserIds = ["marcus"];
    renderApp(<PokerRoom env={env} me={dana} />);

    screen.getByRole("button", { name: "Reveal" }).click();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nobody has voted yet.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();

    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("routes a real queue-originated failure into the story queue landmark", async () => {
    // A real failure driven through PokerRoom's routing, not a `fail` prop
    // injected straight into StoryQueue — that would pass even if `where`
    // were hardcoded to "room".
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(JSON.stringify({ error: "Could not add the round." }), { status: 500 })));
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);

    await userEvent.click(screen.getByRole("button", { name: "+ Ad hoc" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not add the round.");
    const aside = screen.getByRole("complementary", { name: /Story queue/ });
    expect(aside.contains(alert)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("does not offer Try again for a failed vote", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(
        new Response(JSON.stringify({ error: "Could not record your vote." }), { status: 500 }),
      ));
    renderApp(<PokerRoom env={envelope()} me={me} />);

    await userEvent.click(screen.getByRole("button", { name: "3" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not record your vote.");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    fetchSpy.mockRestore();
  });

  it("places the room's error row right after the header, before the table", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(JSON.stringify({ error: "Nobody has voted yet." }), { status: 409 })));
    const env = envelope({ facilitatorConnected: true });
    env.state.stories[0].votedUserIds = ["marcus"];
    renderApp(<PokerRoom env={env} me={dana} />);

    screen.getByRole("button", { name: "Reveal" }).click();
    const alert = await screen.findByRole("alert");
    const header = alert.parentElement?.querySelector("header");
    expect(header).toBeTruthy();
    expect(header!.nextElementSibling).toBe(alert);
    const table = screen.getByTestId("table-field");
    expect(
      alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fetchSpy.mockRestore();
  });

  it("clears the failure banner when the round moves on to a new story", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(JSON.stringify({ error: "Nobody has voted yet." }), { status: 409 })));
    const env = envelope({ facilitatorConnected: true });
    env.state.stories[0].votedUserIds = ["marcus"];
    const { rerender } = renderApp(<PokerRoom env={env} me={dana} />);

    screen.getByRole("button", { name: "Reveal" }).click();
    await screen.findByRole("alert");

    const next = envelope({ facilitatorConnected: true });
    next.state.currentStoryId = "story-2";
    next.state.stories = [
      {
        id: "story-2",
        ref: "PLAT-413",
        title: "Next story",
        notes: "",
        position: 2,
        estimate: null,
        status: "voting",
        votedUserIds: [],
      },
    ];
    rerender(<PokerRoom env={next} me={dana} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("re-runs the failed call when Try again is clicked", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(JSON.stringify({ error: "Nobody has voted yet." }), { status: 409 })));
    const env = envelope({ facilitatorConnected: true });
    env.state.stories[0].votedUserIds = ["marcus"];
    renderApp(<PokerRoom env={env} me={dana} />);

    screen.getByRole("button", { name: "Reveal" }).click();
    const alert = await screen.findByRole("alert");
    expect(roomCalls(fetchSpy).length).toBe(1);

    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(roomCalls(fetchSpy).length).toBe(2);
    const [firstPath] = roomCalls(fetchSpy)[0] as [string, RequestInit];
    const [secondPath] = roomCalls(fetchSpy)[1] as [string, RequestInit];
    expect(secondPath).toBe(firstPath);
    fetchSpy.mockRestore();
  });
});

describe("PokerRoom save offer", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  function revealed(median: number) {
    const env = envelope({ facilitatorConnected: true, revealed: true });
    env.state.stories[0].results = {
      histogram: [
        { value: "3", count: 1 },
        { value: "5", count: 1 },
      ],
      median,
      average: median,
      consensus: false,
    };
    return env;
  }

  it("offers no save when the median is not a card in the deck", () => {
    // 3 and 5 average to a median of 4, which the backend rejects outright.
    renderApp(<PokerRoom env={revealed(4)} me={dana} />);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("says why in a live region when the median isn't a card, instead of just vanishing", () => {
    renderApp(<PokerRoom env={revealed(4)} me={dana} />);
    const note = screen.getByText("4 isn't a card in this deck — vote again to settle on one.");
    expect(note.closest("[aria-live]")).toBeTruthy();
  });

  it("still offers the save when the median is a real card", () => {
    renderApp(<PokerRoom env={revealed(3)} me={dana} />);
    expect(screen.getByRole("button", { name: "Save 3 to story" })).toBeTruthy();
  });

  it("saves the exact value it showed when clicked, and announces it", async () => {
    // heroOf used to be called three times per render (guard, click, label);
    // a caller that let just one of those calls drift from the deck could
    // post an estimate the backend would reject. Actually clicking exercises
    // the real onClick handler, not just the rendered label.
    vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    renderApp(<PokerRoom env={revealed(3)} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Save 3 to story" }));
    expect(await screen.findByText(/Estimate 3 saved to PLAT-412/)).toBeTruthy();
  });
});

describe("PokerRoom saved estimate", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  function saved() {
    const env = envelope({ facilitatorConnected: true, revealed: true });
    env.state.stories[0].estimate = "5";
    env.state.stories.push({
      id: "story-2",
      ref: "PLAT-413",
      title: "Rotate the passcodes",
      notes: "",
      position: 2,
      estimate: null,
      status: "pending",
      votedUserIds: [],
    });
    return env;
  }

  it("settles the round instead of offering Save a second time", () => {
    // The button used to read "Save 5 to story" after the save had landed.
    renderApp(<PokerRoom env={saved()} me={dana} />);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.getByText(/Saved 5 to PLAT-412/)).toBeTruthy();
  });

  it("points at the next unestimated story, and stays quiet once the queue is done", () => {
    const { unmount } = renderApp(<PokerRoom env={saved()} me={dana} />);
    expect(screen.getByRole("button", { name: "Next story" })).toBeTruthy();
    unmount();

    const done = saved();
    done.state.stories[1].estimate = "3";
    renderApp(<PokerRoom env={done} me={dana} />);
    expect(screen.queryByRole("button", { name: "Next story" })).toBeNull();
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
    expect(await screen.findByText("End this session?")).toBeTruthy();
    expect(roomCalls(del).length).toBe(0);
    screen.getByRole("button", { name: "Keep playing" }).click();
    await waitFor(() =>
      expect(screen.queryByText("End this session?")).toBeNull(),
    );
    expect(roomCalls(del).length).toBe(0);
  });

  it("does not offer End session to a non-facilitator", () => {
    renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={me} />);
    expect(
      screen.queryByRole("button", { name: "End session" }),
    ).toBeNull();
  });

  it("does not offer End session once the session has ended", () => {
    renderApp(
      <PokerRoom
        env={envelope({ endedAt: "2026-08-18T10:00:10.000Z" })}
        me={dana}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "End session" }),
    ).toBeNull();
  });
});

describe("PokerRoom auto-reveal", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("hides the toggle from a non-facilitator", () => {
    renderApp(<PokerRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("button", { name: /Auto-reveal/ })).toBeNull();
  });

  it("shows the toggle off by default for the facilitator", () => {
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("button", { name: "Auto-reveal off" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("PATCHes config when the facilitator turns auto-reveal on", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Auto-reveal off" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1/actions/config",
      expect.objectContaining({ method: "PATCH" }),
    );
    const init = roomCalls(fetchSpy)[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ autoReveal: true });
  });

  it("offers Auto-reveal on when the flag is already set", () => {
    const env = envelope({ facilitatorConnected: true });
    env.state.autoReveal = true;
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("button", { name: "Auto-reveal on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PokerRoom open voting", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("hides the toggle from a non-facilitator", () => {
    renderApp(<PokerRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("button", { name: /Open voting/ })).toBeNull();
  });

  it("shows the toggle off by default for the facilitator", () => {
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("button", { name: "Open voting off" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  // The whole point of the control: it is not a second reveal switch.
  it("describes the toggle as changing who the round waits for, not whether it reveals", () => {
    const env = envelope({ facilitatorConnected: true });
    const { container } = renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("button", { name: "Open voting off" });
    const id = toggle.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const description = container.ownerDocument.getElementById(String(id));
    expect(description?.textContent).toMatch(/waits for/);
    expect(description?.textContent).toMatch(/reveal/);
  });

  it("PATCHes config when the facilitator turns open voting on", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Open voting off" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1/actions/config",
      expect.objectContaining({ method: "PATCH" }),
    );
    const init = roomCalls(fetchSpy)[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ openVoting: true });
  });

  it("PATCHes openVoting false when the facilitator turns it back off", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const env = envelope({ facilitatorConnected: true });
    env.state.openVoting = true;
    renderApp(<PokerRoom env={env} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Open voting on" }));
    const init = roomCalls(fetchSpy)[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ openVoting: false });
  });

  it("offers Open voting on when the flag is already set", () => {
    const env = envelope({ facilitatorConnected: true });
    env.state.openVoting = true;
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("button", { name: "Open voting on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("has no axe violations on the facilitator's control cluster", async () => {
    const env = envelope({ facilitatorConnected: true });
    const { container } = renderApp(<PokerRoom env={env} me={dana} />);
    await expectNoViolations(container);
  });
});

describe("PokerRoom link guest", () => {
  it("never offers facilitator controls, export or spectate to a guest, even when the guest id matches the facilitator id", () => {
    // The pathological coincidence: a guest whose id happens to equal the
    // room's facilitatorId. `env.facilitatorId === me.id` alone would read
    // true here — only the `!guest &&` guard keeps it refused.
    const env = envelope({ facilitatorId: "guest-1" });
    const guestMe: Me = { id: "guest-1", name: "Priya Raman", avatarHue: 200 };
    renderApp(<PokerRoom env={env} me={guestMe} guest />);
    expect(screen.queryByText("Export CSV")).toBeNull();
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /spectat/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Auto-reveal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open voting/ })).toBeNull();
  });

  // A guest's capability is this one room. The space behind it refuses them,
  // so an ended session must not hand them a link straight into a 403 — the
  // same reasoning that hides the breadcrumb and the space nav.
  it("offers a guest no way into the space when the session has ended", () => {
    const env = envelope({ endedAt: "2026-08-18T11:00:00.000Z" });
    const guestMe: Me = { id: "guest-1", name: "Priya Raman", avatarHue: 200 };
    renderApp(<PokerRoom env={env} me={guestMe} guest />);
    expect(screen.getByText("This session has ended")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to the space" })).toBeNull();
  });

  // The same screen for a seated member still has its way out.
  it("still offers a seated member the way back to the space", () => {
    const env = envelope({ endedAt: "2026-08-18T11:00:00.000Z" });
    renderApp(<PokerRoom env={env} me={me} />);
    expect(
      screen.getByRole("link", { name: "Back to the space" }).getAttribute("href"),
    ).toBe("/o/acme/s/platform-team");
  });
});

describe("PokerRoom waiting list", () => {
  // A round that stays open for asynchronous estimation can wait for someone
  // who is not in the room at all, so the table has to name who is missing.
  it("names the seats the round is still waiting for", () => {
    const env = envelope();
    env.state.stories[0].votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    const line = screen.getByText(/Waiting on/);
    expect(line.textContent).toContain("Marcus Okonjo");
    expect(line.textContent).not.toContain("Dana Whitfield");
  });

  it("strips bidi overrides from waiting names", () => {
    const spoofed = "Marcus\u202EoknojO";
    const env = envelope({
      participants: [
        makePerson({ userId: "dana", name: "Dana Whitfield" }),
        makePerson({ userId: "marcus", name: spoofed }),
      ],
    });
    env.state.stories[0].votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    const line = screen.getByText(/Waiting on/);
    expect(line.textContent).toBe("Waiting on MarcusoknojO");
    expect(line.textContent).not.toContain("\u202E");
  });

  // It sits under a centred table, beside a centred tally; flush left it read
  // as a misalignment rather than as a line of its own.
  it("centres the waiting line like the tally above it", () => {
    const env = envelope();
    env.state.stories[0].votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.getByText(/Waiting on/).className).toContain("text-center");
  });

  it("says nothing once everyone expected has voted", () => {
    const env = envelope();
    env.state.stories[0].votedUserIds = ["dana", "marcus"];
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByText(/Waiting on/)).toBeNull();
  });

  // The tally above this line already excludes away seats from its
  // denominator — an away seat shows zzz and cannot vote. Naming one here
  // made the footer contradict the table: "0 of 1 voted" over "Waiting on
  // Dana Whitfield, Marcus Okonjo".
  it("does not name an away seat the tally has already excluded", () => {
    // Dana is not in `presence`, so she is away and outside the denominator.
    const env = envelope();
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.getByText("0 of 1 voted")).toBeTruthy();
    const line = screen.getByText(/Waiting on/);
    expect(line.textContent).toBe("Waiting on Marcus Okonjo");
  });

  it("says nothing once the only seat that could vote has", () => {
    const env = envelope();
    env.state.stories[0].votedUserIds = ["marcus"];
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByText(/Waiting on/)).toBeNull();
  });

  it("says nothing once the round is revealed", () => {
    const env = envelope({ revealed: true });
    env.state.stories[0].votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByText(/Waiting on/)).toBeNull();
  });
});

/**
 * The wiring, not the mechanism. Every other reconnect test constructs
 * `status` by hand and hands it straight to Table or to useRosterDelta, so
 * dropping `status={status}` from the page — where Table's default of "live"
 * silently takes over — leaves all of them green while a rejoin reads as the
 * whole room arriving at once.
 */
describe("PokerRoom reconnect wiring", () => {
  it("forwards status to the table so a reconnect is not read as new arrivals", () => {
    const roster = [
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
      makePerson({ userId: "priya", name: "Priya Raman" }),
    ];
    const at = (presence: string[], status: "live" | "reconnecting") => (
      <PokerRoom env={envelope({ participants: roster, presence })} me={me} status={status} />
    );
    // A blip, then the socket returns carrying a roster that also gained
    // Priya. The assertion is on the returning frame rather than on the blip
    // itself: with no roster change there is nothing to animate either way,
    // so only a reconnect that brings somebody new tells the two apart.
    const { rerender } = renderApp(at(["dana", "marcus"], "live"));
    rerender(at(["dana", "marcus"], "reconnecting"));
    rerender(at(["dana", "marcus", "priya"], "live"));
    const seat = document.querySelector('[data-seat-user="priya"]') as HTMLElement;
    expect(seat).toBeTruthy();
    expect(seat.style.animation).toBe("");
  });
});

describe("removing someone from the room", () => {
  const fac: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };
  const room = (over: Partial<Envelope> = {}) =>
    envelope({ presence: ["dana", "marcus"], ...over });

  it("offers the control to the facilitator, on every seat but their own", () => {
    renderApp(<PokerRoom env={room()} me={fac} />);
    expect(screen.getByRole("button", { name: "Remove Marcus Okonjo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Dana Whitfield" })).toBeNull();
  });

  it("offers it to nobody else", () => {
    renderApp(<PokerRoom env={room()} me={me} />);
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("withdraws it from an ended room", () => {
    renderApp(
      <PokerRoom env={room({ endedAt: "2026-08-18T11:00:00.000Z" })} me={fac} />,
    );
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("sends the optional message, capped at 80 characters", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const user = userEvent.setup();
    renderApp(<PokerRoom env={room()} me={fac} />);
    await user.click(screen.getByRole("button", { name: "Remove Marcus Okonjo" }));
    const box = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    // A close reason is 123 BYTES, so the cap is what stops a multi-byte
    // message being truncated mid-character on the wire.
    expect(box.maxLength).toBe(80);
    await user.type(box, "wrong room, sorry");
    await user.click(screen.getByRole("button", { name: "Remove from room" }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/sessions/sess-1/participants/marcus/remove",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "wrong room, sorry" }),
        }),
      ),
    );
  });

  it("posts nothing when the confirm is dismissed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    renderApp(<PokerRoom env={room()} me={fac} />);
    await user.click(screen.getByRole("button", { name: "Remove Marcus Okonjo" }));
    await user.click(screen.getByRole("button", { name: /keep them/i }));
    expect(roomCalls(fetchSpy).length).toBe(0);
  });
});

describe("the screen a removed person lands on", () => {
  it("is its own, and repeats what the facilitator said", () => {
    renderApp(
      <PokerRoom env={envelope()} me={me} status="kicked" kickReason="wrong room, sorry" />,
    );
    expect(screen.getByText(/wrong room, sorry/)).toBeTruthy();
    // Never the space-level wording: they still belong to the space.
    expect(screen.queryByText(/no longer have access to this space/)).toBeNull();
    expect(screen.queryByTestId("table-field")).toBeNull();
  });

  it("stands on its own when nothing was said", () => {
    renderApp(<PokerRoom env={envelope()} me={me} status="kicked" />);
    expect(screen.getByRole("heading", { name: /shown the door/i })).toBeTruthy();
  });

  it("leaves an ordinary room alone", () => {
    renderApp(<PokerRoom env={envelope()} me={me} status="live" />);
    expect(screen.queryByRole("heading", { name: /shown the door/i })).toBeNull();
  });
});

describe("PokerRoom facilitator handoff", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 200 };
  const live = (over: Partial<Envelope> = {}) =>
    envelope({
      facilitatorConnected: true,
      participants: [
        makePerson({ userId: "dana", name: "Dana Whitfield" }),
        makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
        makePerson({ userId: "gabe", name: "Gabe Guest", guest: true }),
      ],
      ...over,
    });

  it("hands the chair to a named participant in one action", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    renderApp(<PokerRoom env={live()} me={dana} />);

    await userEvent.click(screen.getByRole("button", { name: /hand off/i }));
    const roster = screen.getByRole("dialog");
    await userEvent.click(within(roster).getByRole("button", { name: /Marcus Okonjo/ }));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1/facilitator",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ userId: "marcus" }) }),
    );
  });

  it("offers neither itself nor a link guest as a recipient", async () => {
    renderApp(<PokerRoom env={live()} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: /hand off/i }));
    const roster = screen.getByRole("dialog");
    expect(within(roster).queryByRole("button", { name: /Gabe Guest/ })).toBeNull();
    expect(within(roster).queryByRole("button", { name: /Dana Whitfield/ })).toBeNull();
  });

  it("does not offer the handoff to an ordinary seat, a guest, or an ended room", () => {
    renderApp(<PokerRoom env={live()} me={me} />);
    expect(screen.queryByRole("button", { name: /hand off/i })).toBeNull();

    renderApp(<PokerRoom env={live()} me={dana} guest />);
    expect(screen.queryByRole("button", { name: /hand off/i })).toBeNull();

    renderApp(
      <PokerRoom env={live({ endedAt: "2026-08-18T10:00:10.000Z" })} me={dana} />,
    );
    expect(screen.queryByRole("button", { name: /hand off/i })).toBeNull();
  });

  it("announces the new facilitator to everyone in the room", async () => {
    const { rerender } = renderApp(<PokerRoom env={live()} me={me} />);
    rerender(<PokerRoom env={live({ facilitatorId: "marcus", version: 2 })} me={me} />);
    expect(await screen.findByText("You're the facilitator now")).toBeTruthy();
  });

  it("names the new facilitator for the rest of the room", async () => {
    const other: Me = { id: "priya", name: "Priya Raman", avatarHue: 10 };
    const { rerender } = renderApp(<PokerRoom env={live()} me={other} />);
    rerender(<PokerRoom env={live({ facilitatorId: "marcus", version: 2 })} me={other} />);
    expect(await screen.findByText("Marcus Okonjo is the facilitator now")).toBeTruthy();
  });
});

describe("PokerRoom · the card you played", () => {
  /** The round after a reveal, with everyone's vote back from the server. */
  function revealed(votes: { userId: string; value: string }[], over: Partial<Envelope> = {}) {
    const base = envelope({ revealed: true, version: 2, ...over });
    return {
      ...base,
      state: {
        ...base.state,
        stories: [
          {
            ...base.state.stories[0],
            votedUserIds: votes.map((v) => v.userId),
            votes,
          },
        ],
      },
    } as Envelope;
  }

  const card = (face: string) => screen.getByRole("button", { name: face });

  it("marks the card you played once the round is revealed", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const { rerender } = renderApp(<PokerRoom env={envelope()} me={me} />);
    await userEvent.click(card("3"));
    rerender(
      <PokerRoom
        env={revealed([
          { userId: "marcus", value: "3" },
          { userId: "dana", value: "5" },
        ])}
        me={me}
      />,
    );
    // The reveal clears the optimistic pick, so the mark has to come from the
    // server's vote list or it comes from nowhere at all.
    expect(card("3").getAttribute("data-played")).toBe("true");
    expect(card("3").className).toMatch(/border-accent/);
    expect(card("3").className).toMatch(/shadow-rest/);
    expect(card("3").className).not.toMatch(/shadow-lift/);
    for (const face of ["1", "2", "5", "8"]) {
      expect(card(face).getAttribute("data-played")).toBeNull();
    }
    fetchSpy.mockRestore();
  });

  it("still knows your card on a fresh mount after the reveal", () => {
    // A reload drops every scrap of local state. The vote is on the envelope,
    // so the mark comes back with it.
    renderApp(
      <PokerRoom
        env={revealed([
          { userId: "marcus", value: "8" },
          { userId: "dana", value: "5" },
        ])}
        me={me}
      />,
    );
    expect(card("8").getAttribute("data-played")).toBe("true");
    expect(card("5").getAttribute("data-played")).toBeNull();
  });

  it("marks nothing for someone who never voted", () => {
    renderApp(<PokerRoom env={revealed([{ userId: "dana", value: "5" }])} me={me} />);
    for (const face of ["1", "2", "3", "5", "8"]) {
      expect(card(face).getAttribute("data-played")).toBeNull();
    }
  });

  it("clears the mark when the round is reset", () => {
    const { rerender } = renderApp(
      <PokerRoom env={revealed([{ userId: "marcus", value: "3" }])} me={me} />,
    );
    expect(card("3").getAttribute("data-played")).toBe("true");
    rerender(<PokerRoom env={envelope({ version: 3 })} me={me} />);
    for (const face of ["1", "2", "3", "5", "8"]) {
      expect(card(face).getAttribute("data-played")).toBeNull();
    }
  });

  it("shows a spectator no hand to mark", () => {
    const env = revealed([{ userId: "dana", value: "5" }]);
    renderApp(
      <PokerRoom
        env={{
          ...env,
          participants: [
            makePerson({ userId: "dana", name: "Dana Whitfield" }),
            makePerson({ userId: "marcus", name: "Marcus Okonjo", spectator: true }),
          ],
        }}
        me={me}
      />,
    );
    expect(screen.queryByRole("button", { name: "5" })).toBeNull();
  });
});
