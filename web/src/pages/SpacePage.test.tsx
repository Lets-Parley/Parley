import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { api, ApiError } from "../lib/api";
import type { Deck, Me, SpaceView } from "../lib/api";
import { expectNoViolations } from "../test/axe";
import { SpacePage } from "./SpacePage";
import { rememberOpenSession } from "../lib/sessionMemory";
import { inviteLink } from "../lib/invite";

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
// The space's saved decks, as the create dialog reads them.
let decks: Deck[] = [];
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
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (failSpace) throw new Error("network");
        return view;
      }
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

// The api mock is module-scoped, so its call log outlives a test. Tests that
// count calls need the log to be about their own render and nothing else.
beforeEach(() => {
  vi.mocked(api).mockClear();
  decks = [];
});

describe("SpacePage kind filter", () => {
  it("shows every kind under All and narrows to exactly one under a kind tab", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Poker" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Standup" })).toBeTruthy();
  });

  it("hides New session when the space offers no kinds", async () => {
    space.kinds = [];
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await screen.findByText("Recent sessions");
      expect(screen.queryByRole("button", { name: "New session" })).toBe(null);
    } finally {
      delete space.kinds;
    }
  });

  it("offers poker's auto-reveal checkbox and omits it for standup", async () => {
    space.kinds = ["poker", "standup"];
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      // Poker is first in registry order, so the dialog opens on it.
      expect(dialog.getByRole("checkbox", { name: /Auto-reveal when everyone has voted/ })).toBeTruthy();
      await userEvent.click(dialog.getByRole("button", { name: "Standup" }));
      expect(dialog.queryByRole("checkbox", { name: /Auto-reveal when everyone has voted/ })).toBe(null);
    } finally {
      delete space.kinds;
    }
  });

  it("posts autoReveal false by default and true when the poker toggle is on", async () => {
    space.kinds = ["poker"];
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    const createReply = {
      id: "new-1",
      kind: "poker",
      title: "Sprint",
      createdAt: "2026-08-18T12:00:00.000Z",
      endedAt: null,
      here: 0,
    };
    vi.mocked(api).mockImplementation((async (method: string, path: string, _body?: unknown) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (method === "POST" && path === "/api/orgs/acme/spaces/platform-team/sessions") {
        return createReply;
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      await userEvent.type(dialog.getByLabelText("Title"), "Sprint off");
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => {
        const create = vi.mocked(api).mock.calls.find(
          ([m, p]) => m === "POST" && String(p).endsWith("/sessions"),
        );
        expect(create?.[2]).toEqual({
          kind: "poker",
          title: "Sprint off",
          config: { deck: "fibonacci", autoReveal: false },
        });
      });
    } finally {
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    }
  });

  it("posts autoReveal true when the create-dialog toggle is checked", async () => {
    space.kinds = ["poker"];
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((async (method: string, path: string, _body?: unknown) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (method === "POST" && path === "/api/orgs/acme/spaces/platform-team/sessions") {
        return {
          id: "new-2",
          kind: "poker",
          title: "Sprint",
          createdAt: "2026-08-18T12:00:00.000Z",
          endedAt: null,
          here: 0,
        };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      await userEvent.type(dialog.getByLabelText("Title"), "Sprint on");
      await userEvent.click(dialog.getByRole("checkbox", { name: /Auto-reveal when everyone has voted/ }));
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => {
        const create = vi.mocked(api).mock.calls.find(
          ([m, p]) => m === "POST" && String(p).endsWith("/sessions"),
        );
        expect(create?.[2]).toEqual({
          kind: "poker",
          title: "Sprint on",
          config: { deck: "fibonacci", autoReveal: true },
        });
      });
    } finally {
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    }
  });
});

describe("SpacePage invite strip", () => {
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

  // The passcode rides in the fragment so the link is the whole invite, and
  // so it never reaches the server or a Referer header on the way in.
  it("copies a one-click invite, with the passcode in the fragment", async () => {
    view = protectedSpace;
    const writeText = clipboard();
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/o/acme/s/platform-team#c=TEAM49`,
    );
    expect(screen.getByText("Invite link copied — it seats them in one click")).toBeTruthy();
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(await screen.findByText("Could not copy — copy it by hand.")).toBeTruthy();
    expect(screen.queryByText(/Invite link copied/)).toBe(null);
  });

  it("copies the bare link when the space is open", async () => {
    view = { ...space, protected: false, passcode: undefined } as SpaceView;
    const writeText = clipboard();
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy invite" }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/o/acme/s/platform-team`);
    expect(screen.getByText("Invite link copied — it seats them in one click")).toBeTruthy();
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
      <Route path="/o/:org/s/:slug" element={<SpacePage />} />
    </Routes>
  );

  it("posts the stamp once for a member", async () => {
    const { api } = await import("../lib/api");
    renderApp(routed, { route: "/o/acme/s/platform-team" });
    await screen.findAllByText("Sprint 12 grooming");

    const stamps = () =>
      vi.mocked(api).mock.calls.filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/seen");
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
    renderApp(routed, { route: "/o/acme/s/platform-team" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
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
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    expect(await screen.findByText("No table under that name")).toBeTruthy();
  });
});

// spaceReads counts reads of the space itself. The "seen" POST rides the same
// prefix and must not be mistaken for a refresh, and the page is rendered
// without a Route here, so the slug in the path is empty.
function spaceReads(): number {
  return vi
    .mocked(api)
    .mock.calls.filter((c) => c[0] === "GET" && String(c[1]).startsWith("/api/orgs/acme/spaces/")).length;
}

/**
 * Renaming and deleting, from the space down to one room. The controls are a
 * courtesy — the server enforces the same owner rule — so what is asserted
 * here is that the right request goes out and that a member is not shown a
 * button that would only earn them a 403.
 */
describe("SpacePage room admin", () => {
  const owned = {
    ...space,
    members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "owner" }],
  } as unknown as SpaceView;
  const asMember = {
    ...space,
    members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "member" }],
  } as unknown as SpaceView;

  const calls = () => (api as unknown as { mock: { calls: unknown[][] } }).mock.calls;

  afterEach(() => {
    view = space;
  });

  it("offers nothing to manage to a plain member", async () => {
    view = asMember;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findByText("Recent sessions");
    // The settings route is where renaming and deleting live now, and a
    // member is not pointed at it.
    expect(screen.queryByRole("link", { name: "Settings" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Manage Sprint 12 grooming" })).toBe(null);
  });

  it("renames one room through its manage dialog", async () => {
    view = owned;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "Manage Sprint 12 grooming" }));

    const field = screen.getByRole("textbox", { name: "Session title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Sprint 13 grooming");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Rename" }));

    expect(calls()).toContainEqual([
      "PATCH",
      "/api/orgs/acme/spaces/platform-team/sessions/s1",
      { title: "Sprint 13 grooming" },
    ]);
  });

  it("deletes one room behind a second click, and says who it affects", async () => {
    view = owned;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "Manage Sprint 12 grooming" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete this session" }));
    expect(screen.getByText(/for everyone. It cannot be undone/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete for everyone" }));

    expect(calls()).toContainEqual(["DELETE", "/api/orgs/acme/spaces/platform-team/sessions/s1"]);
  });
});

/**
 * A copied invite carries the passcode in the URL fragment, so opening it is
 * the whole join. The fragment is wiped from the address bar on the way in:
 * it must not survive into a bookmark, the back button, or a screenshot.
 */
describe("SpacePage invite links", () => {
  const locked = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
  // Routed, because the join path comes from the URL parameter rather than
  // from the space payload.
  const routed = (
    <Routes>
      <Route path="/o/:org/s/:slug" element={<SpacePage />} />
    </Routes>
  );

  afterEach(() => {
    view = space;
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
  });

  // The round trip, not just the prefix: lib/invite mints the URL, the browser
  // is put at it, and takeInviteCode reads the code back out. Asserting the
  // path alone would pass on a link whose fragment the org prefix had eaten,
  // and a fragment never reaches the server, so nothing else would notice.
  it("seats someone from a link this build itself minted", async () => {
    view = locked;
    const minted = inviteLink("acme", "platform-team", "TEAM49");
    expect(minted).toBe(`${window.location.origin}/o/acme/s/platform-team#c=TEAM49`);
    window.history.replaceState(null, "", minted.slice(window.location.origin.length));
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    const joins = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([, path]) => path === "/api/orgs/acme/spaces/platform-team/join",
    );
    expect(joins).toContainEqual([
      "POST",
      "/api/orgs/acme/spaces/platform-team/join",
      { passcode: "TEAM49" },
    ]);
  });

  it("joins with the passcode from the fragment, then wipes it", async () => {
    view = locked;
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=TEAM49");
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    const joins = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([, path]) => path === "/api/orgs/acme/spaces/platform-team/join",
    );
    expect(joins).toContainEqual(["POST", "/api/orgs/acme/spaces/platform-team/join", { passcode: "TEAM49" }]);
    expect(window.location.hash).toBe("");
  });

  // The join must fire once, not once per render. Without the autoJoined
  // guard the effect re-fires on every re-render and hammers the throttled
  // join endpoint; a toContainEqual assertion alone would not notice.
  it("attempts the invite join exactly once across re-renders", async () => {
    view = locked;
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=TEAM49");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    const { rerender } = renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    rerender(routed);
    rerender(routed);
    await waitFor(() =>
      expect(
        (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
          .slice(before)
          .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
      ).toHaveLength(1),
    );
  });

  it("leaves the gate up, and joins nothing, for a link with no code", async () => {
    view = locked;
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    // The mock accumulates across this file, so only the calls this render
    // makes are counted.
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    const joins = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .slice(before)
      .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join");
    expect(joins).toHaveLength(0);
  });
});

/**
 * Under an identity provider, taking a seat is a full-page trip to the provider
 * and back, and `next` is built from the path and query alone — the fragment
 * does not survive it. Because the fragment has already been wiped by then, a
 * lost invite strands the visitor at the passcode gate with nothing left to
 * type, so something is parked in sessionStorage for exactly one round trip.
 *
 * That something is never the passcode. The code is traded first for an opaque
 * server-issued handle — single use, five minutes, one space — and the handle
 * is what waits.
 */
describe("SpacePage invite links across a sign-in round trip", () => {
  const locked = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
  const routed = (
    <Routes>
      <Route path="/o/:org/s/:slug" element={<SpacePage />} />
    </Routes>
  );

  // The module mock is shared by the whole file, so anything that swaps its
  // implementation has to put the default back — a restoreAllMocks() here
  // leaves `api` returning undefined for every later test in the file.
  const defaultApi = vi.mocked(api).getMockImplementation()!;

  afterEach(() => {
    view = space;
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
    vi.mocked(api).mockImplementation(defaultApi);
    vi.restoreAllMocks();
  });

  it("parks a minted handle, and never the passcode, when the visitor has no identity yet", async () => {
    view = locked;
    // No identity, and a provider: the gate that follows is a full-page
    // navigation, which is the case the parking exists for.
    const seen: unknown[][] = [];
    vi.mocked(api).mockImplementation((async (method: string, path: string, body?: unknown) => {
      seen.push([method, path, body]);
      if (path === "/api/me") return null;
      if (path === "/api/auth") return { mode: "oidc" };
      if (path === "/api/orgs/acme/spaces/platform-team/invite") return { handle: "HANDLE-1" };
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=TEAM49");
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    await waitFor(() => expect(sessionStorage.getItem("parley:pending-invite")).toBeTruthy());
    // The code was spent at the mint door, where the server checks it exactly
    // as the join door does.
    expect(seen).toContainEqual(["POST", "/api/orgs/acme/spaces/platform-team/invite", { passcode: "TEAM49" }]);
    const raw = sessionStorage.getItem("parley:pending-invite")!;
    const parked = JSON.parse(raw);
    expect(parked.handle).toBe("HANDLE-1");
    expect(parked.org).toBe("acme");
    expect(parked.slug).toBe("platform-team");
    // The whole point: the door code itself is nowhere in storage.
    expect(raw).not.toContain("TEAM49");
    expect(parked.code).toBeUndefined();
    // And it is out of the address bar already — the whole point of the wipe.
    expect(window.location.hash).toBe("");
  });

  // A wrong code mints nothing, so there is nothing to park: the mint door
  // refuses it exactly as the join door would.
  it("parks nothing when the passcode is refused at the mint door", async () => {
    view = locked;
    vi.mocked(api).mockImplementation((async (_m: string, path: string) => {
      if (path === "/api/me") return null;
      if (path === "/api/auth") return { mode: "oidc" };
      if (path === "/api/orgs/acme/spaces/platform-team/invite") throw new Error("That passcode doesn't match this space.");
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=WRONG1");
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(sessionStorage.getItem("parley:pending-invite")).toBeNull();
  });

  // Open mode's gate is a modal — the component stays mounted, so there is
  // nothing to park and no reason to mint a handle at all.
  it("parks nothing in open mode, where the gate never leaves the page", async () => {
    view = locked;
    vi.mocked(api).mockImplementation((async (_m: string, path: string) => {
      if (path === "/api/me") return null;
      if (path === "/api/auth") return { mode: "open" };
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=TEAM49");
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    // Give the effect and the auth probe a chance to land before concluding.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(sessionStorage.getItem("parley:pending-invite")).toBeNull();
  });

  it("joins with the parked handle on the way back, with no fragment left", async () => {
    view = locked;
    sessionStorage.setItem(
      "parley:pending-invite",
      JSON.stringify({ handle: "HANDLE-1", org: "acme", slug: "platform-team", at: Date.now() }),
    );
    // Back from the provider: same path, no fragment, and now signed in.
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await screen.findByText("Platform Team");
    await waitFor(() =>
      expect(
        (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
          .slice(before)
          .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
      ).toContainEqual(["POST", "/api/orgs/acme/spaces/platform-team/join", { handle: "HANDLE-1" }]),
    );
    // One attempt only: a refused invite must land on the gate, not loop.
    expect(sessionStorage.getItem("parley:pending-invite")).toBeNull();
  });

  // Slugs are unique inside an org, not across the instance: two orgs can each
  // have a "platform-team". A handle parked for one must not be spent — and
  // burned — against the other's space of the same name.
  it("will not spend a handle parked for the same slug in another org", async () => {
    view = locked;
    sessionStorage.setItem(
      "parley:pending-invite",
      JSON.stringify({ handle: "HANDLE-1", org: "globex", slug: "platform-team", at: Date.now() }),
    );
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(
      (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .slice(before)
        .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
    ).toHaveLength(0);
  });

  it("will not spend a handle parked for a different space", async () => {
    view = locked;
    sessionStorage.setItem(
      "parley:pending-invite",
      JSON.stringify({ handle: "HANDLE-OTHER", slug: "another-team", at: Date.now() }),
    );
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(
      (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .slice(before)
        .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
    ).toHaveLength(0);
  });

  it("ignores a handle parked longer than a sign-in trip could take", async () => {
    view = locked;
    sessionStorage.setItem(
      "parley:pending-invite",
      JSON.stringify({
        handle: "HANDLE-1",
        slug: "platform-team",
        at: Date.now() - 16 * 60 * 1000,
      }),
    );
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(
      (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .slice(before)
        .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
    ).toHaveLength(0);
  });

  // Storage can be unavailable — a locked-down browser, or a runner started
  // with webstorage off. The invite must degrade to the gate, not crash.
  it("still renders the gate when sessionStorage throws", async () => {
    view = locked;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    window.history.replaceState(null, "", "/o/acme/s/platform-team");
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
  });
});

// `GET /api/me` now succeeds for a link guest too (they hold an identity, just
// bound to a different room). Reusing that identity to join *this* space would
// be treating "a successful /api/me" as "a full account" again, the same
// mistake as the space list on Landing — so a guest here goes through the
// name gate exactly like a signed-out visitor, never straight to a join.
describe("SpacePage invite links, a link guest", () => {
  const locked = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
  const routed = (
    <Routes>
      <Route path="/o/:org/s/:slug" element={<SpacePage />} />
    </Routes>
  );

  const defaultApi = vi.mocked(api).getMockImplementation()!;

  afterEach(() => {
    view = space;
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
    vi.mocked(api).mockImplementation(defaultApi);
    vi.restoreAllMocks();
  });

  it("does not join with a guest identity bound to a different room", async () => {
    view = locked;
    vi.mocked(api).mockImplementation((async (_m: string, path: string) => {
      if (path === "/api/me") {
        return {
          id: "guest-1",
          name: "Guest",
          avatarHue: 10,
          linkSessionId: "some-other-session",
          linkExpiresAt: "2099-01-01T00:00:00.000Z",
        };
      }
      if (path === "/api/auth") return { mode: "open" };
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    window.history.replaceState(null, "", "/o/acme/s/platform-team#c=TEAM49");
    const before = (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    // The gate comes up asking for a name, same as a signed-out visitor —
    // never straight into a join under the guest's identity.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      (api as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .slice(before)
        .filter(([, path]) => path === "/api/orgs/acme/spaces/platform-team/join"),
    ).toHaveLength(0);
  });
});


describe("SpacePage expired-session remint", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Primary cookie Max-Age path for #187: cold reload has no member-shaped
  // cache — GET space is stranger JSON and GET /api/me is a bare 401. The
  // remembered open-mode name must still surface "Your session ended", not
  // only the room-code join gate.
  it("shows the expired-session gate on cold reload with a stranger space payload", async () => {
    rememberOpenSession("Marcus Okonjo");
    view = {
      slug: "platform-team",
      name: "Platform Team",
      protected: false,
    } as SpaceView;
    vi.mocked(api).mockImplementation(async (method: string, path: string) => {
      if (path === "/api/auth") return { mode: "open" };
      if (path === "/api/me" && method === "GET") {
        throw new ApiError(401, "unauthorized");
      }
      if (path === "/api/me" && method === "POST") {
        return { id: "u-new", name: "Ada", avatarHue: 40 };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (path.endsWith("/seen") && method === "POST") return undefined;
        return view;
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    });

    renderApp(<SpacePage />, {
      route: "/o/acme/s/platform-team",
      path: "/o/:org/s/:slug",
    });

    expect(await screen.findByRole("heading", { name: /your session ended/i })).toBeTruthy();
  });

  it("keeps half-typed create-session fields mounted under the name gate", async () => {
    rememberOpenSession("Marcus Okonjo");
    view = {
      ...space,
      passcode: "TEAM49",
      members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false }],
    } as SpaceView;
    let signedIn = true;
    vi.mocked(api).mockImplementation(async (method: string, path: string) => {
      if (path === "/api/auth") return { mode: "open" };
      if (path === "/api/me" && method === "GET") {
        if (!signedIn) throw new ApiError(401, "session ended");
        return me;
      }
      if (path === "/api/me" && method === "POST") {
        return { id: "u-new", name: "Ada", avatarHue: 40 };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (path.endsWith("/seen") && method === "POST") return undefined;
        return view;
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    });

    const { queryClient } = renderApp(<SpacePage />, {
      route: "/o/acme/s/platform-team",
      path: "/o/:org/s/:slug",
    });
    await screen.findByText("Recent sessions");
    await userEvent.click(screen.getByRole("button", { name: "New session" }));
    const title = await screen.findByLabelText(/session title|title/i);
    await userEvent.type(title, "Half-typed planning");

    signedIn = false;
    await queryClient.resetQueries({ queryKey: ["me"] });

    expect(await screen.findByRole("heading", { name: /your session ended/i })).toBeTruthy();
    expect(screen.getByDisplayValue("Half-typed planning")).toBeTruthy();
  });

  it("strips passcode/roster from the cache before accepting a reminted seat", async () => {
    rememberOpenSession("Marcus Okonjo");
    view = {
      ...space,
      passcode: "TEAM49",
      members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false }],
    } as SpaceView;
    let signedIn = true;
    let reminted = false;
    const pendingSpace: { resolve: ((v: SpaceView) => void) | null } = { resolve: null };
    vi.mocked(api).mockImplementation(async (method: string, path: string) => {
      if (path === "/api/auth") return { mode: "open" };
      if (path === "/api/me" && method === "GET") {
        if (!signedIn) throw new ApiError(401, "session ended");
        return reminted ? { id: "u-new", name: "Ada", avatarHue: 40 } : me;
      }
      if (path === "/api/me" && method === "POST") {
        reminted = true;
        signedIn = true;
        return { id: "u-new", name: "Ada", avatarHue: 40 };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (path.endsWith("/seen") && method === "POST") return undefined;
        if (reminted) {
          // Hang the refetch so only the stranger-shaped cache can be on screen.
          return new Promise<SpaceView>((resolve) => {
            pendingSpace.resolve = resolve;
          });
        }
        return view;
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    });

    const { queryClient } = renderApp(<SpacePage />, {
      route: "/o/acme/s/platform-team",
      path: "/o/:org/s/:slug",
    });
    expect(await screen.findByText("TEAM49")).toBeTruthy();

    signedIn = false;
    await queryClient.resetQueries({ queryKey: ["me"] });
    expect(await screen.findByRole("heading", { name: /your session ended/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /take a seat as a new guest/i }));

    await waitFor(() => {
      expect(screen.queryByText("TEAM49")).toBeNull();
    });
    // Still a stranger while the space refetch hangs — join gate, not roster.
    expect(screen.queryByText("Recent sessions")).toBeNull();

    pendingSpace.resolve?.({
      slug: "platform-team",
      name: "Platform Team",
      protected: false,
    } as SpaceView);
  });
});

describe("SpacePage deck chooser", () => {
  const house: Deck = {
    id: "d1",
    name: "House deck",
    cards: ["S", "M", "L"],
    ordinal: true,
    createdAt: "2026-08-18T10:00:00.000Z",
  };

  // The suite above leaves its own hung-refetch mock installed, so re-seat a
  // plain one rather than inheriting whatever ran last.
  beforeEach(() => {
    view = space;
    vi.mocked(api).mockImplementation((async (_method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as never);
  });

  async function openDialog() {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    return within(screen.getByRole("dialog"));
  }

  it("offers the space's own decks after the built-in four", async () => {
    space.kinds = ["poker"];
    decks = [house];
    try {
      const dialog = await openDialog();
      const deck = await dialog.findByRole("radio", { name: /House deck/ });
      expect(deck).toBeTruthy();
      expect(dialog.getByRole("radio", { name: /Fibonacci/ })).toBeTruthy();
    } finally {
      delete space.kinds;
    }
  });

  it("posts a custom deck as its cards, never as a row id", async () => {
    space.kinds = ["poker"];
    decks = [house];
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((async (method: string, path: string) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (method === "POST" && path.endsWith("/sessions")) {
        return { id: "new-3", kind: "poker", title: "Sprint", createdAt: "2026-08-18T12:00:00.000Z", endedAt: null, here: 0 };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    try {
      const dialog = await openDialog();
      await userEvent.type(dialog.getByLabelText("Title"), "Sizing");
      await userEvent.click(await dialog.findByRole("radio", { name: /House deck/ }));
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => {
        const create = vi.mocked(api).mock.calls.find(([m, p]) => m === "POST" && String(p).endsWith("/sessions"));
        expect(create?.[2]).toEqual({
          kind: "poker",
          title: "Sizing",
          // The cards themselves: deleting the deck row afterwards must not
          // change what this session deals.
          config: { deck: { name: "House deck", values: ["S", "M", "L"], ordinal: true }, autoReveal: false },
        });
      });
    } finally {
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    }
  });

  it("reaches the chooser by keyboard and announces which deck is chosen", async () => {
    space.kinds = ["poker"];
    decks = [house];
    try {
      const dialog = await openDialog();
      const fib = await dialog.findByRole("radio", { name: /Fibonacci/ });
      expect(fib.getAttribute("aria-checked") ?? String((fib as HTMLInputElement).checked)).toBe("true");
      const custom = dialog.getByRole("radio", { name: /House deck/ }) as HTMLInputElement;
      custom.focus();
      await userEvent.keyboard(" ");
      expect(custom.checked).toBe(true);
      expect((fib as HTMLInputElement).checked).toBe(false);
      // The group says what is being chosen, so the announcement is not a
      // bare "House deck" with no context.
      expect(dialog.getByRole("group", { name: "Deck" })).toBeTruthy();
    } finally {
      delete space.kinds;
    }
  });

  it("has no axe violations in the create dialog", async () => {
    space.kinds = ["poker", "standup"];
    decks = [house];
    try {
      const dialog = await openDialog();
      await dialog.findByRole("radio", { name: /House deck/ });
      await expectNoViolations(screen.getByRole("dialog"));
    } finally {
      delete space.kinds;
    }
  });

  it("leaves the standup dialog fieldless and asks for no decks", async () => {
    space.kinds = ["standup"];
    try {
      const dialog = await openDialog();
      expect(dialog.queryByRole("group", { name: "Deck" })).toBe(null);
      expect(vi.mocked(api).mock.calls.some(([, p]) => String(p).endsWith("/decks"))).toBe(false);
    } finally {
      delete space.kinds;
    }
  });
});
