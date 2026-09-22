import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { Envelope } from "../lib/api";
import { PresentPage } from "./PresentPage";
import { useSession } from "../lib/useSession";

let mockEnv: Envelope | undefined;
let mockIsLoading = false;
vi.mock("../lib/useSession", () => ({
  useSession: vi.fn(() => ({ data: mockEnv, isLoading: mockIsLoading, status: "live" })),
}));

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
  it("shows values and the summary once the round is revealed", async () => {
    const { container } = show(poker(true));
    expect(screen.getByRole("heading", { name: "Rate-limit the join endpoint" })).toBeTruthy();
    expect(screen.getAllByText("13").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/median/)).toBeTruthy();
    expect(screen.getByText("not yet")).toBeTruthy();
    await expectNoViolations(container);
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
