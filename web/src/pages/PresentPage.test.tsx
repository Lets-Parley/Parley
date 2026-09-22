import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { Envelope } from "../lib/api";
import { PresentPage } from "./PresentPage";

let mockEnv: Envelope;
vi.mock("../lib/useSession", () => ({
  useSession: vi.fn(() => ({ data: mockEnv, isLoading: false, status: "live" })),
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

function show(env: Envelope) {
  mockEnv = env;
  return renderApp(<PresentPage />, { route: "/session/sess-1/present", path: "/session/:id/present" });
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

  it("renders no vote values before the reveal", () => {
    const { container } = show(poker(false));
    expect(container.textContent).not.toContain("13");
    expect(screen.getByText("voted")).toBeTruthy();
    expect(screen.getByText("not yet")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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
});
