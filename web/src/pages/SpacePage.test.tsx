import { afterEach, describe, expect, it, vi } from "vitest";
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

// The api mock reads this, so a test can swap in a different space view.
let view: SpaceView = space;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.startsWith("/api/spaces/")) return view;
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

describe("SpacePage passcode panel", () => {
  const protectedSpace = { ...space, protected: true, passcode: "TEAM49" } as SpaceView;

  function clipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  afterEach(() => {
    view = space;
  });

  it("copies a full invite — link plus passcode — from the primary action", async () => {
    view = protectedSpace;
    const writeText = clipboard();
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/s/platform-team — passcode TEAM49`,
    );
    expect(screen.getByText("Invite copied — link and passcode")).toBeTruthy();
  });

  it("says so instead of claiming success when the clipboard refuses", async () => {
    view = protectedSpace;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(await screen.findByText("Could not copy — copy it by hand.")).toBeTruthy();
    expect(screen.queryByText("Invite copied — link and passcode")).toBe(null);
  });

  it("copies just the code from the secondary action", async () => {
    view = protectedSpace;
    const writeText = clipboard();
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("TEAM49");
    expect(screen.getByText("Passcode copied")).toBeTruthy();
  });

  it("copies the bare link when the space is open", async () => {
    view = { ...space, protected: false, passcode: undefined } as SpaceView;
    const writeText = clipboard();
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/platform-team`);
    expect(screen.getByText("Invite link copied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBe(null);
  });
});
