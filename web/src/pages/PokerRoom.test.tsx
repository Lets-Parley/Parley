import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PokerRoom } from "./PokerRoom";
import { makePerson, pageStatus, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";
import { expectNoViolations } from "../test/axe";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

it("counts and deals only retained planning stories from a split", () => {
  const env = envelope({ facilitatorId: me.id });
  env.state.stories = [
    { id: "parent", title: "Parent context", planningRole: "context", estimate: "13" },
    { id: "draft", title: "Proposed draft", planningRole: "proposed", estimate: null },
    { id: "removed", title: "Removed child", planningRole: "planning", removedAt: "2026-10-10", estimate: null },
    { id: "child", title: "Planning child", planningRole: "planning", estimate: "3" },
  ].map((s, i) => ({ ref: "", notes: "", position: i, status: "pending", votedUserIds: [], ...s })) as Envelope["state"]["stories"];
  renderApp(<PokerRoom env={env} me={me} />);
  expect(screen.getByRole("complementary", { name: "Story queue · 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Deal Proposed draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Deal Parent context" })).toBeNull();
});

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

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

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
    expect(pageStatus().textContent).toContain("2 of 2");
    expect(cue()).toBe("daybreak");
    rerender(<PokerRoom env={bigEnv(3, 2, 3)} me={me} />);
    expect(pageStatus().textContent).toContain("2 of 3");
    expect(cue()).toBe("daybreak");
  });

  it("holds daybreak when reconnections drag the ratio back under a threshold", () => {
    // 2 of 5 is r=0.40 — DAYBREAK. Two reconnections make it 2 of 7, r=0.29,
    // which is FIRST LIGHT raw. The accumulator must not walk the light back.
    const { rerender } = renderApp(<PokerRoom env={bigEnv(7, 2, 5)} me={me} />);
    expect(cue()).toBe("daybreak");
    rerender(<PokerRoom env={bigEnv(7, 2, 7)} me={me} />);
    expect(pageStatus().textContent).toContain("2 of 7");
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
    expect(pageStatus().textContent).toContain("1 of 5");
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

  it("tallies what was estimated and drops the live chrome once ended", () => {
    const story = (id: string, title: string, estimate: string, position: number) => ({
      id, ref: "", title, notes: "", position, estimate,
      status: (estimate ? "estimated" : "pending") as "estimated" | "pending", votedUserIds: [] as string[],
    });
    renderApp(
      <PokerRoom
        env={endedWith([story("s1", "First", "5", 1), story("s2", "Second", "3", 2), story("s3", "Third", "", 3)], null)}
        me={me}
      />,
    );
    expect(screen.getByText("2 of 3 estimated · 8 points")).toBeTruthy();
    const done = within(screen.getByRole("list", { name: "Estimated" })).getAllByRole("listitem");
    expect(done.map((li) => li.textContent)).toEqual(["First5", "Second3"]);
    expect(screen.getByText(/^Ended Aug 18, /)).toBeTruthy();
    // The way out comes after the summary, not between the heading and it.
    const back = screen.getByRole("link", { name: "Back to the space" });
    const list = screen.getByRole("list", { name: "Not estimated" });
    expect(list.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Present" })).toBeNull();
    expect(screen.queryByText("No story on the table")).toBeNull();
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

    await userEvent.click(screen.getByRole("button", { name: "+ Add story" }));
    await userEvent.click(screen.getByRole("button", { name: "Point something now" }));
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

  it("starts the Reset confirm on the safe choice", async () => {
    renderApp(<PokerRoom env={revealed(4)} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep votes" }));
  });

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
    const said = await screen.findByText(/Estimate 3 saved to PLAT-412/);
    // The chip is the visible confirmation; a toast on top made it two.
    expect(said.closest("[data-question-announcement]")).toBeTruthy();
  });
});

describe("PokerRoom no story on the table", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };
  function idle() {
    const env = envelope({ facilitatorConnected: true });
    env.state.currentStoryId = null;
    env.state.stories[0].status = "pending";
    return env;
  }

  it("offers neither Reveal nor Reset when nothing is dealt", () => {
    renderApp(<PokerRoom env={idle()} me={dana} />);
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.getByText("No story on the table")).toBeTruthy();
  });

  it("keeps the room settings, which are not about any one round", () => {
    renderApp(<PokerRoom env={idle()} me={dana} />);
    expect(screen.getByRole("switch", { name: "Auto-reveal" })).toBeTruthy();
  });

  it("groups the two settings as switches under one name", () => {
    renderApp(<PokerRoom env={idle()} me={dana} />);
    const group = screen.getByRole("group", { name: "Round settings" });
    expect(within(group).getAllByRole("switch")).toHaveLength(2);
  });

  it("opens the add dialog from the one call to action on an empty room", async () => {
    const env = idle();
    env.state.stories = [];
    renderApp(<PokerRoom env={env} me={dana} />);
    expect(screen.queryByRole("button", { name: "Point something now" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add a story" }));
    expect(screen.getByLabelText("Ticket ID (optional)")).toBeTruthy();
  });
});

describe("PokerRoom header actions", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("keeps Leave unestimated with the round, not among the session actions", () => {
    renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={dana} />);
    const leave = screen.getByRole("button", { name: "Leave unestimated" });
    expect(leave.closest("[data-session-actions]")).toBeNull();
    expect(screen.getByRole("button", { name: "End session" }).closest("[data-session-actions]")).toBeTruthy();
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

  it("wears the success color, not the settled pink, and keeps the next title to one line", () => {
    renderApp(<PokerRoom env={saved()} me={dana} />);
    const chip = screen.getByText(/Saved 5 to PLAT-412/);
    expect(chip.className).toContain("text-go");
    expect(chip.className).not.toContain("settled");
    const next = screen.getByRole("button", { name: /^Next story/ });
    expect(next.className).toContain("truncate");
    expect(next.getAttribute("title")).toBe("PLAT-413 · Rotate the passcodes");
  });

  it("points at the next unestimated story, and stays quiet once the queue is done", () => {
    const { unmount } = renderApp(<PokerRoom env={saved()} me={dana} />);
    expect(screen.getByRole("button", { name: "Next story: PLAT-413 · Rotate the passcodes" })).toBeTruthy();
    unmount();

    const done = saved();
    done.state.stories[1].estimate = "3";
    renderApp(<PokerRoom env={done} me={dana} />);
    expect(screen.queryByRole("button", { name: /^Next story/ })).toBeNull();
  });
});

describe("PokerRoom end session", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("starts the End confirm on the safe choice", async () => {
    renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={dana} />);
    screen.getByRole("button", { name: "End session" }).click();
    await screen.findByText("End this session?");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep playing" }));
  });

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
    expect(screen.queryByRole("switch", { name: /Auto-reveal/ })).toBeNull();
  });

  it("shows the toggle off by default for the facilitator", () => {
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("switch", { name: "Auto-reveal" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("PATCHes config when the facilitator turns auto-reveal on", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    await userEvent.click(screen.getByRole("switch", { name: "Auto-reveal" }));
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
    const toggle = screen.getByRole("switch", { name: "Auto-reveal" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("PokerRoom open voting", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("hides the toggle from a non-facilitator", () => {
    renderApp(<PokerRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("switch", { name: /Open voting/ })).toBeNull();
  });

  it("shows the toggle off by default for the facilitator", () => {
    const env = envelope({ facilitatorConnected: true });
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("switch", { name: "Open voting" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  // The whole point of the control: it is not a second reveal switch.
  it("describes the toggle as changing who the round waits for, not whether it reveals", () => {
    const env = envelope({ facilitatorConnected: true });
    const { container } = renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("switch", { name: "Open voting" });
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
    await userEvent.click(screen.getByRole("switch", { name: "Open voting" }));
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
    await userEvent.click(screen.getByRole("switch", { name: "Open voting" }));
    const init = roomCalls(fetchSpy)[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ openVoting: false });
  });

  it("offers Open voting on when the flag is already set", () => {
    const env = envelope({ facilitatorConnected: true });
    env.state.openVoting = true;
    renderApp(<PokerRoom env={env} me={dana} />);
    const toggle = screen.getByRole("switch", { name: "Open voting" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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
    expect(screen.queryByRole("switch", { name: /Auto-reveal/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Open voting/ })).toBeNull();
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

  // It sits under a centered table, beside a centered tally; flush left it read
  // as a misalignment rather than as a line of its own.
  it("centers the waiting line like the tally above it", () => {
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
    expect(line.textContent).toBe("Waiting on Marcus Okonjo (1 away)");
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

  const strip = (text: string) => expect(screen.getByText(text)).toBeTruthy();

  it("collapses the hand to a strip naming the card you played once revealed", async () => {
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
    // The reveal clears the optimistic pick, so the strip has to read the
    // server's vote list or it names nothing.
    strip("You played 3 · votes revealed");
    expect(screen.queryByRole("button", { name: "3" })).toBeNull();
    fetchSpy.mockRestore();
  });

  it("moves focus to the strip when it was on a card as the hand collapsed", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering({ status: 204, ok: true, text: async () => "" } as Response));
    const { rerender } = renderApp(<PokerRoom env={envelope()} me={me} />);
    await userEvent.click(card("3"));
    expect(document.activeElement).toBe(card("3"));
    rerender(<PokerRoom env={revealed([{ userId: "marcus", value: "3" }])} me={me} />);
    expect(document.activeElement).toBe(screen.getByText("You played 3 · votes revealed"));
    fetchSpy.mockRestore();
  });

  it("still knows your card on a fresh mount after the reveal", () => {
    renderApp(
      <PokerRoom
        env={revealed([
          { userId: "marcus", value: "8" },
          { userId: "dana", value: "5" },
        ])}
        me={me}
      />,
    );
    strip("You played 8 · votes revealed");
  });

  it("says you did not vote for someone who never voted", () => {
    renderApp(<PokerRoom env={revealed([{ userId: "dana", value: "5" }])} me={me} />);
    strip("You did not vote · votes revealed");
  });

  it("brings the full hand back when the round is reset", () => {
    const { rerender } = renderApp(
      <PokerRoom env={revealed([{ userId: "marcus", value: "3" }])} me={me} />,
    );
    strip("You played 3 · votes revealed");
    rerender(<PokerRoom env={envelope({ version: 3 })} me={me} />);
    expect(card("3").getAttribute("data-played")).toBeNull();
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

  it("keeps an offline spectator on the rail", () => {
    renderApp(
      <PokerRoom
        env={envelope({
          presence: ["marcus"],
          participants: [
            makePerson({ userId: "dana", name: "Dana Whitfield" }),
            makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
            makePerson({ userId: "priya", name: "Priya Rao", spectator: true }),
          ],
        })}
        me={me}
      />,
    );
    expect(screen.getByTestId("spectator-rail").textContent).toContain("Priya Rao");
  });
});

describe("PokerRoom present link", () => {
  it("opens the presenter view in a new tab", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response("{}", { status: 200 })));
    renderApp(<PokerRoom env={envelope()} me={me} />);
    const link = screen.getByRole("link", { name: "Present" });
    expect(link.getAttribute("href")).toBe("/session/sess-1/present");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
  });
});

describe("independent child rounds", () => {
  it("offers an explicit fresh round when dealing a child with earlier votes", async () => {
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
    const env=envelope({facilitatorId:me.id});
    env.state.roundVersion=7;
    env.state.stories.push({...env.state.stories[0],id:"child",title:"API child",parentId:"parent",contentRevision:1,scopeRevision:0,votedUserIds:[me.id]});
    renderApp(<PokerRoom env={env} me={me}/>);
    await userEvent.click(screen.getByRole("button",{name:"Deal API child"}));
    expect(roomCalls(spy).length).toBe(0);
    const dialog=screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button",{name:"Keep working on this round"}));
    expect(roomCalls(spy).length).toBe(0);
    await userEvent.click(screen.getByRole("button",{name:"Deal API child"}));
    await userEvent.click(screen.getByRole("button",{name:"Start fresh round"}));
    await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
    expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({storyId:"child",freshRound:true,expectedCurrentStoryId:"story-1",expectedRoundVersion:7});
  });
  it("shows prior child acceptance as Needs review instead of Saved", () => {
    const env=envelope({facilitatorId:me.id,revealed:true});
    Object.assign(env.state.stories[0],{parentId:"parent",estimate:"3",estimateNeedsReview:true,estimateProvenance:"facilitator-set"});
    renderApp(<PokerRoom env={env} me={me}/>);
    expect(screen.getAllByText(/Needs review/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Saved 3/)).toBeNull();
  });
  it("says the round ends when an estimate is set on the story whose round is live, and sends the round it ends", async () => {
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
    const env=envelope({facilitatorId:me.id});
    Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:1,scopeRevision:0});
    env.state.roundVersion=7;
    renderApp(<PokerRoom env={env} me={me}/>);
    await userEvent.click(screen.getByRole("button",{name:"Set estimate"}));
    expect(screen.getByText("This round ends when you accept. Its votes are discarded.")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Estimate card"),"3");
    await userEvent.click(screen.getByRole("button",{name:"Accept facilitator-set estimate"}));
    await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
    expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({estimate:"3",storyId:"story-1",endRound:true,expectedCurrentStoryId:"story-1",expectedRoundVersion:7});
  });
  it("sets an estimate on a revealed round without ending it", async () => {
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
    const env=envelope({facilitatorId:me.id,revealed:true});
    Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:1,scopeRevision:0});
    renderApp(<PokerRoom env={env} me={me}/>);
    await userEvent.click(screen.getByRole("button",{name:"Set estimate"}));
    expect(screen.queryByText("This round ends when you accept. Its votes are discarded.")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Estimate card"),"3");
    await userEvent.click(screen.getByRole("button",{name:"Accept facilitator-set estimate"}));
    await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
    expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string).endRound).toBeUndefined();
  });
  it("starts direct estimation with no selected card and records Facilitator-set", async () => {
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
    const env=envelope({facilitatorId:me.id});
    Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:1,scopeRevision:0});
    renderApp(<PokerRoom env={env} me={me}/>);
    await userEvent.click(screen.getByRole("button",{name:"Set estimate"}));
    const save=screen.getByRole("button",{name:"Accept facilitator-set estimate"}) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText("Estimate card"),"3");
    await userEvent.click(save);
    await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
    expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({acceptanceMode:"facilitator-set",estimate:"3",storyId:"story-1"});
  });
});

it("keeps scope edits explicit and submits the reviewed round snapshot", async () => {
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
 const env=envelope({facilitatorId:me.id});env.state.roundVersion=2;
 Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:4,scopeRevision:0});
 renderApp(<PokerRoom env={env} me={me}/>);
 await userEvent.click(screen.getByRole("button",{name:"Change scope"}));
 await userEvent.clear(screen.getByLabelText("Title"));
 await userEvent.type(screen.getByLabelText("Title"),"More scope");
 expect(roomCalls(spy).length).toBe(0);
 await userEvent.click(screen.getByRole("button",{name:"Change scope and restart review"}));
 await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
 expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({title:"More scope",scopeRestart:true,expectedRoundVersion:2,expectedCurrentStoryId:"story-1",expectedRevision:4});
});

it("shows a newly revealed child round as unsaved when only an older estimate exists", () => {
 const env=envelope({facilitatorId:me.id,revealed:true});env.state.roundVersion=9;
 Object.assign(env.state.stories[0],{parentId:"parent",estimate:"3",estimateNeedsReview:false,acceptedRoundVersion:4,estimateProvenance:"poker",results:{histogram:[],consensus:true,count:1,median:5}});
 renderApp(<PokerRoom env={env} me={me}/>);
 expect(screen.getByText("Votes revealed · estimate not accepted")).toBeTruthy();
 expect(screen.queryByText(/^Saved 3/)).toBeNull();
});

it("keeps child acceptance and scope-review dialogs accessible", async () => {
 const env=envelope({facilitatorId:me.id});
 Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:1,scopeRevision:0});
 const {container}=renderApp(<PokerRoom env={env} me={me}/>);
 await userEvent.click(screen.getByRole("button",{name:"Set estimate"}));
 await expectNoViolations(container);
 expect(screen.getByRole("button",{name:"Accept facilitator-set estimate"}).className).toContain("min-h");
 await userEvent.click(screen.getByRole("button",{name:"Cancel"}));
 await userEvent.click(screen.getByRole("button",{name:"Change scope"}));
 await expectNoViolations(container);
});

it("saves a revealed child as Poker with its reviewed identity, scope and round", async () => {
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
 const env=envelope({facilitatorId:me.id,revealed:true});env.state.roundVersion=11;
 Object.assign(env.state.stories[0],{parentId:"parent",contentRevision:7,scopeRevision:3,results:{histogram:[{value:"5",count:1}],median:5,average:5,consensus:true}});
 renderApp(<PokerRoom env={env} me={me}/>);
 expect(roomCalls(spy).length).toBe(0);
 await userEvent.click(screen.getByRole("button",{name:"Save Poker estimate 5 to Rate-limit the join endpoint"}));
 await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
 expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({storyId:"story-1",estimate:"5",acceptanceMode:"poker",expectedRevision:7,expectedScopeRevision:3,expectedRoundVersion:11});
});

it("sends the observed identity and round when dealing an unvoted child", async () => {
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
 const env=envelope({facilitatorId:me.id});env.state.roundVersion=17;
 env.state.stories.push({...env.state.stories[0],id:"child",title:"Unvoted child",parentId:"parent"});
 renderApp(<PokerRoom env={env} me={me}/>);
 await userEvent.click(screen.getByRole("button",{name:"Deal Unvoted child"}));
 await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
 expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({storyId:"child",expectedCurrentStoryId:"story-1",expectedRoundVersion:17});
});

it.each(["historical", "facilitator-set"])("keeps real nullable flat %s estimates Saved", (provenance) => {
 const env=envelope({facilitatorId:me.id,revealed:true});env.state.roundVersion=17;
 Object.assign(env.state.stories[0],{parentId:null,splitRevision:0,estimate:"3",acceptedRoundVersion:null,estimateProvenance:provenance});
 renderApp(<PokerRoom env={env} me={me}/>);
 expect(screen.queryByText("Votes revealed · estimate not accepted")).toBeNull();
 expect(screen.getByText(/^Saved 3/)).toBeTruthy();
});

it("sends the observed snapshot for Next to an unvoted child", async () => {
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
 const env=envelope({facilitatorId:me.id,revealed:true});env.state.roundVersion=17;
 Object.assign(env.state.stories[0],{estimate:"3",acceptedRoundVersion:17});
 env.state.stories.push({...env.state.stories[0],id:"child",title:"Unvoted child",estimate:null,parentId:"parent"});
 renderApp(<PokerRoom env={env} me={me}/>);
 await userEvent.click(screen.getByRole("button",{ name: /^Next story: .*Unvoted child$/ }));
 expect(screen.queryByRole("dialog")).toBeNull();
 await waitFor(()=>expect(roomCalls(spy).length).toBe(1));
 expect(JSON.parse((roomCalls(spy)[0][1] as RequestInit).body as string)).toMatchObject({storyId:"child",expectedCurrentStoryId:"story-1",expectedRoundVersion:17});
});

it("keeps a nullable split parent acceptance unsaved for the current round", () => {
 const env=envelope({facilitatorId:me.id,revealed:true});env.state.roundVersion=17;
 Object.assign(env.state.stories[0],{parentId:null,splitRevision:2,estimate:"3",acceptedRoundVersion:null,estimateProvenance:"historical"});
 renderApp(<PokerRoom env={env} me={me}/>);
 expect(screen.getByText("Votes revealed · estimate not accepted")).toBeTruthy();
 expect(screen.queryByText(/^Saved 3/)).toBeNull();
});

it("groups a split in the queue and keeps the one editor on its card in the main story area", async () => {
  const env=envelope({facilitatorId:me.id,facilitatorConnected:true});const parent=env.state.stories[0];Object.assign(parent,{planningRole:"context",estimate:"13"});
  env.state.stories.push({...parent,id:"child",title:"API",parentId:parent.id,planningRole:"planning",estimate:null});env.state.currentStoryId="child";
  renderApp(<PokerRoom env={env} me={me}/>);const queue=screen.getByRole("complementary",{name:"Story queue · 1"});
  expect(within(queue).getByText("On the table: API")).toBeTruthy();expect(within(queue).queryByRole("button",{name:"More for API"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"Show the split"}));
  await userEvent.click(screen.getByRole("button",{name:"More for API"}));await userEvent.click(screen.getByRole("button",{name:"Rename or add notes"}));
  expect(screen.getAllByRole("textbox",{name:"Title for API"}).length).toBe(1);
});
it("redacts the whole room when reading authority is refused during reconciliation",async()=>{
  const env=envelope({facilitatorId:me.id});const spy=vi.spyOn(globalThis,"fetch").mockImplementation((input,init)=>{if(String(input).includes("plugins/panels"))return Promise.resolve(new Response("[]"));if(init?.method === "POST")return Promise.reject(new TypeError("response lost"));return Promise.resolve(new Response('{"error":"access removed"}',{status:403}));});
  renderApp(<PokerRoom env={env} me={me}/>);await userEvent.click(screen.getByRole("button",{name:/Too big\? Split it/}));await userEvent.type(screen.getByRole("textbox",{name:"Name a story, then press Enter"}),"Secret draft{Enter}");await screen.findByText("Your access to this room was removed.");expect(screen.queryByText("Rate-limit the join endpoint")).toBeNull();expect(screen.queryByDisplayValue("Secret draft")).toBeNull();expect(roomCalls(spy).length).toBe(2);
});

it("keeps room and queue counts at two planning units when an adopted parent gets a new proposal",()=>{
  const env=envelope({facilitatorId:me.id});const parent={...env.state.stories[0],planningRole:"context" as const,estimate:"13"};env.state.stories=[parent,{...parent,id:"api",title:"API",parentId:parent.id,planningRole:"planning",estimate:"3"},{...parent,id:"ui",title:"UI",parentId:parent.id,planningRole:"planning",estimate:"5"},{...parent,id:"draft",title:"New proposal",parentId:parent.id,planningRole:"proposed",estimate:null}];env.state.currentStoryId="api";
  renderApp(<PokerRoom env={env} me={me}/>);const queue=screen.getByRole("complementary",{name:"Story queue · 2"});expect(within(queue).getByText("2 estimated, 0 not estimated · 1 drafted")).toBeTruthy();expect(within(queue).getByText(/· 2 stories$/)).toBeTruthy();expect(screen.getByText("Split into 2 stories · 1 more drafted")).toBeTruthy();expect(within(screen.getByRole("region",{name:"On the table"})).getByText(/^1 of 2/)).toBeTruthy();expect(within(queue).queryByText(/3 stories/)).toBeNull();
});

it("groups unfinished children beneath context and names stale accepted estimates", () => {
  const env = envelope({ endedAt: "2026-10-10", facilitatorId: me.id });
  const base = env.state.stories[0];
  env.state.stories = [
    { ...base, id: "parent", title: "Original ticket", planningRole: "context", estimate: "13" },
    { ...base, id: "a", parentId: "parent", title: "API", planningRole: "planning", estimate: "3" },
    { ...base, id: "b", parentId: "parent", title: "UI", planningRole: "planning", estimate: "5", estimateNeedsReview: true },
    { ...base, id: "c", parentId: "parent", title: "Remaining scope", planningRole: "planning", estimate: null },
  ];
  env.state.dependencies = [
    {id:"edge-a",parentId:"parent",blockerId:"a",dependentId:"c",reviewState:"planning",retiredAt:null},
    {id:"edge-b",parentId:"parent",blockerId:"removed",dependentId:"c",reviewState:"blocker-removed-review",retiredAt:null},
  ];
  env.state.stories.push({...base,id:"removed",parentId:"parent",title:"Removed permissions",planningRole:"planning",removedAt:"2026-10-10",estimate:null});
  renderApp(<PokerRoom env={env} me={me} />);
  const list = screen.getByRole("list", {name: "Not estimated"});
  expect(within(list).getByText("Original ticket · Parent context")).toBeTruthy();
  expect(within(list).getByText("UI · Needs review · previous 5")).toBeTruthy();
  expect(within(list).getByText("Remaining scope · Unestimated")).toBeTruthy();
  expect(within(list).queryByText("API")).toBeNull();
  expect(within(list).getByText("Blocked by API · Planning dependency · Completion not checked")).toBeTruthy();
  expect(within(list).getByText("Blocked by Removed permissions · Needs review · blocker unavailable or changed")).toBeTruthy();
});

it("offers a reviewed leave-unestimated action without accepting points", async () => {
  const env = envelope({facilitatorId: me.id, revealed: true});
  env.state.roundVersion = 9;
  const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
  renderApp(<PokerRoom env={env} me={me} />);
  await userEvent.click(screen.getByRole("button",{name:"Leave unestimated"}));
  const calls=roomCalls(spy);
  expect(calls).toEqual([["/api/sessions/sess-1/actions/select",expect.objectContaining({method:"POST",body:JSON.stringify({storyId:env.state.currentStoryId,leaveUnestimated:true,expectedCurrentStoryId:env.state.currentStoryId,expectedRoundVersion:9})})]]);
});

it("names the exact blank child on Next and starts its round without a review", async () => {
  const env = envelope({facilitatorId:me.id,revealed:true});
  const base=env.state.stories[0];
  env.state.roundVersion=12;
  env.state.stories=[{...base,id:"parent",title:"Original",planningRole:"context",estimate:"13"},{...base,id:base.id,parentId:"parent",title:"API",planningRole:"planning",estimate:"3",acceptedRoundVersion:12},{...base,id:"blank",parentId:"parent",title:"Remaining scope",planningRole:"planning",estimate:null,votedUserIds:[]}];
  renderApp(<PokerRoom env={env} me={me} />);
  const spy=vi.spyOn(globalThis,"fetch").mockImplementation(answering(new Response(null,{status:204})));
  await userEvent.click(screen.getByRole("button",{ name: /^Next story: .*Remaining scope$/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(()=>expect(roomCalls(spy).some(call=>String(call[0]).endsWith("/actions/select")&&JSON.parse((call[1] as RequestInit).body as string).storyId==="blank")).toBe(true));
});

it("disables leaving a story while the room is reconnecting", () => {
  renderApp(<PokerRoom env={envelope({facilitatorId:me.id})} me={me} status="reconnecting" />);
  expect((screen.getByRole("button",{name:"Leave unestimated"}) as HTMLButtonElement).disabled).toBe(true);
});

it.each(["", "Original ticket"])("keeps the parent identity in view while Next names the story for title %j", async title => {
  const env = envelope({facilitatorId:me.id,revealed:true});
  const base = env.state.stories[0]; env.state.roundVersion = 12;
  env.state.stories = [
    {...base,id:"parent",parentId:null,title,ref:"PAR-142",planningRole:"context",estimate:"13"},
    {...base,parentId:"parent",title:"API",planningRole:"planning",estimate:"3",acceptedRoundVersion:12},
    {...base,id:"blank",parentId:"parent",title:"Remaining scope",planningRole:"planning",estimate:null,votedUserIds:[]},
  ];
  renderApp(<PokerRoom env={env} me={me} />);
  expect(screen.getByRole("heading",{name:title || "PAR-142"})).toBeTruthy();
  expect(screen.getByText("Split into 2 stories")).toBeTruthy();
  expect(screen.getByRole("button",{ name: /^Next story: .*Remaining scope$/ })).toBeTruthy();
});

describe("splitting the story on the table", () => {
  const ticket = () => document.querySelector("header") as HTMLElement;
  const hand = () => document.querySelector("[data-poker-hand]") as HTMLElement;
  const composer = () => screen.queryByRole("textbox", { name: "Name a story, then press Enter" }) as HTMLInputElement | null;
  function drafted() {
    const env = envelope({ facilitatorConnected: true });
    const parent = env.state.stories[0];
    env.state.stories.push(
      { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: parent.id, planningRole: "proposed" },
      { ...parent, id: "b", ref: "", title: "Shared counter", parentId: parent.id, planningRole: "proposed" },
    );
    env.state.dependencies = [{ id: "edge", parentId: parent.id, blockerId: "a", dependentId: "b", reviewState: "planning", retiredAt: null }];
    return env;
  }

  it("shows nothing of it in an ordinary round, and one quiet entry to the facilitator alone", () => {
    const seat = renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={me} />);
    expect(screen.queryByRole("button", { name: /Split it/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
    expect(composer()).toBeNull();
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
    seat.unmount();
    renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} />);
    expect(screen.getAllByRole("button", { name: /Split it/ }).length).toBe(1);
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
    expect(composer()).toBeNull();
  });

  it("withdraws the entry from an ended room, a reconnecting one and a child story", () => {
    const ended = renderApp(<PokerRoom env={envelope({ facilitatorId: me.id, endedAt: "2026-10-10" })} me={me} />);
    expect(screen.queryByRole("button", { name: /Split it/ })).toBeNull();
    ended.unmount();
    const paused = renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} status="reconnecting" />);
    expect(screen.queryByRole("button", { name: /Split it/ })).toBeNull();
    paused.unmount();
    const env = envelope({ facilitatorId: me.id });
    env.state.stories[0].parentId = "elsewhere";
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByRole("button", { name: /Split it/ })).toBeNull();
  });

  it("opens from its entry with the input focused and empty, slims the ticket and tucks the table and hand away", async () => {
    renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Too big? Split it" }));
    const input = composer()!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    expect(ticket().getAttribute("data-fan-strip")).toBe("slim");
    expect(within(ticket()).getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(within(ticket()).getByText("Splitting")).toBeTruthy();
    expect(hand().hasAttribute("data-tucked")).toBe(true);
    expect(hand().hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
    await userEvent.keyboard("s");
    expect(input.value).toBe("s");
  });

  it("has no single-key shortcut: a stray S opens nothing, even for the facilitator", async () => {
    renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} />);
    await userEvent.keyboard("s");
    await userEvent.keyboard("S");
    expect(composer()).toBeNull();
    expect(screen.getByRole("button", { name: "Too big? Split it" }).hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("puts the ticket back when a split with no cards is canceled", async () => {
    renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: /Split it/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(composer()).toBeNull();
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Split it/ }));
  });

  it("gives a participant the strip, the arriving cards and their links, with the hand tucked and nothing to press", () => {
    const view = renderApp(<PokerRoom env={envelope({ facilitatorConnected: true })} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    view.rerender(<PokerRoom env={{ ...drafted(), version: 2 }} me={me} />);
    expect(ticket().getAttribute("data-fan-strip")).toBe("slim");
    const fan = screen.getByRole("region", { name: "Stories split from Rate-limit the join endpoint" });
    expect(within(fan).getAllByRole("listitem").filter((card) => card.dataset.storyId).length).toBe(2);
    expect(within(fan).getByText("waits on Throttle per key")).toBeTruthy();
    expect(within(fan).queryAllByRole("button")).toEqual([]);
    expect(within(fan).queryByRole("textbox")).toBeNull();
    expect(within(fan).queryByText("Anything left over?")).toBeNull();
    expect(hand().hasAttribute("data-tucked")).toBe(true);
    expect(screen.queryByText(/only the facilitator/i)).toBeNull();
  });

  it("puts the story on the table under the fan, with the round's controls beside it and not in the strip", () => {
    const env = envelope({ facilitatorId: me.id });
    const parent = { ...env.state.stories[0], planningRole: "context" as const };
    env.state.stories = [
      parent,
      { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: parent.id, planningRole: "planning", estimate: "3" },
      { ...parent, id: "b", ref: "", title: "Shared counter", parentId: parent.id, planningRole: "planning" },
    ];
    env.state.currentStoryId = "b";
    renderApp(<PokerRoom env={env} me={me} />);
    const onTable = screen.getByRole("region", { name: "On the table" });
    expect(within(onTable).getByRole("heading", { name: "Shared counter" })).toBeTruthy();
    expect(within(onTable).getByText("2 of 2")).toBeTruthy();
    expect(within(onTable).getByRole("button", { name: "Reveal votes for Shared counter" })).toBeTruthy();
    expect(within(onTable).getByRole("button", { name: "Leave unestimated" })).toBeTruthy();
    expect(within(ticket()).queryByRole("button", { name: /Reveal/ })).toBeNull();
    expect(within(ticket()).getByRole("button", { name: "Add stories" })).toBeTruthy();
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    expect(screen.queryByRole("button", { name: /Split it/ })).toBeNull();
  });

  it("opens a split from the queue beside an unrelated round, and goes back to the table", async () => {
    const env = envelope({ facilitatorConnected: true });
    const parent = { ...env.state.stories[0], id: "split", title: "Earlier ticket", ref: "PLAT-400", planningRole: "context" as const };
    env.state.stories.push(parent, { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: "split", planningRole: "planning", estimate: "3" });
    renderApp(<PokerRoom env={env} me={me} />);
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Earlier ticket" }));
    expect(within(ticket()).getByRole("heading", { name: "Earlier ticket" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "On the table" })).getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Back to the table" }));
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
  });

  it("has no axe violations mid-split for the facilitator", async () => {
    const view = renderApp(<PokerRoom env={envelope({ facilitatorId: me.id })} me={me} />);
    view.rerender(<PokerRoom env={{ ...drafted(), facilitatorId: me.id, version: 2 }} me={me} />);
    expect(composer()).toBeTruthy();
    expect(hand().hasAttribute("data-tucked")).toBe(true);
    await expectNoViolations(view.container);
  });

  function parked(over: Partial<Envelope> = {}) {
    const env = { ...drafted(), ...over };
    env.state.stories[0].draftsParked = true;
    return env;
  }
  const parkRequests = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .filter((call) => String(call[0]).includes("/actions/park-drafts"))
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));

  it("gives everyone a votable round when a story is dealt with drafts already under it, and keeps the drafts one press away", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const env = parked({ facilitatorId: me.id });
    env.state.stories[0].votedUserIds = ["dana"];
    const view = renderApp(<PokerRoom env={env} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    expect(hand().hasAttribute("inert")).toBe(false);
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
    expect(within(ticket()).getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByText("2 draft stories")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
    await expectNoViolations(view.container);

    await userEvent.click(screen.getByRole("button", { name: "Continue splitting" }));
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: false }]));
    spy.mockRestore();
  });

  it("puts a tucked split back behind the round for everyone when the facilitator goes back to the table", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<PokerRoom env={{ ...drafted(), facilitatorId: me.id }} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Back to the table" }));
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: true }]));
    spy.mockRestore();
  });

  it("says in the room's error row when the drafts could not be brought back", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      answering(new Response(JSON.stringify({ error: "this story is not an active planning unit" }), { status: 409 })),
    );
    renderApp(<PokerRoom env={parked({ facilitatorId: me.id })} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue splitting" }));
    expect(await screen.findByText("this story is not an active planning unit")).toBeTruthy();
    expect(screen.getByText("2 draft stories")).toBeTruthy();
    spy.mockRestore();
  });

  it("shows a participant the dealt story and its hand, with the drafts as a count and nothing to press for them", () => {
    renderApp(<PokerRoom env={parked()} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    expect(screen.getByText("2 draft stories")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue splitting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the table" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
  });

  it("keeps a split that is being drafted on the table tucked for someone who opens the room partway through", () => {
    renderApp(<PokerRoom env={drafted()} me={me} />);
    expect(hand().hasAttribute("data-tucked")).toBe(true);
    expect(screen.getByRole("list", { name: "Stories in this split" })).toBeTruthy();
    expect(screen.queryByText("2 draft stories")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the table" })).toBeNull();
  });

  function undoneBesideAFlatStory(): Envelope {
    const env = committedBesideAFlatStory();
    env.version += 1;
    env.state.currentStoryId = "flat";
    env.state.stories = env.state.stories.map((story) =>
      story.id === "story-1"
        ? { ...story, planningRole: "planning" as const, draftsParked: true }
        : story.parentId === "story-1"
          ? { ...story, planningRole: "proposed" as const }
          : story,
    );
    return env;
  }
  function servingUndo(after: Envelope) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/plugins/panels")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (init?.method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify(after), { status: 200 }));
    });
  }
  const queue = () => screen.getByRole("complementary", { name: /Story queue/ });

  it("leaves the split view when a split shown from the queue is undone, and says the ticket is one story with its drafts kept", async () => {
    const env = committedBesideAFlatStory();
    env.state.currentStoryId = "flat";
    const spy = servingUndo(undoneBesideAFlatStory());
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Rate-limit the join endpoint" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo split" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Undo this split?" })).getByRole("button", { name: "Undo split" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull());
    expect(ticket().getAttribute("data-fan-strip")).toBe("ticket");
    expect(within(ticket()).getByRole("heading", { name: "Unrelated ticket" })).toBeTruthy();
    expect(composer()).toBeNull();
    expect(screen.queryByText("Splitting")).toBeNull();
    expect(within(queue()).queryByText(/splitting/i)).toBeNull();
    expect(within(queue()).queryByRole("button", { name: /Show the split of Rate-limit/ })).toBeNull();
    expect(within(queue()).getByRole("button", { name: "Continue splitting Rate-limit the join endpoint, 2 draft stories" })).toBeTruthy();
    expect(await screen.findByText("Split undone. PLAT-412 is one story again. 2 draft stories are kept.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(queue()).getByRole("button", { name: "Deal Rate-limit the join endpoint" })));
    spy.mockRestore();
  });

  it("lands on the ticket's Deal after an undo also when the ticket keeps a total that needs review", async () => {
    const env = committedBesideAFlatStory();
    env.state.currentStoryId = "flat";
    const undone = undoneBesideAFlatStory();
    Object.assign(undone.state.stories[0], { estimate: "16", estimateProvenance: "story-total", estimateNeedsReview: true, splitRevision: 7 });
    const spy = servingUndo(undone);
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Rate-limit the join endpoint" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo split" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Undo this split?" })).getByRole("button", { name: "Undo split" }));
    await waitFor(() => expect(document.activeElement).toBe(within(queue()).getByRole("button", { name: "Deal Rate-limit the join endpoint" })));
    spy.mockRestore();
  });

  it("names the rename when Back to the table is held back by one that is not saved", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<PokerRoom env={{ ...drafted(), facilitatorId: me.id }} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename or add notes to Throttle per key" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Title for Throttle per key" }), " v2");
    await userEvent.click(screen.getByRole("button", { name: "Back to the table" }));
    expect(await screen.findByText("Save or cancel the rename first")).toBeTruthy();
    expect(parkRequests(spy)).toEqual([]);
    spy.mockRestore();
  });

  it("does not let text typed before the undo hold the split open", async () => {
    const env = committedBesideAFlatStory();
    env.state.currentStoryId = "flat";
    const spy = servingUndo(undoneBesideAFlatStory());
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Rate-limit the join endpoint" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Throttle per key" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes for Throttle per key" }), "half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Undo split" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Undo this split?" })).getByRole("button", { name: "Undo split" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull());
    spy.mockRestore();
  });

  it("never puts a story whose drafts are set aside on stage by itself", () => {
    const env = undoneBesideAFlatStory();
    env.state.currentStoryId = null;
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
    expect(screen.queryByText("Splitting")).toBeNull();
    expect(screen.getByText("Nothing on the table")).toBeTruthy();
  });

  it("reopens set-aside drafts from the queue for everyone, and shows the split once the room says so", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const env = undoneBesideAFlatStory();
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(within(queue()).getByRole("button", { name: "Continue splitting Rate-limit the join endpoint, 2 draft stories" }));
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: false }]));
    const reopened: Envelope = {
      ...env,
      version: env.version + 1,
      state: { ...env.state, stories: env.state.stories.map((story) => (story.id === "story-1" ? { ...story, draftsParked: false } : story)) },
    };
    view.rerender(<PokerRoom env={reopened} me={me} />);
    await waitFor(() => expect(screen.getByRole("list", { name: "Stories in this split" })).toBeTruthy());
    expect(composer()).toBeTruthy();
    spy.mockRestore();
  });

  it("shows a participant set-aside drafts in the queue as a count, with no split on stage and nothing to press", () => {
    const env = { ...undoneBesideAFlatStory(), facilitatorId: "dana" };
    renderApp(<PokerRoom env={env} me={me} />);
    expect(within(queue()).getByText("2 draft stories")).toBeTruthy();
    expect(within(queue()).queryByRole("button", { name: /draft stor/ })).toBeNull();
    expect(within(queue()).queryByText(/splitting/i)).toBeNull();
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
  });

  function committedBesideAFlatStory() {
    const env = envelope({ facilitatorId: me.id });
    const parent = { ...env.state.stories[0], planningRole: "context" as const };
    env.state.stories = [
      parent,
      { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: parent.id, planningRole: "planning", estimate: "3" },
      { ...parent, id: "b", ref: "", title: "Shared counter", parentId: parent.id, planningRole: "planning" },
      { ...parent, id: "flat", ref: "PLAT-9", title: "Unrelated ticket", planningRole: "planning" },
      { ...parent, id: "flat-two", ref: "PLAT-10", title: "Second unrelated ticket", planningRole: "planning" },
    ];
    env.state.currentStoryId = "b";
    return env;
  }
  const dealtElsewhere = (env: Envelope, storyId: string): Envelope => ({ ...env, version: env.version + 1, state: { ...env.state, currentStoryId: storyId } });

  it("keeps a split that opened by itself, and the text typed into it, when another story is dealt from elsewhere", async () => {
    const env = committedBesideAFlatStory();
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Throttle per key" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes for Throttle per key" }), "half a thought");
    view.rerender(<PokerRoom env={dealtElsewhere(env, "flat")} me={me} />);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "On the table" })).getByRole("heading", { name: "Unrelated ticket" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Notes for Throttle per key" }) as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("keeps a split opened from the queue, and the text typed into it, when the table changes", async () => {
    const env = committedBesideAFlatStory();
    env.state.currentStoryId = "flat";
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Rate-limit the join endpoint" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Throttle per key" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes for Throttle per key" }), "half a thought");
    view.rerender(<PokerRoom env={dealtElsewhere(env, "flat-two")} me={me} />);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "On the table" })).getByRole("heading", { name: "Second unrelated ticket" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Notes for Throttle per key" }) as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("opens a split whose stories were all removed, so they can be restored", async () => {
    const env = envelope({ facilitatorId: me.id });
    const parent = { ...env.state.stories[0], id: "split", title: "Earlier ticket", ref: "PLAT-400" };
    env.state.stories.push(parent, { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: "split", planningRole: "proposed", removedAt: "2026-10-10" });
    const seat = renderApp(<PokerRoom env={{ ...env, facilitatorId: "dana" }} me={me} />);
    expect(within(queue()).queryByText(/splitting|drafted/i)).toBeNull();
    expect(within(queue()).queryByRole("button", { name: /removed stor/ })).toBeNull();
    seat.unmount();
    renderApp(<PokerRoom env={env} me={me} />);
    expect(within(queue()).queryByText(/splitting|drafted/i)).toBeNull();
    expect(within(queue()).getByRole("button", { name: "Deal Earlier ticket" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the removed story of Earlier ticket" }));
    expect(within(ticket()).getByRole("heading", { name: "Earlier ticket" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo removal of Throttle per key" })).toBeTruthy();
  });

  it("sends the round it ends when an estimate is set from the card whose round is live", async () => {
    const env = committedBesideAFlatStory();
    env.state.roundVersion = 9;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/plugins/panels")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (init?.method === "PATCH") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify(env), { status: 200 }));
    });
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
    await userEvent.click(screen.getByRole("button", { name: "Set estimate for Shared counter" }));
    await userEvent.click(screen.getByRole("button", { name: "Estimate Shared counter at 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm estimating Shared counter at 5" }));
    await waitFor(() => expect(fetchSpy.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true));
    const sent = JSON.parse(fetchSpy.mock.calls.find((call) => call[1]?.method === "PATCH")![1]!.body as string);
    expect(sent).toMatchObject({ storyId: "b", estimate: "5", endRound: true, expectedCurrentStoryId: "b", expectedRoundVersion: 9 });
    await userEvent.click(screen.getByRole("button", { name: "Change estimate for Throttle per key" }));
    await userEvent.click(screen.getByRole("button", { name: "Estimate Throttle per key at 5" }));
    await waitFor(() => expect(fetchSpy.mock.calls.filter((call) => call[1]?.method === "PATCH").length).toBe(2));
    const offTable = JSON.parse(fetchSpy.mock.calls.filter((call) => call[1]?.method === "PATCH")[1][1]!.body as string);
    expect(offTable.endRound).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("shows a refused estimate on the card it was set on, not in the room's error row", async () => {
    const env = committedBesideAFlatStory();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/plugins/panels")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "story or split changed; review latest and your input before saving" }), { status: 409 }));
      }
      return Promise.resolve(new Response(JSON.stringify(env), { status: 200 }));
    });
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
    await userEvent.click(screen.getByRole("button", { name: "Change estimate for Throttle per key" }));
    await userEvent.click(screen.getByRole("button", { name: "Estimate Throttle per key at 5" }));
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toBe("story or split changed; review latest and your input before saving");
    expect(refusal.closest("[data-story-id]")?.getAttribute("data-story-id")).toBe("a");
    fetchSpy.mockRestore();
  });

  it("names the story on the table by its place in its own split while another split is shown", async () => {
    const env = committedBesideAFlatStory();
    const other = { ...env.state.stories[0], id: "split", title: "Earlier ticket", ref: "PLAT-400", planningRole: "context" as const };
    env.state.stories.push(
      other,
      { ...other, id: "x", ref: "", title: "First half", parentId: "split", planningRole: "planning" },
      { ...other, id: "y", ref: "", title: "Second half", parentId: "split", planningRole: "planning" },
    );
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split of Earlier ticket" }));
    const table = screen.getByRole("region", { name: "On the table" });
    expect(within(table).getByRole("heading", { name: "Shared counter" })).toBeTruthy();
    expect(within(table).getByText("2 of 2")).toBeTruthy();
    expect(within(table).queryByText(/ad hoc/)).toBeNull();
  });

  it("puts focus on the round after a story is dealt from its card", async () => {
    const env = committedBesideAFlatStory();
    env.state.currentStoryId = null;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Deal Shared counter" }));
    view.rerender(<PokerRoom env={dealtElsewhere(env, "b")} me={me} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "On the table" })));
    spy.mockRestore();
  });

  it("puts focus on the ticket heading after Back to the table, not on the control that would bring the drafts back", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const env = { ...drafted(), facilitatorId: me.id };
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Back to the table" }));
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: true }]));
    view.rerender(<PokerRoom env={{ ...parked({ facilitatorId: me.id }), version: env.version + 1 }} me={me} />);
    await screen.findByRole("button", { name: "Continue splitting" });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    spy.mockRestore();
  });

  it("keeps Back to the table in view while text is typed, and asks for the text to be added or cleared instead of leaving", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<PokerRoom env={{ ...drafted(), facilitatorId: me.id }} me={me} />);
    await userEvent.type(composer()!, "half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Back to the table" }));
    expect(await screen.findByText("Add or clear what you typed first")).toBeTruthy();
    expect(parkRequests(spy)).toEqual([]);
    expect(composer()!.value).toBe("half a thought");
    spy.mockRestore();
  });

  it("goes back to the table on Escape from an empty input, and only clears typed text on the first one", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<PokerRoom env={{ ...drafted(), facilitatorId: me.id }} me={me} />);
    await userEvent.type(composer()!, "half{Escape}");
    expect(composer()!.value).toBe("");
    expect(parkRequests(spy)).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: true }]));
    expect(spy.mock.calls.some((call) => String(call[0]).includes("/actions/remove-child"))).toBe(false);
    spy.mockRestore();
  });

  it("brings the split back for everyone when a story is added to drafts that were set aside from another tab", async () => {
    const env = { ...drafted(), facilitatorId: me.id };
    const setAside = { ...parked({ facilitatorId: me.id }), version: env.version + 1 };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/plugins/panels")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (String(input).includes("/actions/child")) return Promise.resolve(new Response(JSON.stringify({ storyId: "c", contentRevision: 0, splitRevision: 3 }), { status: 201 }));
      if (init?.method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify(setAside), { status: 200 }));
    });
    const view = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.type(composer()!, "Third story");
    view.rerender(<PokerRoom env={setAside} me={me} />);
    expect(composer()!.value).toBe("Third story");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(parkRequests(spy)).toEqual([{ parentId: "story-1", parked: false }]));
    expect(screen.getByRole("list", { name: "Stories in this split" })).toBeTruthy();
    expect(composer()).toBeTruthy();
    spy.mockRestore();
  });

  it("tells a participant when a split is undone, since the split view they were reading goes away", async () => {
    const env = { ...committedBesideAFlatStory(), facilitatorId: "dana" };
    const view = renderApp(<PokerRoom env={env} me={me} />);
    view.rerender(<PokerRoom env={{ ...undoneBesideAFlatStory(), facilitatorId: "dana" }} me={me} />);
    expect(await screen.findByText("Split undone. PLAT-412 is one story again. 2 draft stories are kept.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
  });

  it("scrolls the round's controls clear of the hand tray when a story is dealt under a tall split", async () => {
    const env = committedBesideAFlatStory();
    const scrolled = vi.fn();
    const originalScrollBy = window.scrollBy;
    window.scrollBy = scrolled as unknown as typeof window.scrollBy;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isTable = this.getAttribute("aria-label") === "On the table";
      const top = this.hasAttribute("data-poker-hand") ? 800 : isTable ? 760 : this.tagName === "BUTTON" ? 770 : 0;
      const height = isTable ? 120 : this.tagName === "BUTTON" ? 44 : 0;
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 124 }), { timeout: 2000 });
    rectSpy.mockRestore();
    window.scrollBy = originalScrollBy;
    window.sessionStorage.clear();
  });
});

describe("estimating a committed split one story after another", () => {
  const ROUND = 21;
  const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
  const actionCalls = (spy: { mock: { calls: unknown[][] } }) => roomCalls(spy).filter((call) => String(call[0]).includes("/actions/"));
  function committed(over: { viewer?: Me; current?: string | null; revealed?: boolean } = {}) {
    const viewer = over.viewer ?? me;
    const env = envelope({ facilitatorId: me.id, facilitatorConnected: true, revealed: over.revealed ?? true });
    const base = env.state.stories[0];
    env.state.roundVersion = ROUND;
    env.state.currentStoryId = over.current === undefined ? "a" : over.current;
    env.state.stories = [
      { ...base, id: "other", ref: "PLAT-1", title: "Other ticket", position: 0, estimate: null },
      { ...base, id: "parent", ref: "PAR-150", title: "Checkout", position: 1, planningRole: "context", estimate: null, contentRevision: 4, splitRevision: 3, coverage: "full" },
      { ...base, id: "a", ref: "", title: "Cart", parentId: "parent", planningRole: "planning", position: 2, estimate: "3", acceptedRoundVersion: ROUND, contentRevision: 2 },
      { ...base, id: "b", ref: "", title: "Payment", parentId: "parent", planningRole: "planning", position: 3, estimate: null, contentRevision: 1 },
      { ...base, id: "c", ref: "", title: "Address", parentId: "parent", planningRole: "planning", position: 4, estimate: null, contentRevision: 1 },
    ] as Envelope["state"]["stories"];
    return { env, viewer };
  }
  const story = (env: Envelope, id: string) => env.state.stories.find((candidate) => candidate.id === id)!;
  const settle = (env: Envelope, ...ids: string[]) => ids.forEach((id) => Object.assign(story(env, id), { estimate: "5" }));
  const question = () => screen.queryByRole("group", { name: "All 3 stories are estimated. What about PAR-150?" });

  it("goes from a saved story to the next story of the same split without a review, never to another ticket", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed();
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Next story: Payment" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(String(actionCalls(spy)[0][0])).toBe("/api/sessions/sess-1/actions/select");
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ storyId: "b", expectedCurrentStoryId: "a", expectedRoundVersion: ROUND });
  });

  it("wraps past the stories that are settled and stays in the split while one is open", () => {
    const { env } = committed({ current: "c" });
    Object.assign(story(env, "c"), { estimate: "5", acceptedRoundVersion: ROUND });
    Object.assign(story(env, "a"), { acceptedRoundVersion: 3 });
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.getByRole("button", { name: "Next story: Payment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next story: .*Other ticket$/ })).toBeNull();
  });

  it("asks about a fresh round only when the next story holds earlier votes, and talks about that story", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed();
    story(env, "b").votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Next story: Payment" }));
    const dialog = screen.getByRole("dialog", { name: "Start a fresh round on Payment?" });
    expect(dialog.textContent).toContain("Payment still holds votes from an earlier round");
    expect(dialog.textContent).not.toMatch(/children|child/i);
    expect(actionCalls(spy).length).toBe(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Start fresh round" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toMatchObject({ storyId: "b", freshRound: true, expectedCurrentStoryId: "a", expectedRoundVersion: ROUND });
  });

  it("offers the next story after a round that produced no estimate to save", () => {
    const { env } = committed();
    Object.assign(story(env, "a"), { estimate: null, acceptedRoundVersion: null, votes: [{ userId: "dana", value: "?" }], results: { histogram: [{ value: "?", count: 1 }], consensus: true } });
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Next story: Payment" })).toBeTruthy();
  });

  it("keeps a way forward when the round was closed and nothing is on the table", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Next story: Payment" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ storyId: "b", expectedCurrentStoryId: "", expectedRoundVersion: ROUND });
  });

  it("asks what to do about the ticket once the last story is settled, with focus on the question itself and on none of its answers", async () => {
    const { env } = committed({ current: "c" });
    settle(env, "b", "c");
    Object.assign(story(env, "c"), { acceptedRoundVersion: ROUND });
    renderApp(<PokerRoom env={env} me={me} />);
    const group = question()!;
    expect(group).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Use the total: 13" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Estimate PAR-150 with the team" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(group));
    expect(group.getAttribute("tabindex")).toBe("-1");
    expect(group.getAttribute("aria-labelledby")).toBe("parent-estimate-question");
    await userEvent.tab();
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: "Use the total: 13" }));
    expect(screen.queryByRole("button", { name: /^Next story/ })).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-question-announcement]")?.textContent).toContain("All 3 stories are estimated. What about PAR-150?"));
  });

  it("records the total it showed with the revisions it saw", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(within(question()!).getByRole("button", { name: "Use the total: 13" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(String(actionCalls(spy)[0][0])).toBe("/api/sessions/sess-1/actions/parent-estimate");
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ parentId: "parent", answer: "total", expectedRevision: 4, expectedSplitRevision: 3, expectedTotal: "13", children: { a: 2, b: 1, c: 1 } });
  });

  it("leaves the ticket without an estimate on Escape from the question itself, and records nothing on Enter there", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    renderApp(<PokerRoom env={env} me={me} />);
    await waitFor(() => expect(document.activeElement).toBe(question()));
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(actionCalls(spy).length).toBe(0);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ parentId: "parent", answer: "none", expectedSplitRevision: 3 });
  });

  it("focuses the answer that writes nothing when the facilitator asks the question again from the strip", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    story(env, "parent").parentEstimateAnsweredRevision = 3;
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Estimate PAR-150" }));
    await waitFor(() => expect(document.activeElement).toBe(within(question()!).getByRole("button", { name: "Leave it without an estimate" })));
  });

  it.each(["button", "Escape"])("records that the ticket is left without an estimate (%s)", async (way) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    renderApp(<PokerRoom env={env} me={me} />);
    const leave = within(question()!).getByRole("button", { name: "Leave it without an estimate" });
    if (way === "button") await userEvent.click(leave);
    else {
      leave.focus();
      await userEvent.keyboard("{Escape}");
    }
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ parentId: "parent", answer: "none", expectedSplitRevision: 3 });
  });

  it("moves focus to the table region when the question closes, never to a control that deals or saves", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    const first = renderApp(<PokerRoom env={env} me={me} />);
    within(question()!).getByRole("button", { name: "Leave it without an estimate" }).focus();
    await userEvent.keyboard("{Escape}");
    const answered = structuredClone(env);
    answered.state.stories.find((story) => story.id === "parent")!.parentEstimateAnsweredRevision = 3;
    first.rerender(<PokerRoom env={answered} me={me} />);
    await waitFor(() => expect(question()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "On the table" })));
    expect(screen.getByRole("button", { name: /^Next story: .*Other ticket$/ })).toBeTruthy();
  });

  it("deals the ticket itself for a team round, reviewing a fresh round only when it holds votes", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    const first = renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(within(question()!).getByRole("button", { name: "Estimate PAR-150 with the team" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toEqual({ storyId: "parent", expectedCurrentStoryId: "", expectedRoundVersion: ROUND });
    first.unmount();
    spy.mockClear();

    story(env, "parent").votedUserIds = ["dana"];
    renderApp(<PokerRoom env={env} me={me} />);
    await userEvent.click(within(question()!).getByRole("button", { name: "Estimate PAR-150 with the team" }));
    expect(actionCalls(spy).length).toBe(0);
    await userEvent.click(within(screen.getByRole("dialog", { name: "Start a fresh round on Checkout?" })).getByRole("button", { name: "Start fresh round" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toMatchObject({ storyId: "parent", freshRound: true });
  });

  it("offers no total when a deck is not numeric", () => {
    const { env } = committed({ current: null, revealed: false });
    env.state.deck = { name: "tshirt", values: ["S", "M", "L"], ordinal: true };
    for (const id of ["a", "b", "c"]) story(env, id).estimate = "M";
    renderApp(<PokerRoom env={env} me={me} />);
    const group = question()!;
    expect(within(group).queryByRole("button", { name: /^Use the total/ })).toBeNull();
    expect(within(group).getByRole("button", { name: "Estimate PAR-150 with the team" })).toBeTruthy();
  });

  it("never shows the question to a participant", () => {
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    env.facilitatorId = "dana";
    renderApp(<PokerRoom env={env} me={me} />);
    expect(question()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use the total|with the team$|^Estimate PAR-150$/ })).toBeNull();
  });

  it("does not ask again once the question was answered for this split, and reopens it from the ticket strip", async () => {
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    story(env, "parent").parentEstimateAnsweredRevision = 3;
    renderApp(<PokerRoom env={env} me={me} />);
    expect(question()).toBeNull();
    expect(screen.getByRole("button", { name: /^Next story: .*Other ticket$/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Estimate PAR-150" }));
    expect(question()).toBeTruthy();
  });

  it("holds back other tickets until the question about this one is answered", () => {
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    renderApp(<PokerRoom env={env} me={me} />);
    expect(question()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next story/ })).toBeNull();
  });

  it("shows everyone the total with where it came from, and offers the facilitator a refresh when it is out of date", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    Object.assign(story(env, "parent"), { estimate: "13", estimateProvenance: "story-total", parentEstimateAnsweredRevision: 3 });
    const fresh = renderApp(<PokerRoom env={{ ...env, facilitatorId: "dana" }} me={me} />);
    expect(screen.getByText((_, node) => node?.textContent === "13 · Story total")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Refresh the total/ })).toBeNull();
    fresh.unmount();

    Object.assign(story(env, "parent"), { estimate: "11", estimateNeedsReview: true });
    renderApp(<PokerRoom env={env} me={me} />);
    expect(screen.getByText((_, node) => node?.textContent === "Needs review · previous 11")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh the total: 13" }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toMatchObject({ parentId: "parent", answer: "total", expectedTotal: "13" });
  });

  it("asks about the split whose story was last on the table, not another finished split", () => {
    const { env } = committed({ current: "c" });
    settle(env, "b", "c");
    const base = story(env, "other");
    env.state.stories.push(
      { ...base, id: "later", ref: "PAR-151", title: "Search", position: 9, planningRole: "context", estimate: "8", estimateProvenance: "story-total", splitRevision: 2, parentEstimateAnsweredRevision: 2 },
      { ...base, id: "x", ref: "", title: "Facets", parentId: "later", planningRole: "planning", position: 10, estimate: "3" },
      { ...base, id: "y", ref: "", title: "Sorting", parentId: "later", planningRole: "planning", position: 11, estimate: "5" },
    );
    story(env, "other").estimate = "2";
    const view = renderApp(<PokerRoom env={env} me={me} />);
    const closed = { ...env, revealed: false, state: { ...env.state, currentStoryId: null, stories: env.state.stories.map((candidate) => (candidate.id === "c" ? { ...candidate, acceptedRoundVersion: 3 } : candidate)) } };
    view.rerender(<PokerRoom env={closed} me={me} />);
    expect(question()).toBeTruthy();
  });

  it("presents the question without accessibility violations", async () => {
    const { env } = committed({ current: null, revealed: false });
    settle(env, "b", "c");
    const { container } = renderApp(<PokerRoom env={env} me={me} />);
    expect(question()).toBeTruthy();
    await expectNoViolations(container);
  });

  it("runs an ordinary round on a committed ticket that is on the table, saved as a Poker result", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
    const { env } = committed({ current: "parent" });
    settle(env, "b", "c");
    Object.assign(story(env, "parent"), { parentEstimateAnsweredRevision: 3, votedUserIds: ["dana"], votes: [{ userId: "dana", value: "8" }], results: { histogram: [{ value: "8", count: 1 }], median: 8, average: 8, consensus: true } });
    renderApp(<PokerRoom env={env} me={me} />);
    const table = screen.getByRole("region", { name: "On the table" });
    expect(within(table).getByRole("heading", { name: "Checkout" })).toBeTruthy();
    expect(within(table).queryByRole("button", { name: "Set estimate" })).toBeNull();
    expect(question()).toBeNull();
    await userEvent.click(within(table).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(actionCalls(spy).length).toBe(1));
    expect(bodyOf(actionCalls(spy)[0])).toMatchObject({ storyId: "parent", estimate: "8", acceptanceMode: "poker", expectedRoundVersion: ROUND });
  });

  describe("after the QA gate", () => {
    const pending = () =>
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
        if (String(input).includes("/actions/")) return new Promise<Response>(() => {});
        return Promise.resolve(new Response("[]", { status: 200 }));
      });
    function due() {
      const { env } = committed({ current: null, revealed: false });
      settle(env, "b", "c");
      return env;
    }

    it("sends one answer to the ticket question however often and whichever answers are pressed while it is on its way", async () => {
      const spy = pending();
      renderApp(<PokerRoom env={due()} me={me} />);
      const total = within(question()!).getByRole("button", { name: "Use the total: 13" });
      await userEvent.click(total);
      await userEvent.click(total);
      await userEvent.click(within(question()!).getByRole("button", { name: "Estimate PAR-150 with the team" }));
      await userEvent.click(within(question()!).getByRole("button", { name: "Leave it without an estimate" }));
      expect(actionCalls(spy).length).toBe(1);
      expect(String(actionCalls(spy)[0][0])).toContain("/actions/parent-estimate");
      expect(document.activeElement).toBe(within(question()!).getByRole("button", { name: "Leave it without an estimate" }));
    });

    it("deals the next story once however often the advance button is pressed", async () => {
      const spy = pending();
      const { env } = committed();
      renderApp(<PokerRoom env={env} me={me} />);
      const next = screen.getByRole("button", { name: "Next story: Payment" });
      await userEvent.click(next);
      await userEvent.click(next);
      expect(actionCalls(spy).length).toBe(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("refreshes a total once however often it is pressed", async () => {
      const spy = pending();
      const { env } = committed({ current: null, revealed: false });
      settle(env, "b", "c");
      Object.assign(story(env, "parent"), { estimate: "11", estimateProvenance: "story-total", estimateNeedsReview: true, parentEstimateAnsweredRevision: 3 });
      renderApp(<PokerRoom env={env} me={me} />);
      const refresh = screen.getByRole("button", { name: "Refresh the total: 13" });
      await userEvent.click(refresh);
      await userEvent.click(refresh);
      expect(actionCalls(spy).length).toBe(1);
    });

    it("announces the ticket question without taking focus out of a field the facilitator is typing in", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: null, revealed: false });
      settle(env, "b");
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "More for Cart" }));
      await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
      const title = screen.getByRole("textbox", { name: "Title for Cart" });
      await userEvent.type(title, " v2");
      const settled = structuredClone(env);
      settle(settled, "c");
      view.rerender(<PokerRoom env={settled} me={me} />);
      expect(question()).toBeTruthy();
      await waitFor(() => expect(document.querySelector("[data-question-announcement]")?.textContent).toContain("What about PAR-150?"));
      expect(document.querySelector("[data-toast]")?.textContent ?? "").not.toContain("What about PAR-150?");
      expect(document.activeElement).toBe(title);
    });

    it("moves focus to the table region after Reveal and after Save, never to the next control that would commit", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: "b", revealed: false });
      story(env, "b").votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const reveal = screen.getByRole("button", { name: "Reveal votes for Payment" });
      reveal.focus();
      await userEvent.keyboard("{Enter}");
      const revealed = structuredClone(env);
      revealed.revealed = true;
      Object.assign(story(revealed, "b"), { votes: [{ userId: "dana", value: "5" }], results: { histogram: [{ value: "5", count: 1 }], median: 5, average: 5, consensus: true } });
      view.rerender(<PokerRoom env={revealed} me={me} />);
      const save = await screen.findByRole("button", { name: "Save Poker estimate 5 to Payment" });
      const table = () => screen.getByRole("region", { name: "On the table" });
      await waitFor(() => expect(document.activeElement).toBe(table()));
      save.focus();
      await userEvent.keyboard("{Enter}");
      const saved = structuredClone(revealed);
      Object.assign(story(saved, "b"), { estimate: "5", acceptedRoundVersion: ROUND });
      view.rerender(<PokerRoom env={saved} me={me} />);
      await screen.findByRole("button", { name: "Next story: Address" });
      await waitFor(() => expect(document.activeElement).toBe(table()));
    });

    it("keeps focus on something rendered when another tab sets the drafts aside under the field being typed in", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: "parent-flat", revealed: false });
      const flat = { ...story(env, "other"), id: "parent-flat", ref: "PLAT-9", title: "Being split", position: 9, splitRevision: 2 };
      const draft = { ...story(env, "b"), id: "draft-1", parentId: "parent-flat", planningRole: "proposed" as const, title: "Draft one", estimate: null };
      env.state.stories = [...env.state.stories, flat, draft] as Envelope["state"]["stories"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const input = screen.getByRole("textbox", { name: "Name a story, then press Enter" });
      input.focus();
      const setAside = structuredClone(env);
      story(setAside, "parent-flat").draftsParked = true;
      view.rerender(<PokerRoom env={setAside} me={me} />);
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name a story, then press Enter" })).toBeNull());
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement?.tagName).not.toBe("BUTTON");
      expect(screen.getByRole("button", { name: "Continue splitting" })).toBeTruthy();
    });

    it("keeps focus on something rendered after the total is chosen with the mouse", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const env = due();
      env.state.stories = env.state.stories.filter((candidate) => candidate.id !== "other");
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(within(question()!).getByRole("button", { name: "Use the total: 13" }));
      const totaled = structuredClone(env);
      Object.assign(story(totaled, "parent"), { estimate: "13", estimateProvenance: "story-total", parentEstimateAnsweredRevision: 3 });
      view.rerender(<PokerRoom env={totaled} me={me} />);
      await waitFor(() => expect(question()).toBeNull());
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement?.tagName).not.toBe("BUTTON");
    });

    it("offers no refreshed total while the ticket itself is on the table", () => {
      const { env } = committed({ current: "parent", revealed: false });
      settle(env, "b", "c");
      Object.assign(story(env, "parent"), { estimate: "11", estimateProvenance: "story-total", estimateNeedsReview: true, parentEstimateAnsweredRevision: 3 });
      renderApp(<PokerRoom env={env} me={me} />);
      expect(screen.queryByRole("button", { name: /^Refresh the total/ })).toBeNull();
    });

    it("always leaves a way forward when a settled story is voted again to a tie and every story is estimated", async () => {
      const { env } = committed({ current: "a" });
      settle(env, "b", "c");
      Object.assign(story(env, "a"), { acceptedRoundVersion: 3, votes: [{ userId: "dana", value: "3" }, { userId: "marcus", value: "5" }], results: { histogram: [{ value: "3", count: 1 }, { value: "5", count: 1 }], median: 4, average: 4, consensus: false } });
      renderApp(<PokerRoom env={env} me={me} />);
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Vote again" })).toBeTruthy();
      expect(question()).toBeTruthy();
    });

    it("does not call a story current or on the table once the session has ended", () => {
      const { env } = committed({ current: "a", revealed: false });
      env.endedAt = "2026-10-10T10:00:00.000Z";
      renderApp(<PokerRoom env={env} me={me} />);
      expect(screen.queryByRole("region", { name: "On the table" })).toBeNull();
      expect(screen.queryByText("current")).toBeNull();
      expect(screen.queryByText(/On the table:/)).toBeNull();
      expect(document.querySelector('[data-story-id][aria-current="true"], [data-fan-rail] [aria-current="true"]')).toBeNull();
    });

    it("offers a plain way out of the fresh-round question when nothing is on the table, focused first", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: null, revealed: false });
      story(env, "b").votedUserIds = ["dana"];
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Next story: Payment" }));
      const dialog = screen.getByRole("dialog", { name: "Start a fresh round on Payment?" });
      expect(within(dialog).queryByRole("button", { name: "Keep working on this round" })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    });

    it("focuses the choice that changes nothing when the fresh-round question is asked over a live round", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed();
      story(env, "b").votedUserIds = ["dana"];
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Next story: Payment" }));
      const dialog = screen.getByRole("dialog", { name: "Start a fresh round on Payment?" });
      await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep working on this round" })));
    });

    it("stops announcing the ticket question once it has been answered", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const env = due();
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await waitFor(() => expect(document.querySelector("[data-question-announcement]")?.textContent).toContain("What about PAR-150?"));
      const answered = structuredClone(env);
      story(answered, "parent").parentEstimateAnsweredRevision = 3;
      view.rerender(<PokerRoom env={answered} me={me} />);
      await waitFor(() => expect(question()).toBeNull());
      await waitFor(() => expect(document.querySelector("[data-question-announcement]")?.textContent ?? "").toBe(""));
    });

    it("brings the ticket question clear of the hand tray when it appears", async () => {
      const scrolled = vi.fn();
      const originalScrollBy = window.scrollBy;
      window.scrollBy = scrolled as unknown as typeof window.scrollBy;
      const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const isTray = this.hasAttribute("data-poker-hand");
        const isQuestion = this.getAttribute("data-fan-item") === "question";
        const top = isTray ? 600 : isQuestion ? 560 : this.tagName === "BUTTON" ? 200 : 0;
        const height = isQuestion ? 140 : isTray ? 170 : this.tagName === "BUTTON" ? 44 : 0;
        return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      });
      const { env } = committed({ current: "c" });
      settle(env, "b", "c");
      Object.assign(story(env, "c"), { acceptedRoundVersion: ROUND });
      renderApp(<PokerRoom env={env} me={me} />);
      expect(question()).toBeTruthy();
      await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 112 }), { timeout: 2000 });
      rectSpy.mockRestore();
      window.scrollBy = originalScrollBy;
    });

    it("says a server failure in plain words and clears it when the room reconnects", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).includes("/actions/")
            ? new Response(JSON.stringify({ error: "internal error" }), { status: 500 })
            : new Response("[]", { status: 200 }),
        ),
      );
      const { env } = committed({ current: "b", revealed: false });
      story(env, "b").votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Reveal votes for Payment" }));
      expect(await screen.findByText("The server had a problem and that may not have gone through. Check the room, then try again.")).toBeTruthy();
      expect(screen.queryByText("internal error")).toBeNull();
      view.rerender(<PokerRoom env={env} me={me} status="reconnecting" />);
      view.rerender(<PokerRoom env={env} me={me} status="live" />);
      await waitFor(() => expect(screen.queryByText(/The server had a problem/)).toBeNull());
    });
  });

  describe("the split as a rail while one of its stories is on the table", () => {
    const rail = () => screen.getByRole("list", { name: "Stories in this split" });
    const toggle = (name: string) => screen.getByRole("button", { name });
    afterEach(() => window.sessionStorage.clear());

    it("shows one compact item per story instead of the cards, with the story on the table marked and not pressable", () => {
      const { env } = committed({ revealed: false });
      env.state.dependencies = [{ id: "edge", parentId: "parent", blockerId: "a", dependentId: "c", reviewState: "planning", retiredAt: null }];
      renderApp(<PokerRoom env={env} me={me} />);
      expect(rail().hasAttribute("data-fan-rail")).toBe(true);
      expect(document.querySelectorAll("[data-story-id]").length).toBe(0);
      const items = within(rail()).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining("Cart"),
        expect.stringContaining("Payment"),
        expect.stringContaining("Address"),
      ]);
      expect(items[0].getAttribute("aria-current")).toBe("true");
      expect(within(items[0]).queryByRole("button")).toBeNull();
      expect(items[0].textContent).toContain("3");
      expect(items[1].textContent).toContain("Not estimated");
      expect(items[2].textContent).toContain("waits on Cart");
      expect(within(rail()).queryByRole("button", { name: /^More for / })).toBeNull();
      expect(within(screen.getByRole("region", { name: "On the table" })).getByRole("heading", { name: "Cart" })).toBeTruthy();
    });

    it("deals another story from the rail at once when it holds no votes, and through the fresh-round question when it does", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ revealed: false });
      story(env, "c").votedUserIds = ["dana"];
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(within(rail()).getByRole("button", { name: /^Deal Payment/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(actionCalls(spy).length).toBe(1));
      expect(bodyOf(actionCalls(spy)[0])).toEqual({ storyId: "b", expectedCurrentStoryId: "a", expectedRoundVersion: ROUND });
      spy.mockClear();
      await userEvent.click(within(rail()).getByRole("button", { name: /^Deal Address/ }));
      expect(actionCalls(spy).length).toBe(0);
      expect(screen.getByRole("dialog", { name: "Start a fresh round on Address?" })).toBeTruthy();
    });

    it("gives a participant the same rail with nothing to press in it, and the control that shows the split", async () => {
      const { env, viewer } = committed({ viewer: { ...me, id: "someone-else" }, revealed: false });
      renderApp(<PokerRoom env={env} me={viewer} />);
      expect(within(rail()).getAllByRole("listitem").length).toBe(3);
      expect(within(rail()).queryByRole("button")).toBeNull();
      await userEvent.click(toggle("Show the split"));
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
    });

    it("shows the whole split in place from one control, keeps focus on it, and remembers the choice for this browser", async () => {
      const { env } = committed({ revealed: false });
      const first = renderApp(<PokerRoom env={env} me={me} />);
      const show = toggle("Show the split");
      expect(show.getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById(show.getAttribute("aria-controls")!)).toBeTruthy();
      show.focus();
      await userEvent.keyboard("{Enter}");
      const hide = toggle("Hide the split");
      expect(hide.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(hide);
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      expect(screen.getByRole("button", { name: "More for Payment" })).toBeTruthy();
      first.unmount();
      renderApp(<PokerRoom env={env} me={me} />);
      expect(toggle("Hide the split")).toBeTruthy();
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      await userEvent.click(toggle("Hide the split"));
      expect(document.querySelectorAll("[data-story-id]").length).toBe(0);
      expect(document.activeElement).toBe(toggle("Show the split"));
    });

    it("keeps the whole split when nothing is on the table, while stories are being added, and while the ticket question is asked", async () => {
      const { env } = committed({ current: null, revealed: false });
      const idle = renderApp(<PokerRoom env={env} me={me} />);
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      expect(screen.queryByRole("button", { name: "Show the split" })).toBeNull();
      idle.unmount();

      const asked = committed();
      settle(asked.env, "b", "c");
      const asking = renderApp(<PokerRoom env={asked.env} me={me} />);
      expect(question()).toBeTruthy();
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      asking.unmount();

      const adding = committed({ revealed: false });
      renderApp(<PokerRoom env={adding.env} me={me} />);
      expect(document.querySelectorAll("[data-story-id]").length).toBe(0);
      await userEvent.click(screen.getByRole("button", { name: "Add stories" }));
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      expect(screen.getByRole("textbox", { name: "Name a story, then press Enter" })).toBeTruthy();
    });

    it("keeps removed stories one press away at the end of the rail, by showing the split where they can be brought back", async () => {
      const { env } = committed({ revealed: false });
      env.state.stories.push({ ...story(env, "b"), id: "gone", title: "Dropped", removedAt: "2026-10-01T00:00:00Z" });
      renderApp(<PokerRoom env={env} me={me} />);
      expect(screen.queryByRole("button", { name: "Undo removal of Dropped" })).toBeNull();
      await userEvent.click(within(rail()).getByRole("button", { name: "Show the split and its 1 removed story" }));
      expect(document.querySelectorAll("[data-story-id]").length).toBe(3);
      expect(screen.getByRole("button", { name: "Undo removal of Dropped" })).toBeTruthy();
    });

    it("puts focus on the control that hides the split after the removed stories are opened from the rail by keyboard", async () => {
      const { env } = committed({ revealed: false });
      story(env, "a").votedUserIds = ["dana"];
      env.state.stories.push({ ...story(env, "b"), id: "gone", title: "Dropped", removedAt: "2026-10-01T00:00:00Z" });
      renderApp(<PokerRoom env={env} me={me} />);
      within(rail()).getByRole("button", { name: "Show the split and its 1 removed story" }).focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide the split" })));
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide the split" }));
    });

    it("presents the rail without accessibility violations", async () => {
      const { env } = committed({ revealed: false });
      env.state.dependencies = [{ id: "edge", parentId: "parent", blockerId: "a", dependentId: "c", reviewState: "planning", retiredAt: null }];
      const { container } = renderApp(<PokerRoom env={env} me={me} />);
      expect(rail()).toBeTruthy();
      await expectNoViolations(container);
    });

    it("scrolls a rail that does not fit so the story on the table is in it", () => {
      const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
      const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
      const offsetLeft = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("aria-current") === "true" ? 426 : 0;
      });
      const { env } = committed({ current: "c", revealed: false });
      renderApp(<PokerRoom env={env} me={me} />);
      expect(rail().scrollLeft).toBe(420);
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
      offsetLeft.mockRestore();
    });

    it("puts focus on the table when the room shows the dealt story before the request answers", async () => {
      let answerDeal: (response: Response) => void = () => {};
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
        if (String(input).includes("/actions/select")) return new Promise<Response>((resolve) => (answerDeal = resolve));
        return Promise.resolve(new Response("[]", { status: 200 }));
      });
      const { env } = committed({ revealed: false });
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const dealPayment = within(rail()).getByRole("button", { name: /^Deal Payment/ });
      dealPayment.focus();
      await userEvent.keyboard("{Enter}");
      const dealt = structuredClone(env);
      dealt.state.currentStoryId = "b";
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await waitFor(() => expect(within(rail()).queryByRole("button", { name: /^Deal Payment/ })).toBeNull());
      answerDeal(new Response(null, { status: 204 }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "On the table" })));
    });

    it("brings the results clear of the hand tray after a reveal, without pushing the round's controls off the top", async () => {
      const { env } = committed({ revealed: false });
      const scrolled = vi.fn();
      const originalScrollBy = window.scrollBy;
      window.scrollBy = scrolled as unknown as typeof window.scrollBy;
      const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const isTray = this.hasAttribute("data-poker-hand");
        const isResults = this.hasAttribute("data-poker-results");
        const isTable = this.getAttribute("aria-label") === "On the table";
        const top = isTray ? 800 : isResults ? 700 : isTable ? 300 : this.tagName === "BUTTON" ? 320 : 0;
        const height = isResults ? 260 : isTable ? 120 : this.tagName === "BUTTON" ? 44 : 0;
        return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      });
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const revealed = structuredClone(env);
      revealed.revealed = true;
      Object.assign(story(revealed, "a"), { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      view.rerender(<PokerRoom env={revealed} me={me} />);
      await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 204 }), { timeout: 2000 });
      rectSpy.mockRestore();
      window.scrollBy = originalScrollBy;
    });
  });
  describe("after the QA re-test", () => {
    const rail = () => screen.getByRole("list", { name: "Stories in this split" });
    afterEach(() => window.sessionStorage.clear());
    function trackScrolling(placeOf: (element: HTMLElement) => { top: number; height: number } | null) {
      const scrolled = vi.fn();
      const originalScrollBy = window.scrollBy;
      window.scrollBy = scrolled as unknown as typeof window.scrollBy;
      const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const placed = placeOf(this) ?? { top: 0, height: 0 };
        return { top: placed.top, bottom: placed.top + placed.height, left: 0, right: 0, width: 0, height: placed.height, x: 0, y: placed.top, toJSON: () => ({}) } as DOMRect;
      });
      return {
        scrolled,
        restore() {
          rectSpy.mockRestore();
          window.scrollBy = originalScrollBy;
        },
      };
    }
    const revealOf = (env: Envelope, id: string) => {
      const revealed = structuredClone(env);
      revealed.revealed = true;
      Object.assign(story(revealed, id), { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      return revealed;
    };

    it("lands on the split, not on Reveal, when another tab's change replaces the rail under the focused item", async () => {
      const { env } = committed({ revealed: false });
      story(env, "a").votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      within(rail()).getByRole("button", { name: /^Deal Payment/ }).focus();
      const drafted = structuredClone(env);
      drafted.state.stories.push({ ...story(drafted, "b"), id: "draft", title: "Added elsewhere", planningRole: "proposed", estimate: null });
      view.rerender(<PokerRoom env={drafted} me={me} />);
      await waitFor(() => expect(document.querySelector("[data-fan-rail]")).toBeNull());
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement?.tagName).not.toBe("BUTTON");
      expect(document.activeElement?.tagName).not.toBe("INPUT");
    });

    it("lets a held Enter or Space activate Reveal, Save, Next story and the ticket answers once", async () => {
      const isRepeatIgnored = (control: HTMLElement) =>
        [" ", "Enter"].every((key) => !fireEvent.keyDown(control, { key, repeat: true })) && fireEvent.keyDown(control, { key: "Enter" });
      const { env } = committed({ current: "b", revealed: false });
      story(env, "b").votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      expect(isRepeatIgnored(screen.getByRole("button", { name: "Reveal votes for Payment" }))).toBe(true);
      const revealed = revealOf(env, "b");
      view.rerender(<PokerRoom env={revealed} me={me} />);
      expect(isRepeatIgnored(await screen.findByRole("button", { name: "Save Poker estimate 3 to Payment" }))).toBe(true);
      const saved = structuredClone(revealed);
      Object.assign(story(saved, "b"), { estimate: "3", acceptedRoundVersion: ROUND });
      view.rerender(<PokerRoom env={saved} me={me} />);
      expect(isRepeatIgnored(await screen.findByRole("button", { name: "Next story: Address" }))).toBe(true);
      const settled = structuredClone(saved);
      Object.assign(story(settled, "c"), { estimate: "5" });
      view.rerender(<PokerRoom env={settled} me={me} />);
      await waitFor(() => expect(question()).toBeTruthy());
      for (const answer of within(question()!).getAllByRole("button")) expect(isRepeatIgnored(answer)).toBe(true);
    });

    it("refuses to hide the split while a rename holds typed text, and says why", async () => {
      const { env } = committed({ current: "b", revealed: false });
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
      await userEvent.click(screen.getByRole("button", { name: "More for Cart" }));
      await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
      await userEvent.type(screen.getByRole("textbox", { name: "Title for Cart" }), " v2");
      await userEvent.click(screen.getByRole("button", { name: "Hide the split" }));
      expect(document.querySelector("[data-fan-rail]")).toBeNull();
      expect((screen.getByRole("textbox", { name: "Title for Cart" }) as HTMLInputElement).value).toBe("Cart v2");
      expect(await screen.findByText("Save or cancel the rename first")).toBeTruthy();
    });

    it("keeps the split open, with the rename and what was typed, when a story is dealt from elsewhere", async () => {
      const { env } = committed({ current: null, revealed: false });
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "More for Cart" }));
      await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
      await userEvent.type(screen.getByRole("textbox", { name: "Title for Cart" }), " v2");
      const dealt = structuredClone(env);
      dealt.state.currentStoryId = "b";
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await screen.findByRole("region", { name: "On the table" });
      expect(document.querySelector("[data-fan-rail]")).toBeNull();
      expect((screen.getByRole("textbox", { name: "Title for Cart" }) as HTMLInputElement).value).toBe("Cart v2");
    });

    it("asks about a fresh round before dealing a ticket that was split once and still holds votes, and not for a plain story", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: null, revealed: false });
      const undone = { ...story(env, "other"), id: "undone", ref: "PLAT-7", title: "Undone ticket", position: 7, splitRevision: 4, estimate: "13", votedUserIds: ["dana"] };
      env.state.stories = [...env.state.stories, undone] as Envelope["state"]["stories"];
      story(env, "other").votedUserIds = ["dana"];
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Deal Undone ticket" }));
      expect(actionCalls(spy).length).toBe(0);
      await userEvent.click(within(screen.getByRole("dialog", { name: "Start a fresh round on Undone ticket?" })).getByRole("button", { name: "Start fresh round" }));
      await waitFor(() => expect(actionCalls(spy).length).toBe(1));
      expect(bodyOf(actionCalls(spy)[0])).toMatchObject({ storyId: "undone", freshRound: true });
      spy.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Deal Other ticket" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(actionCalls(spy).length).toBe(1));
      expect(bodyOf(actionCalls(spy)[0])).not.toHaveProperty("freshRound");
    });

    it("closes a ticket question that was reopened once it no longer applies", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: null, revealed: false });
      settle(env, "b", "c");
      story(env, "parent").parentEstimateAnsweredRevision = 3;
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Estimate PAR-150" }));
      expect(question()).toBeTruthy();
      const dealt = structuredClone(env);
      dealt.state.currentStoryId = "parent";
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await waitFor(() => expect(question()).toBeNull());
    });

    it("announces the save without a toast over the ticket question that follows the last save", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const { env } = committed({ current: "c", revealed: false });
      settle(env, "b");
      story(env, "c").votedUserIds = ["dana"];
      const revealed = revealOf(env, "c");
      const view = renderApp(<PokerRoom env={revealed} me={me} />);
      await userEvent.click(await screen.findByRole("button", { name: "Save Poker estimate 3 to Address" }));
      await waitFor(() => expect(document.querySelector("[data-question-announcement]")?.textContent).toContain("Estimate 3 saved"));
      expect(document.querySelector("[data-toast]")?.textContent ?? "").toBe("");
      const saved = structuredClone(revealed);
      Object.assign(story(saved, "c"), { estimate: "3", acceptedRoundVersion: ROUND });
      view.rerender(<PokerRoom env={saved} me={me} />);
      await waitFor(() => expect(question()).toBeTruthy());
      await waitFor(() => expect(document.querySelector("[data-toast]")?.textContent ?? "").toBe(""));
    });

    it("takes the total as recorded when its answer was lost but the room shows it", async () => {
      const { env } = committed({ current: null, revealed: false });
      settle(env, "b", "c");
      const totaled = structuredClone(env);
      totaled.version = env.version + 1;
      Object.assign(story(totaled, "parent"), { estimate: "13", estimateProvenance: "story-total", parentEstimateAnsweredRevision: 3, contentRevision: 5 });
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/actions/parent-estimate")) return Promise.reject(new TypeError("Failed to fetch"));
        if (url.endsWith("/api/sessions/sess-1") && (!init?.method || init.method === "GET")) return Promise.resolve(new Response(JSON.stringify(totaled), { status: 200, headers: { "Content-Type": "application/json" } }));
        return Promise.resolve(new Response("[]", { status: 200 }));
      });
      renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(within(question()!).getByRole("button", { name: "Use the total: 13" }));
      await waitFor(() => expect(question()).toBeNull());
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getAllByText(/Story total/).length).toBeGreaterThan(0);
    });

    it("marks no queue row as current once the session has ended", () => {
      const { env } = committed({ current: "a", revealed: false });
      env.endedAt = "2026-10-12T10:00:00Z";
      renderApp(<PokerRoom env={env} me={me} />);
      const queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(queue.querySelector('[aria-current="true"]')).toBeNull();
      expect(queue.querySelector(".bg-felt-deep")).toBeNull();
    });

    it("does not scroll Save out of view to show the results in a room with no split", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.hasAttribute("data-poker-results")
            ? { top: 560, height: 240 }
            : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: 120, height: 44 }
              : null,
      );
      const env = envelope({ facilitatorId: me.id, facilitatorConnected: true, revealed: false });
      env.state.stories[0].votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const revealed = structuredClone(env);
      revealed.revealed = true;
      Object.assign(revealed.state.stories[0], { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      view.rerender(<PokerRoom env={revealed} me={me} />);
      await screen.findByRole("button", { name: "Save 3 to story" });
      await waitFor(() => expect(page.scrolled).toHaveBeenCalled(), { timeout: 2000 });
      expect(page.scrolled).toHaveBeenCalledTimes(1);
      expect(page.scrolled).toHaveBeenCalledWith({ top: 108 });
      page.restore();
    });

    it("leaves the page where it is when the result's headline already sits above the collapsed hand", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 800, height: 56 }
          : element.hasAttribute("data-poker-results")
            ? { top: 560, height: 240 }
            : element.tagName === "H2"
              ? { top: 200, height: 30 }
              : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: 120, height: 44 }
              : null,
      );
      const env = envelope({ facilitatorId: me.id, facilitatorConnected: true, revealed: false });
      env.state.stories[0].votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      const revealed = structuredClone(env);
      revealed.revealed = true;
      Object.assign(revealed.state.stories[0], { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      view.rerender(<PokerRoom env={revealed} me={me} />);
      await screen.findByRole("button", { name: "Save 3 to story" });
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      expect(page.scrolled).not.toHaveBeenCalled();
      page.restore();
    });

    it("brings the round into view when a story is dealt from further down the page in a room with no split", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.tagName === "H2"
            ? { top: -420, height: 30 }
            : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: -380, height: 44 }
              : null,
      );
      const idle = envelope({ facilitatorId: me.id, facilitatorConnected: true, revealed: false });
      const tabledId = idle.state.currentStoryId;
      idle.state.currentStoryId = null;
      const view = renderApp(<PokerRoom env={idle} me={me} />);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      page.scrolled.mockClear();
      const dealt = structuredClone(idle);
      dealt.state.currentStoryId = tabledId;
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await waitFor(() => expect(page.scrolled).toHaveBeenCalledWith({ top: -432 }), { timeout: 2000 });
      page.restore();
    });

    it("leaves the page where it is when a story is dealt and the round is already in view in a room with no split", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.tagName === "H2"
            ? { top: 90, height: 30 }
            : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: 130, height: 44 }
              : null,
      );
      const idle = envelope({ facilitatorId: me.id, facilitatorConnected: true, revealed: false });
      const tabledId = idle.state.currentStoryId;
      idle.state.currentStoryId = null;
      const view = renderApp(<PokerRoom env={idle} me={me} />);
      const dealt = structuredClone(idle);
      dealt.state.currentStoryId = tabledId;
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      expect(page.scrolled).not.toHaveBeenCalled();
      page.restore();
    });

    it("leaves the page alone on a reveal while the facilitator is typing", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.hasAttribute("data-poker-results")
            ? { top: 560, height: 240 }
            : element.tagName === "BUTTON" || element.getAttribute("aria-label") === "On the table"
              ? { top: 300, height: 44 }
              : null,
      );
      const { env } = committed({ current: "b", revealed: false });
      story(env, "b").votedUserIds = ["dana"];
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
      await userEvent.click(screen.getByRole("button", { name: "More for Cart" }));
      await userEvent.click(screen.getByRole("button", { name: "Rename or add notes" }));
      const title = screen.getByRole("textbox", { name: "Title for Cart" });
      await userEvent.type(title, " v2");
      page.scrolled.mockClear();
      view.rerender(<PokerRoom env={revealOf(env, "b")} me={me} />);
      await screen.findByRole("button", { name: "Save Poker estimate 3 to Payment" });
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      expect(page.scrolled).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(title);
      page.restore();
    });

    it("comes back up to the ticket strip when the next story is dealt, and brings Reveal into view when it was above", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.hasAttribute("data-fan-strip")
            ? { top: -400, height: 60 }
            : element.getAttribute("aria-label") === "On the table"
              ? { top: -300, height: 120 }
              : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
                ? { top: -260, height: 44 }
                : null,
      );
      const { env } = committed({ current: "a" });
      const view = renderApp(<PokerRoom env={env} me={me} />);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      page.scrolled.mockClear();
      const next = structuredClone(env);
      next.revealed = false;
      next.state.currentStoryId = "b";
      view.rerender(<PokerRoom env={next} me={me} />);
      await waitFor(() => expect(page.scrolled).toHaveBeenCalledWith({ top: -412 }), { timeout: 2000 });
      page.restore();
    });
  });
});

describe("after the third QA gate", () => {
  const ticket = () => document.querySelector("header") as HTMLElement;
  const hand = () => document.querySelector("[data-poker-hand]") as HTMLElement;
  const composer = () => screen.queryByRole("textbox", { name: "Name a story, then press Enter" }) as HTMLInputElement | null;
  const REMOVED_AT = "2026-10-12T00:00:00Z";

  function simulatedRoom(start: Envelope) {
    let room: Envelope = { ...structuredClone(start), version: 1 };
    const sent: { name: string; body: Record<string, unknown> }[] = [];
    let createdCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/plugins/panels")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (!init?.method || init.method === "GET") return Promise.resolve(new Response(JSON.stringify(room), { status: 200 }));
      const name = url.split("/actions/")[1] ?? url;
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      sent.push({ name, body });
      const next = structuredClone(room);
      next.version = (room.version ?? 1) + 1;
      const stories = next.state.stories;
      let answer = new Response(null, { status: 204 });
      if (name === "child") {
        const parent = stories.find((story) => story.id === body.parentId)!;
        createdCount += 1;
        parent.splitRevision = (parent.splitRevision ?? 0) + 1;
        stories.push({
          ...parent,
          id: `draft-${createdCount}`,
          ref: "",
          title: String(body.title),
          parentId: parent.id,
          planningRole: "proposed",
          votedUserIds: [],
          creationOperation: String(body.operationId),
          contentRevision: 0,
          splitRevision: 0,
        });
        answer = new Response(JSON.stringify({ storyId: `draft-${createdCount}`, contentRevision: 0, splitRevision: parent.splitRevision }), { status: 201 });
      }
      if (name === "remove-child") {
        const removed = stories.find((story) => story.id === body.storyId)!;
        removed.removedAt = REMOVED_AT;
        const parent = stories.find((story) => story.id === removed.parentId)!;
        parent.splitRevision = (parent.splitRevision ?? 0) + 1;
      }
      room = next;
      return Promise.resolve(answer);
    });
    return { sent, room: () => room };
  }

  function liveRound() {
    const env = envelope({ facilitatorId: me.id, facilitatorConnected: true, version: 1 });
    env.state.roundVersion = 4;
    env.state.stories[0].votedUserIds = ["dana", "marcus"];
    return env;
  }

  async function draft(...titles: string[]) {
    await userEvent.click(screen.getByRole("button", { name: "Too big? Split it" }));
    for (const title of titles) {
      await userEvent.type(composer()!, `${title}{Enter}`);
      await screen.findByRole("button", { name: `Remove ${title}` });
    }
  }

  async function expectBackAtTheTable(server: ReturnType<typeof simulatedRoom>, expectedRequests: string[]) {
    await waitFor(() => expect(composer()).toBeNull());
    await waitFor(() => expect(ticket().getAttribute("data-fan-strip")).toBe("ticket"));
    expect(screen.queryByText("Splitting")).toBeNull();
    expect(hand().hasAttribute("data-tucked")).toBe(false);
    expect(hand().hasAttribute("inert")).toBe(false);
    const reveal = screen.getByRole("button", { name: "Reveal" }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(false);
    expect(server.sent.map((request) => request.name)).toEqual(expectedRequests);
    const tabled = server.room().state.stories[0];
    expect(tabled.votedUserIds).toEqual(["dana", "marcus"]);
    expect(server.room().state.currentStoryId).toBe("story-1");
    expect(server.room().state.roundVersion).toBe(4);
  }

  describe("leaving a first split always returns the facilitator to the round that is still live", () => {
    it("after the drafts are discarded", async () => {
      const server = simulatedRoom(liveRound());
      renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: "Discard drafts" }));
      await expectBackAtTheTable(server, ["child", "child", "remove-child", "remove-child"]);
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    });

    it("after Cancel with no draft left, though something had been typed", async () => {
      const server = simulatedRoom(liveRound());
      renderApp(<PokerRoom env={liveRound()} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Too big? Split it" }));
      await userEvent.type(composer()!, "half a thought");
      await userEvent.clear(composer()!);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expectBackAtTheTable(server, []);
    });

    it("after Escape in the empty composer once the only draft is gone", async () => {
      const server = simulatedRoom(liveRound());
      renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expectBackAtTheTable(server, ["child", "remove-child"]);
      await userEvent.click(screen.getByRole("button", { name: "Too big? Split it" }));
      await userEvent.type(composer()!, "again");
      await userEvent.clear(composer()!);
      await userEvent.keyboard("{Escape}");
      await expectBackAtTheTable(server, ["child", "remove-child"]);
    });

    it("after every draft is removed one by one from its own card", async () => {
      const server = simulatedRoom(liveRound());
      renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two");
      await userEvent.click(screen.getByRole("button", { name: "Remove One" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Remove One" })).toBeNull());
      expect(composer()).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Remove Two" }));
      await expectBackAtTheTable(server, ["child", "child", "remove-child", "remove-child"]);
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    });

    it("after another tab discards the drafts", async () => {
      const server = simulatedRoom(liveRound());
      const view = renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two");
      const discarded = structuredClone(server.room());
      discarded.version = (discarded.version ?? 1) + 1;
      for (const story of discarded.state.stories) if (story.parentId) story.removedAt = REMOVED_AT;
      view.rerender(<PokerRoom env={discarded} me={me} />);
      await expectBackAtTheTable(server, ["child", "child"]);
    });
  });
  describe("another tab committing the split", () => {
    function committedElsewhere(room: Envelope, hasDealtFirstStory = false) {
      const committed = structuredClone(room);
      committed.version = (committed.version ?? 1) + 1;
      for (const story of committed.state.stories) {
        if (story.parentId) story.planningRole = "planning";
        else story.planningRole = "context";
      }
      committed.state.currentStoryId = hasDealtFirstStory ? committed.state.stories.find((story) => story.parentId)!.id : null;
      committed.state.roundVersion = 5;
      return committed;
    }

    it("never turns the control that had focus into one that deals, and an Enter there sends nothing", async () => {
      const server = simulatedRoom(liveRound());
      const view = renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two", "Three");
      const pencil = screen.getByRole("button", { name: "Rename or add notes to Two" });
      pencil.focus();
      const sentBefore = server.sent.length;
      view.rerender(<PokerRoom env={committedElsewhere(server.room())} me={me} />);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Rename or add notes to Two" })).toBeNull());
      expect(pencil.isConnected).toBe(false);
      const focused = document.activeElement as HTMLElement;
      expect(focused.tagName).not.toBe("BUTTON");
      expect(focused.getAttribute("aria-label") ?? "").not.toMatch(/^Deal /);
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(server.sent.length).toBe(sentBefore);
    });

    it("never turns a draft's remove control into the committed story's menu control or back", async () => {
      const server = simulatedRoom(liveRound());
      const view = renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two", "Three");
      const remove = screen.getByRole("button", { name: "Remove Two" });
      remove.focus();
      view.rerender(<PokerRoom env={committedElsewhere(server.room())} me={me} />);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Two" })).toBeNull());
      expect(remove.isConnected).toBe(false);
      expect((document.activeElement as HTMLElement).tagName).not.toBe("BUTTON");
    });

    it("closes the composer here, so there is no second Split to press", async () => {
      const server = simulatedRoom(liveRound());
      const view = renderApp(<PokerRoom env={liveRound()} me={me} />);
      await draft("One", "Two", "Three");
      expect(screen.getByRole("button", { name: "Split into 3 stories" })).toBeTruthy();
      view.rerender(<PokerRoom env={committedElsewhere(server.room(), true)} me={me} />);
      await waitFor(() => expect(screen.queryByRole("button", { name: /^Split into/ })).toBeNull());
      expect(composer()).toBeNull();
      expect(server.sent.some((request) => request.name === "adopt")).toBe(false);
    });
  });
  describe("a stray or held key never writes twice, or at all", () => {
    function committedSplit(over: { current?: string | null; revealed?: boolean } = {}) {
      const env = envelope({ facilitatorId: me.id, facilitatorConnected: true, version: 1, revealed: over.revealed ?? false });
      const base = env.state.stories[0];
      env.state.roundVersion = 4;
      env.state.currentStoryId = over.current ?? null;
      env.state.stories = [
        { ...base, id: "parent", ref: "PAR-9", title: "Ticket", planningRole: "context", contentRevision: 3, splitRevision: 2, coverage: "full" },
        { ...base, id: "a", ref: "", title: "Alpha", parentId: "parent", planningRole: "planning", estimate: "8", estimateProvenance: "poker", contentRevision: 1, scopeRevision: 0, acceptedScopeRevision: 0 },
        { ...base, id: "b", ref: "", title: "Beta", parentId: "parent", planningRole: "planning", estimate: null, contentRevision: 1 },
      ] as Envelope["state"]["stories"];
      return env;
    }
    function holdEnter(times: number) {
      for (let press = 0; press < times; press += 1) {
        const target = document.activeElement as HTMLElement;
        const isAllowed = fireEvent.keyDown(target, { key: "Enter", repeat: true });
        if (isAllowed && (target.tagName === "BUTTON" || target.tagName === "A")) fireEvent.click(target);
      }
    }
    const requestsNamed = (server: ReturnType<typeof simulatedRoom>, name: string) => server.sent.filter((request) => request.name === name);

    it("opens the estimate menu with focus on the menu itself and the current estimate marked, so Enter, Enter after Escape sends nothing", async () => {
      const server = simulatedRoom(committedSplit());
      renderApp(<PokerRoom env={committedSplit()} me={me} />);
      const opener = screen.getByRole("button", { name: "Change estimate for Alpha" });
      opener.focus();
      await userEvent.keyboard("{Enter}");
      const menu = screen.getByRole("group", { name: "Estimate for Alpha" });
      expect(document.activeElement).toBe(menu);
      expect(within(menu).getByRole("button", { name: "Estimate Alpha at 8" }).getAttribute("aria-current")).toBe("true");
      expect(within(menu).getByRole("button", { name: "Estimate Alpha at 5" }).hasAttribute("aria-current")).toBe(false);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Enter}");
      expect(server.sent).toEqual([]);
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Estimate for Alpha" })).getByRole("button", { name: "Estimate Alpha at 1" }));
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Estimate for Alpha" })).getByRole("button", { name: "Estimate Alpha at 2" }));
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Estimate for Alpha" })).getByRole("button", { name: "Estimate Alpha at 1" }));
    });

    it("sends one estimate when Enter is held on a card in the estimate menu", async () => {
      const server = simulatedRoom(committedSplit());
      renderApp(<PokerRoom env={committedSplit()} me={me} />);
      const opener = screen.getByRole("button", { name: "Change estimate for Alpha" });
      await userEvent.click(opener);
      screen.getByRole("button", { name: "Estimate Alpha at 5" }).focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
      holdEnter(6);
      await waitFor(() => expect(requestsNamed(server, "story").length).toBe(1));
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      holdEnter(6);
      expect(requestsNamed(server, "story").map((request) => request.body.estimate)).toEqual(["5"]);
    });

    it("sends one estimate when Enter is held on the live-round confirmation", async () => {
      const server = simulatedRoom(committedSplit({ current: "a" }));
      renderApp(<PokerRoom env={committedSplit({ current: "a" })} me={me} />);
      await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
      await userEvent.click(screen.getByRole("button", { name: "Change estimate for Alpha" }));
      await userEvent.click(screen.getByRole("button", { name: "Estimate Alpha at 5" }));
      const confirm = screen.getByRole("button", { name: "Confirm estimating Alpha at 5" });
      confirm.focus();
      await userEvent.keyboard("{Enter}");
      holdEnter(6);
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      holdEnter(6);
      await waitFor(() => expect(requestsNamed(server, "story").length).toBe(1));
      expect(requestsNamed(server, "story")[0].body).toMatchObject({ estimate: "5", endRound: true });
    });

    it("sends nothing when Enter is held on a card's More", async () => {
      const server = simulatedRoom(committedSplit());
      renderApp(<PokerRoom env={committedSplit()} me={me} />);
      screen.getByRole("button", { name: "More for Alpha" }).focus();
      await userEvent.keyboard("{Enter}");
      holdEnter(8);
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      holdEnter(8);
      expect(server.sent).toEqual([]);
      expect(screen.queryByRole("textbox", { name: "Title for Alpha" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Alpha" }));
    });

    it("links nothing on Enter, Enter, Space, Space after the Blocked by menu is closed with Escape", async () => {
      const server = simulatedRoom(committedSplit());
      renderApp(<PokerRoom env={committedSplit()} me={me} />);
      const opener = screen.getByRole("button", { name: "Set what Alpha is blocked by" });
      opener.focus();
      await userEvent.keyboard("{Enter}");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Alpha is blocked by" }));
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      await userEvent.keyboard(" ");
      expect(server.sent).toEqual([]);
    });

    it("ignores a repeated Enter or Space on every kind of control in the room, and leaves text fields their key repeat", async () => {
      const isRepeatIgnored = (control: Element) => [" ", "Enter"].every((key) => !fireEvent.keyDown(control, { key, repeat: true }));
      const tabled = committedSplit({ current: "b", revealed: true });
      tabled.state.stories.push({ ...tabled.state.stories[0], id: "flat", ref: "PLAT-9", title: "Unrelated ticket", parentId: undefined, planningRole: "planning", coverage: undefined, splitRevision: 0 });
      Object.assign(tabled.state.stories[2], { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      simulatedRoom(tabled);
      renderApp(<PokerRoom env={tabled} me={me} />);
      expect(isRepeatIgnored(screen.getByRole("button", { name: /^Deal Alpha/ }))).toBe(true);
      expect(isRepeatIgnored(screen.getByRole("button", { name: "Deal Unrelated ticket" }))).toBe(true);
      expect(isRepeatIgnored(screen.getByRole("button", { name: "Reset" }))).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Reset" }));
      expect(isRepeatIgnored(screen.getByRole("button", { name: "Reset votes" }))).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Keep votes" }));
      await userEvent.click(screen.getByRole("button", { name: "Show the split" }));
      expect(isRepeatIgnored(screen.getByRole("button", { name: "More for Alpha" }))).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Set what Alpha is blocked by" }));
      expect(isRepeatIgnored(within(screen.getByRole("group", { name: "Alpha is blocked by" })).getAllByRole("checkbox")[0])).toBe(true);
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "Add stories" }));
      const field = composer()!;
      expect(fireEvent.keyDown(field, { key: " ", repeat: true })).toBe(true);
    });

    it("sends one request however fast Reveal, Save or Reset is pressed twice", async () => {
      const hidden = committedSplit({ current: "b" });
      hidden.state.stories[2].votedUserIds = ["dana"];
      const server = simulatedRoom(hidden);
      const view = renderApp(<PokerRoom env={hidden} me={me} />);
      const reveal = screen.getByRole("button", { name: "Reveal votes for Beta" });
      fireEvent.click(reveal);
      fireEvent.click(reveal);
      const reset = screen.getByRole("button", { name: "Reset" });
      fireEvent.click(reset);
      fireEvent.click(reset);
      await waitFor(() => expect(server.sent.length).toBeGreaterThan(0));
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      expect(server.sent.map((request) => request.name)).toEqual(["reveal"]);

      const revealed = structuredClone(hidden);
      revealed.version = 9;
      revealed.revealed = true;
      Object.assign(revealed.state.stories[2], { votes: [{ userId: "dana", value: "3" }], results: { histogram: [{ value: "3", count: 1 }], median: 3, average: 3, consensus: true } });
      view.rerender(<PokerRoom env={revealed} me={me} />);
      const save = await screen.findByRole("button", { name: "Save Poker estimate 3 to Beta" });
      fireEvent.click(save);
      fireEvent.click(save);
      await waitFor(() => expect(requestsNamed(server, "story").length).toBe(1));
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      expect(requestsNamed(server, "story").length).toBe(1);
    });
  });
  describe("the round is brought into view from wherever the page was", () => {
    function trackScrolling(placeOf: (element: HTMLElement) => { top: number; height: number } | null) {
      const scrolled = vi.fn();
      const originalScrollBy = window.scrollBy;
      window.scrollBy = scrolled as unknown as typeof window.scrollBy;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const placed = placeOf(this) ?? { top: 0, height: 0 };
        return { top: placed.top, bottom: placed.top + placed.height, left: 0, right: 0, width: 0, height: placed.height, x: 0, y: placed.top, toJSON: () => ({}) } as DOMRect;
      });
      const computedStyleOf = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
        const style = computedStyleOf(element, pseudo);
        if (!element.hasAttribute("data-poker-hand")) return style;
        return new Proxy(style, { get: (target, property) => (property === "position" ? "sticky" : Reflect.get(target, property)) });
      });
      return {
        scrolled,
        restore() {
          window.scrollBy = originalScrollBy;
        },
      };
    }

    it("shows the title and Reveal after a deal from the bottom of a long queue, where the sticky tray is itself out of view", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: -210, height: 170 }
          : element.tagName === "H2"
            ? { top: -817, height: 30 }
            : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: -725, height: 44 }
              : element.hasAttribute("data-queue-deal")
                ? { top: 500, height: 44 }
                : null,
      );
      const idle = envelope({ facilitatorId: me.id, facilitatorConnected: true, version: 1 });
      const tabledId = idle.state.currentStoryId;
      idle.state.currentStoryId = null;
      idle.state.stories.push({ ...idle.state.stories[0], id: "last", ref: "PLAT-99", title: "Last in the queue" });
      const view = renderApp(<PokerRoom env={idle} me={me} />);
      screen.getByRole("button", { name: "Deal Last in the queue" }).focus();
      const dealt = structuredClone(idle);
      dealt.version = 2;
      dealt.state.currentStoryId = tabledId;
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await waitFor(() => expect(page.scrolled).toHaveBeenCalledWith({ top: -829 }), { timeout: 2000 });
      page.restore();
    });

    it("shows the title of a story dealt in a room with no split when only the title was cut off at the top", async () => {
      const page = trackScrolling((element) =>
        element.hasAttribute("data-poker-hand")
          ? { top: 600, height: 170 }
          : element.tagName === "H2"
            ? { top: -20, height: 30 }
            : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
              ? { top: 40, height: 44 }
              : null,
      );
      const idle = envelope({ facilitatorId: me.id, facilitatorConnected: true, version: 1 });
      const tabledId = idle.state.currentStoryId;
      idle.state.currentStoryId = null;
      const view = renderApp(<PokerRoom env={idle} me={me} />);
      const dealt = structuredClone(idle);
      dealt.version = 2;
      dealt.state.currentStoryId = tabledId;
      view.rerender(<PokerRoom env={dealt} me={me} />);
      await waitFor(() => expect(page.scrolled).toHaveBeenCalledWith({ top: -32 }), { timeout: 2000 });
      page.restore();
    });

    it("brings Next story into view after the ticket question is answered, when it was above the top", async () => {
      const page = trackScrolling((element) =>
        element.getAttribute("data-fan-item") === "now"
          ? { top: -230, height: 90 }
          : element.tagName === "BUTTON" && element.closest("[data-round-verdict]")
            ? { top: -200, height: 44 }
            : null,
      );
      const asked = envelope({ facilitatorId: me.id, facilitatorConnected: true, version: 1 });
      const base = asked.state.stories[0];
      asked.state.currentStoryId = null;
      asked.state.stories = [
        { ...base, id: "parent", ref: "PAR-9", title: "Ticket", planningRole: "context", contentRevision: 3, splitRevision: 2, coverage: "full" },
        { ...base, id: "a", ref: "", title: "Alpha", parentId: "parent", planningRole: "planning", estimate: "8", estimateProvenance: "poker" },
        { ...base, id: "b", ref: "", title: "Beta", parentId: "parent", planningRole: "planning", estimate: "5", estimateProvenance: "poker" },
        { ...base, id: "other", ref: "PLAT-7", title: "Other ticket" },
      ] as Envelope["state"]["stories"];
      vi.spyOn(globalThis, "fetch").mockImplementation(answering(new Response(null, { status: 204 })));
      const view = renderApp(<PokerRoom env={asked} me={me} />);
      expect(screen.getByRole("group", { name: "All 2 stories are estimated. What about PAR-9?" })).toBeTruthy();
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      page.scrolled.mockClear();
      const answered = structuredClone(asked);
      answered.version = 2;
      answered.state.stories[0].parentEstimateAnsweredRevision = 2;
      view.rerender(<PokerRoom env={answered} me={me} />);
      expect(await screen.findByRole("button", { name: /^Next story: .*Other ticket$/ })).toBeTruthy();
      await waitFor(() => expect(page.scrolled).toHaveBeenCalledWith({ top: -242 }), { timeout: 2000 });
      page.restore();
    });
  });
});
