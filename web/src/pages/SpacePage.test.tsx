import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { api } from "../lib/api";
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
  // s4 is ended *and* carries a count. The server never sends that pair, and
  // that is exactly why the fixture does: "ended" has to win on the row's own
  // logic rather than on the server happening to zero the count.
  sessions: [
    { id: "s1", kind: "poker", title: "Sprint 12 grooming", createdAt: "2026-08-18T10:00:00.000Z", endedAt: null, here: 3 },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "2026-08-18T09:00:00.000Z", endedAt: null, here: 0 },
    { id: "s3", kind: "acme.retro", title: "Retro of record", createdAt: "2026-08-18T08:00:00.000Z", endedAt: null, here: 1 },
    { id: "s4", kind: "pokerful", title: "Pokerful planning", createdAt: "2026-08-18T07:00:00.000Z", endedAt: "2026-08-18T11:00:00.000Z", here: 2 },
  ],
} as unknown as SpaceView & { kinds?: string[] };

// The api mock reads this, so a test can swap in a different space view.
let view: SpaceView = space;
// Flipped on to make the next space read fail, which is how a background
// refetch failure is reproduced.
let failSpace = false;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.startsWith("/api/spaces/")) {
        if (failSpace) throw new Error("network");
        return view;
      }
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

describe("SpacePage session list", () => {
  // The list row is one of the two places the chip is actually rendered.
  // Nothing else in the row names the kind, so deleting the chip would
  // otherwise leave the page saying nothing at all about what a session is.
  it("names each session's kind on its row, with the glyph", async () => {
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    await screen.findAllByText("Sprint 12 grooming");
    // The sidebar lists the same sessions, so scope to the main column.
    const main = within(screen.getByRole("main"));

    const row = main.getByText("Sprint 12 grooming").closest("a")!;
    expect(within(row).getByText("Poker")).toBeTruthy();
    expect(row.querySelector("svg")).toBeTruthy();

    // An unknown kind still gets named — by its wire id — and still no glyph.
    const dotted = main.getByText("Retro of record").closest("a")!;
    expect(within(dotted).getByText("acme.retro")).toBeTruthy();
    expect(dotted.querySelector("svg")).toBe(null);
  });

  // The empty state borrows the chip's label vocabulary as inline text: it
  // has to say which filter came up empty, in the same words as the tab.
  it("names the active kind filter when nothing matches", async () => {
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    await screen.findByText("Recent sessions");
    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    await userEvent.type(screen.getByLabelText("Search sessions"), "zzz");

    const main = within(screen.getByRole("main"));
    expect(main.getByText(/Nothing matches/).textContent).toContain("in Standup sessions");
  });
});

describe("SpacePage create dialog", () => {
  it("offers only the kinds the space view lists, so a retired one cannot be picked", async () => {
    // The server omits a retired kind from the space view; the dialog must
    // offer what the server listed rather than every kind it can render.
    space.kinds = ["poker"];
    try {
      renderApp(<SpacePage />, { route: "/s/platform-team" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByRole("button", { name: "Poker" })).toBeTruthy();
      // The tab strip still names Standup — that filters existing sessions —
      // so this assertion has to be scoped to the dialog, and it fails for a
      // dialog that simply rendered every built-in kind.
      expect(dialog.queryByRole("button", { name: "Standup" })).toBe(null);
    } finally {
      delete space.kinds;
    }
  });

  it("offers every kind when the space view lists them all", async () => {
    space.kinds = ["poker", "standup"];
    try {
      renderApp(<SpacePage />, { route: "/s/platform-team" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByRole("button", { name: "Poker" })).toBeTruthy();
      expect(dialog.getByRole("button", { name: "Standup" })).toBeTruthy();
    } finally {
      delete space.kinds;
    }
  });

  it("offers every kind when the server omits the kinds field (older server)", async () => {
    // No `space.kinds` is set here: an older server sends no field at all,
    // and the page must fall back to offering everything rather than
    // treating the absence as an empty allowlist.
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Poker" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Standup" })).toBeTruthy();
  });

  it("hides New session when the space offers no kinds", async () => {
    space.kinds = [];
    try {
      renderApp(<SpacePage />, { route: "/s/platform-team" });
      await screen.findByText("Recent sessions");
      expect(screen.queryByRole("button", { name: "New session" })).toBe(null);
    } finally {
      delete space.kinds;
    }
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

// The landing list is ordered by when you last opened a space, and the space
// read is a plain GET that must not write. The page therefore says "I opened
// this" out loud, and only when it is actually looking at a space it belongs
// to.
describe("SpacePage last-opened stamp", () => {
  afterEach(() => {
    view = space;
  });

  // Routed for real, so the stamp has to name the slug from the URL rather
  // than an empty string.
  const routed = (
    <Routes>
      <Route path="/s/:slug" element={<SpacePage />} />
    </Routes>
  );

  it("posts the stamp once for a member", async () => {
    const { api } = await import("../lib/api");
    renderApp(routed, { route: "/s/platform-team" });
    await screen.findAllByText("Sprint 12 grooming");

    const stamps = () =>
      vi.mocked(api).mock.calls.filter(([, path]) => path === "/api/spaces/platform-team/seen");
    expect(stamps().length).toBe(1);
    expect(stamps()[0][0]).toBe("POST");

    // Opening a space is one visit however many times the page re-renders.
    // Driving real re-renders is what makes "once" an assertion rather than
    // an artefact of the harness rendering once and stopping: an effect with
    // no dependency array would fire again on each of these.
    await userEvent.click(screen.getByRole("button", { name: "Poker" }));
    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(stamps().length).toBe(1);
  });

  it("does not stamp a space the visitor is not a member of", async () => {
    const { api } = await import("../lib/api");
    vi.mocked(api).mockClear();
    view = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
    renderApp(routed, { route: "/s/platform-team" });
    await screen.findByText("Platform Team");

    expect(
      vi.mocked(api).mock.calls.some(([, path]) => path.endsWith("/seen")),
    ).toBe(false);
  });
});

describe("SpacePage session badge", () => {
  afterEach(() => {
    view = space;
    failSpace = false;
    vi.useRealTimers();
  });

  // The row is a bare <Link> with no aria-label, so its accessible name is
  // the whole row read out — title, date, kind chip and badge concatenated.
  // Matching it needs a regex; an exact string would never hit.
  function row(title: string) {
    // The sidebar lists the same sessions, so scope to the main column first.
    const main = within(screen.getByRole("main"));
    return within(main.getByRole("link", { name: new RegExp(title) }));
  }

  it("counts the people in each session rather than calling every open one live", async () => {
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    await screen.findByText("Recent sessions");

    // A busy session says how many, and never the old word.
    expect(row("Sprint 12 grooming").getByText("3 here")).toBeTruthy();
    expect(row("Sprint 12 grooming").queryByText("live")).toBe(null);
    // One person is still a count, not a special case.
    expect(row("Retro of record").getByText("1 here")).toBeTruthy();
    // An open session nobody is in is quiet — not green, not "live".
    expect(row("Daily").getByText("open")).toBeTruthy();
    expect(row("Daily").queryByText(/here/)).toBe(null);
    // Ended beats any count.
    expect(row("Pokerful planning").getByText("ended")).toBeTruthy();
    expect(row("Pokerful planning").queryByText(/here/)).toBe(null);
    expect(row("Pokerful planning").queryByText("2 here")).toBe(null);
    expect(row("Pokerful planning").queryByText("open")).toBe(null);
  });

  it("re-reads the space on a timer, so the count does not freeze at page load", async () => {
    // Call history survives between tests in this file, so the count has to
    // start from a clean slate rather than from whatever ran before.
    vi.mocked(api).mockClear();
    vi.useFakeTimers();
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    // findBy* is off the table under fake timers — its polling runs on the
    // clock the test is holding still. Advance instead, well short of the
    // poll interval, to let the first read settle.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spaceReads()).toBe(1);

    // The interval is armed once the first read settles, so land just past
    // 30s from there rather than exactly on the boundary.
    await vi.advanceTimersByTimeAsync(30_100);
    // Presence ages out after ~100s. A page that reads once shows a count
    // that is wrong within two minutes and stays wrong.
    expect(spaceReads()).toBe(2);
  });

  it("keeps the page up when a background refresh fails", async () => {
    vi.useFakeTimers();
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByText("Recent sessions")).toBeTruthy();

    // One flaky response — a deploy, a proxy hiccup, a single 5xx. The cached
    // space is still perfectly good, so the dead-end screen must not appear.
    failSpace = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(screen.queryByText("No table under that name")).toBe(null);
    expect(screen.getByText("Recent sessions")).toBeTruthy();
    expect(row("Sprint 12 grooming").getByText("3 here")).toBeTruthy();
  });

  it("still shows the dead end when the very first read fails", async () => {
    failSpace = true;
    renderApp(<SpacePage />, { route: "/s/platform-team" });
    expect(await screen.findByText("No table under that name")).toBeTruthy();
  });
});

// spaceReads counts reads of the space itself. The "seen" POST rides the same
// prefix and must not be mistaken for a refresh, and the page is rendered
// without a Route here, so the slug in the path is empty.
function spaceReads(): number {
  return vi
    .mocked(api)
    .mock.calls.filter((c) => c[0] === "GET" && String(c[1]).startsWith("/api/spaces/")).length;
}
