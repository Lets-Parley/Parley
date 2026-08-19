import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import type { Me, SpaceView } from "../lib/api";
import { SpacePage } from "./SpacePage";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

// A kind id with a dot in it is the shape a namespaced plugin kind takes, and
// it is the one that breaks any filter that omits it from its allowlist
// entirely. "pokerful" is the shape that catches a *different* failure mode:
// a filter that matches loosely (substring/prefix) on the id instead of
// comparing it for exact equality.
const space = {
  slug: "platform-team",
  name: "Platform Team",
  member: true,
  protected: false,
  members: [],
  sessions: [
    { id: "s1", kind: "poker", title: "Sprint 12 grooming", createdAt: "2026-08-18T10:00:00.000Z", endedAt: null },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "2026-08-18T09:00:00.000Z", endedAt: null },
    { id: "s3", kind: "acme.retro", title: "Retro of record", createdAt: "2026-08-18T08:00:00.000Z", endedAt: null },
    { id: "s4", kind: "pokerful", title: "Pokerful planning", createdAt: "2026-08-18T07:00:00.000Z", endedAt: null },
  ],
} as unknown as SpaceView;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.startsWith("/api/spaces/")) return space;
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

describe("SpacePage kind filter", () => {
  it("shows every kind under All and narrows to exactly one under a kind tab", async () => {
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    // The sidebar lists the same sessions unfiltered, so every assertion here
    // has to be scoped to the filtered list in the main column.
    const list = () => within(screen.getByRole("main"));

    expect(await screen.findAllByText("Sprint 12 grooming")).toBeTruthy();
    expect(list().getByText("Daily")).toBeTruthy();
    // A dotted kind is a session like any other: "All" must not drop it.
    expect(list().getByText("Retro of record")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Poker" }));
    expect(list().getByText("Sprint 12 grooming")).toBeTruthy();
    expect(list().queryByText("Daily")).toBe(null);
    expect(list().queryByText("Retro of record")).toBe(null);
    // "pokerful" is not "poker": a filter that matched loosely (e.g. via
    // includes/startsWith) on the id instead of comparing it exactly would
    // leak it in here.
    expect(list().queryByText("Pokerful planning")).toBe(null);

    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    expect(list().getByText("Daily")).toBeTruthy();
    expect(list().queryByText("Sprint 12 grooming")).toBe(null);
    // The dotted kind is not a standup: a filter missing it from its
    // allowlist would drop it silently rather than leaking it here.
    expect(list().queryByText("Retro of record")).toBe(null);
    expect(list().queryByText("Pokerful planning")).toBe(null);
  });
});
