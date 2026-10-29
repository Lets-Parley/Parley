import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp, makePerson, pageStatus } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { Envelope } from "../lib/api";
import { PresentPage } from "./PresentPage";
import { useSession } from "../lib/useSession";
import type { ConnectionStatus } from "../lib/socket";

let mockEnv: Envelope | undefined;
let mockIsLoading = false;
let mockStatus: ConnectionStatus = "live";
vi.mock("../lib/useSession", () => ({
  useSession: vi.fn(() => ({ data: mockEnv, isLoading: mockIsLoading, status: mockStatus })),
}));

beforeEach(() => {
  mockStatus = "live";
});

const base = {
  id: "sess-1",
  title: "Sprint 12",
  phase: "voting",
  version: 1,
  facilitatorId: "dana",
  facilitatorConnected: true,
  endedAt: null,
  presence: ["dana", "marcus"],
  orgSlug: "acme",
  spaceSlug: "platform-team",
  participants: [
    makePerson({ userId: "dana", name: "Dana Whitfield" }),
    makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
  ],
  serverTime: "2026-08-18T10:00:30.000Z",
};

function poker(revealed: boolean): Envelope {
  return {
    ...base,
    kind: "poker",
    revealed,
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
          votedUserIds: ["dana"],
          // Present even pre-reveal on purpose: the page must not print it.
          votes: [{ userId: "dana", value: "13" }],
          results: revealed
            ? { histogram: [{ value: "13", count: 1 }], median: 13, average: 13, consensus: false }
            : undefined,
        },
      ],
    },
  } as Envelope;
}

function show(env: Envelope | undefined, sessionId = "sess-1") {
  mockEnv = env;
  return renderApp(<PresentPage />, {
    route: `/session/${sessionId}/present`,
    path: "/session/:id/present",
  });
}

describe("PresentPage", () => {
  it("marks a disconnected presentation as showing the last received state", () => {
    mockStatus = "stale";
    show(poker(true));
    expect(pageStatus().textContent).toContain("Connection lost");
    expect(pageStatus().textContent).toContain("out of date");
    expect(screen.getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
  });

  it("marks a finished session on the shared display", () => {
    show({ ...poker(true), endedAt: "2026-10-23T12:00:00Z" });
    expect(screen.getByText("Session ended")).toBeTruthy();
  });

  it("shows values and the summary once the round is revealed", async () => {
    const { container } = show(poker(true));
    expect(screen.getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(screen.getAllByText("13").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/median/)).toBeTruthy();
    expect(screen.getByText("not yet")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("makes the answer the hero with the title second, rendered at once on a view opened after the reveal", () => {
    show(poker(true));
    const num = screen.getByText("13", { selector: "[data-present-answer]" });
    expect(num.getAttribute("style")).toContain("clamp(8rem, 22vh, 16rem)");
    expect(num.getAttribute("style")).not.toContain("animation");
    const title = screen.getByRole("heading", { name: "Rate-limit the join endpoint" });
    expect(title.className).not.toMatch(/text-5xl/);
  });

  it("stamps the answer in when this view watched the reveal happen", () => {
    mockEnv = poker(false);
    const view = renderApp(<PresentPage />, { route: "/session/sess-1/present", path: "/session/:id/present" });
    mockEnv = poker(true);
    view.rerender(<PresentPage />);
    const num = screen.getByText("13", { selector: "[data-present-answer]" });
    expect(num.getAttribute("style")).toContain("stamp-in");
  });

  it("leads a split round with the spread and counts votes before the reveal", () => {
    const split = poker(true);
    split.state.stories[0].results = {
      histogram: [
        { value: "3", count: 1 },
        { value: "8", count: 1 },
      ],
      median: 5,
      average: 5.5,
      consensus: false,
    };
    const { unmount } = show(split);
    expect(screen.getByText("Spread 3 to 8 (2 steps)").getAttribute("style")).toContain("--color-stop");
    unmount();
    show(poker(false));
    expect(screen.getByText("1 of 2 voted")).toBeTruthy();
  });

  it("renders no vote values before the reveal", async () => {
    const { container } = show(poker(false));
    expect(container.textContent).not.toContain("13");
    expect(screen.getByText("voted")).toBeTruthy();
    expect(screen.getByText("not yet")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    await expectNoViolations(container);
  });

  it("shows the standup speaker and timer but no entry text", async () => {
    const { container } = show({
      ...base,
      kind: "standup",
      revealed: false,
      state: {
        entries: [{ userId: "dana", yesterday: "shipped the SECRET-Y", today: "pairing on SECRET-T", blockers: "SECRET-B", position: 1, skipped: false }],
        currentSpeakerId: "dana",
        speakerStartedAt: "2026-08-18T10:00:00.000Z",
        secondsPerPerson: 90,
      },
    } as unknown as Envelope);
    expect(screen.getByRole("heading", { name: "Dana Whitfield is speaking" })).toBeTruthy();
    expect(screen.getByText(/Each turn is 90 seconds/)).toBeTruthy();
    expect(container.textContent).not.toContain("SECRET");
    await expectNoViolations(container);
  });

  it("strips bidi overrides from a poker participant's name", () => {
    const env = poker(false);
    env.participants = [
      makePerson({ userId: "dana", name: "Dana‮Whitfield" }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
    ];
    const { container } = show(env);
    expect(container.textContent).not.toContain("‮");
    expect(screen.getByText("DanaWhitfield")).toBeTruthy();
  });

  function standupEnv(phase: string, state: object): Envelope {
    return {
      ...base,
      kind: "standup",
      phase,
      revealed: false,
      state: { currentSpeakerId: null, speakerStartedAt: null, secondsPerPerson: 90, ...state },
    } as unknown as Envelope;
  }
  const rows = [
    { userId: "dana", position: 1, ready: true, skipped: false, yesterday: "SECRET-Y1", today: "SECRET-T1", blockers: "SECRET-B1" },
    { userId: "marcus", position: 2, ready: false, skipped: false, yesterday: "SECRET-Y2", today: "SECRET-T2", blockers: "SECRET-B2" },
  ];

  it("shows the ready count and who is still writing while gathering", () => {
    const { container } = show(standupEnv("", { entries: rows }));
    expect(container.textContent).not.toContain("SECRET");
    expect(screen.getByText(/1 of 2 ready/)).toBeTruthy();
    expect(screen.getByText(/Marcus Okonjo/)).toBeTruthy();
  });

  it("shows who is next and where the round is while speaking", () => {
    const { container } = show(
      standupEnv("speaking", {
        entries: rows,
        currentSpeakerId: "dana",
        speakerStartedAt: "2026-08-18T10:00:00.000Z",
      }),
    );
    expect(container.textContent).not.toContain("SECRET");
    expect(screen.getByText(/Next: Marcus Okonjo/)).toBeTruthy();
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
  });

  it("says the round is complete when it is done", () => {
    const { container } = show(standupEnv("done", { entries: rows }));
    expect(container.textContent).not.toContain("SECRET");
    expect(screen.getByRole("heading", { name: "Round complete" })).toBeTruthy();
  });

  it("strips bidi overrides from the standup speaker's name", () => {
    const { container } = show({
      ...base,
      kind: "standup",
      revealed: false,
      participants: [
        makePerson({ userId: "dana", name: "Dana‮Whitfield" }),
        makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
      ],
      state: {
        entries: [],
        currentSpeakerId: "dana",
        speakerStartedAt: null,
        secondsPerPerson: 90,
      },
    } as unknown as Envelope);
    expect(container.textContent).not.toContain("‮");
    expect(screen.getByRole("heading", { name: "DanaWhitfield is speaking" })).toBeTruthy();
  });

  it("marks a guest poker participant the same way every other roster does", () => {
    const env = poker(false);
    env.participants = [
      makePerson({ userId: "dana", name: "Dana Whitfield", guest: true }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
    ];
    show(env);
    const chip = screen.getByText("Dana Whitfield").closest("li");
    expect(chip?.textContent).toContain("guest");
    expect(screen.queryByText("Marcus Okonjo")?.closest("li")?.textContent).not.toContain("guest");
  });

  it("marks a guest standup speaker the same way every other roster does", () => {
    show({
      ...base,
      kind: "standup",
      revealed: false,
      participants: [
        makePerson({ userId: "dana", name: "Dana Whitfield", guest: true }),
        makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
      ],
      state: {
        entries: [],
        currentSpeakerId: "dana",
        speakerStartedAt: null,
        secondsPerPerson: 90,
      },
    } as unknown as Envelope);
    expect(screen.getByRole("heading", { name: /Dana Whitfield.*guest.*is speaking/ })).toBeTruthy();
  });

  it("calls useSession with the session id parsed from the route", () => {
    show(poker(false), "sess-42");
    const calls = vi.mocked(useSession).mock.calls;
    expect(calls[calls.length - 1][0]).toBe("sess-42");
  });

  it("shows the can't-be-shown message and does not crash when there is no session data", () => {
    const { container } = show(undefined);
    expect(screen.getByRole("heading", { name: "This room can't be shown" })).toBeTruthy();
    expect(container.textContent).not.toContain("undefined");
  });
});

it("names the active child and parent with accepted sibling estimates without exposing votes", () => {
  const env = poker(false);
  const child = env.state.stories[0];
  child.parentId = "parent";
  env.state.stories.push(
    { ...child, id: "parent", parentId: null, planningRole: "context", title: "Original ticket", estimate: "13", votes: [] },
    { ...child, id: "sibling", title: "API slice", estimate: "3", estimateProvenance: "facilitator-set", votes: [] },
    { ...child, id: "blank", title: "Remaining scope", estimate: null, votes: [] },
  );
  for (const story of env.state.stories) if (story.parentId) story.planningRole = "planning";
  env.state.dependencies = [{ id: "edge", parentId: "parent", blockerId: "sibling", dependentId: "blank", reviewState: "planning", retiredAt: null }];
  show(env);
  expect(screen.getByRole("heading", { level: 2, name: "Original ticket" })).toBeTruthy();
  expect(screen.getByText("Split into 3 stories")).toBeTruthy();
  const rail = screen.getByRole("list", { name: "Stories in this split" });
  expect(rail.hasAttribute("data-fan-rail")).toBe(true);
  expect(document.querySelectorAll("[data-story-id]").length).toBe(0);
  const [onTable, sibling, blank] = within(rail).getAllByRole("listitem");
  expect(onTable.getAttribute("aria-current")).toBe("true");
  expect(onTable.textContent).toContain("on the table");
  expect(sibling.textContent).toContain("API slice");
  expect(sibling.textContent).toContain("3");
  expect(blank.textContent).toContain("Not estimated");
  expect(blank.textContent).toContain("waits on API slice");
  expect(screen.queryAllByRole("button")).toEqual([]);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText((_, node) => node?.textContent === "13 · Historical")).toBeTruthy();
});

it.each(["", "Original ticket"])("preserves parent identity for presenter title %j", title => {
  const env = poker(false);
  const child = env.state.stories[0];
  child.parentId = "parent";
  env.state.stories.push({...child,id:"parent",parentId:null,title,ref:"PAR-142",planningRole:"context",votes:[]});
  show(env);
  expect(screen.getByRole("heading", { level: 2, name: title || "PAR-142" })).toBeTruthy();
});

function splittingOnTheTable(withDrafts: boolean): Envelope {
  const env = poker(true);
  const parent = env.state.stories[0];
  if (withDrafts) {
    env.state.stories.push(
      { ...parent, id: "a", ref: "", title: "Throttle per key", parentId: parent.id, planningRole: "proposed", votes: [], results: undefined, votedUserIds: [] },
      { ...parent, id: "b", ref: "", title: "Shared counter", parentId: parent.id, planningRole: "proposed", votes: [], results: undefined, votedUserIds: [] },
    );
  }
  return env;
}

it("shows the title, the seats and the revealed result of a story that was dealt with drafts already under it", () => {
  const env = splittingOnTheTable(true);
  env.state.stories[0].draftsParked = true;
  show(env);
  expect(screen.getByRole("heading", { level: 1, name: "Rate-limit the join endpoint" })).toBeTruthy();
  expect(screen.getByText(/Dana Whitfield/)).toBeTruthy();
  expect(screen.getByText("13", { selector: "[data-present-answer]" })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
});

it("shows no split for a story whose drafts are set aside and is not on the table", () => {
  const env = splittingOnTheTable(true);
  env.state.stories[0].draftsParked = true;
  env.state.currentStoryId = null;
  env.revealed = false;
  show(env);
  expect(screen.queryByRole("list", { name: "Stories in this split" })).toBeNull();
  expect(screen.queryByText("Splitting")).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "No story on the table" })).toBeTruthy();
});

it("gives the stage to the split while the story on the table is being split in front of the room", () => {
  show(splittingOnTheTable(true));
  expect(screen.getByRole("list", { name: "Stories in this split" })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
});

it("shows the title, the seats and the result when a committed ticket itself is on the table", () => {
  const env = poker(true);
  const parent = env.state.stories[0];
  Object.assign(parent, { planningRole: "context", splitRevision: 3 });
  env.state.stories.push(
    { ...parent, id: "a", ref: "", title: "Cart", parentId: parent.id, planningRole: "planning", estimate: "5", votedUserIds: [], votes: undefined, results: undefined },
    { ...parent, id: "b", ref: "", title: "Payment", parentId: parent.id, planningRole: "planning", estimate: "8", votedUserIds: [], votes: undefined, results: undefined },
  );
  show(env);
  expect(screen.getByRole("heading", { level: 1, name: "Rate-limit the join endpoint" })).toBeTruthy();
  expect(screen.getByText(/Dana Whitfield/)).toBeTruthy();
  expect(screen.getByText("13", { selector: "[data-present-answer]" })).toBeTruthy();
});
