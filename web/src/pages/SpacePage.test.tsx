import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { api, ApiError } from "../lib/api";
import type { Deck, Kudo, Me, SpaceView } from "../lib/api";
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
  // Nobody named and no progress anywhere in the base fixture: the tests that
  // read faces, progress or activity build their own sessions, so none of
  // them can pass on something this shared fixture happened to carry.
  sessions: [
    { id: "s1", kind: "poker", title: "Sprint 12 grooming", createdAt: "2026-08-18T10:00:00.000Z", endedAt: null, here: 3, lastActivityAt: "2026-08-18T10:00:00.000Z", present: [], progress: null },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "2026-08-18T09:00:00.000Z", endedAt: null, here: 0, lastActivityAt: "2026-08-18T09:00:00.000Z", present: [], progress: null },
    { id: "s3", kind: "acme.retro", title: "Retro of record", createdAt: "2026-08-18T08:00:00.000Z", endedAt: null, here: 1, lastActivityAt: "2026-08-18T08:00:00.000Z", present: [], progress: null },
    { id: "s4", kind: "pokerful", title: "Pokerful planning", createdAt: "2026-08-18T07:00:00.000Z", endedAt: "2026-08-18T11:00:00.000Z", here: 2, lastActivityAt: "2026-08-18T11:00:00.000Z", present: [], progress: null },
  ],
} as unknown as SpaceView & { kinds?: string[] };

// The main column's own heading. The sidebar carries a "Sessions" heading
// too, so this is scoped to <main>, which also only exists once the space
// has loaded.
async function findSessionsHeading() {
  return within(await screen.findByRole("main")).findByRole("heading", { name: "Sessions" });
}

// Every polite status region on the page, read together: the toast and the
// session list's match count are both one.
function statusText() {
  return screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "")
    .join(" | ");
}

// The api mock reads this, so a test can swap in a different space view.
let view: SpaceView = space;
// The space's saved decks, as the create dialog reads them.
let decks: Deck[] = [];
// The space's kudos, as the wall reads them. Newest first, the way the
// handler answers.
let kudos: Kudo[] = [];
// The space's team participation trend, as the standup panel reads it.
let trend: { weeks: { weekStart: string; ratio?: number; suppressed?: boolean }[] } = { weeks: [] };
// The viewer's own away ranges, as the away-days form beside the trend reads them.
let awayRanges: { id: string; startsOn: string; endsOn: string }[] = [];
// Flipped on to make the next space read fail, which is how a background
// refetch failure is reproduced.
let failSpace = false;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/kudos") && method === "GET") return kudos;
      if (path.endsWith("/kudos") && method === "POST") {
        const b = body as { to: string; text: string };
        const k = {
          id: `k${kudos.length + 1}`,
          fromUserId: me.id,
          toUserId: b.to,
          text: b.text,
          createdAt: "2026-09-03T09:00:00.000Z",
          sessionId: "",
        };
        kudos = [k, ...kudos];
        return k;
      }
      if (path.includes("/kudos/") && method === "DELETE") {
        kudos = kudos.filter((k) => !path.endsWith(`/kudos/${k.id}`));
        return undefined;
      }
      if (path.endsWith("/kudos")) return [];
      if (path === "/api/orgs/acme/spaces/platform-team/standup-trend") return trend;
      if (path === "/api/me/away" && method === "GET") return { ranges: awayRanges };
      if (path === "/api/me/away" && method === "POST") {
        const b = body as { startsOn: string; endsOn: string };
        const r = { id: `a${awayRanges.length + 1}`, ...b };
        awayRanges = [...awayRanges, r];
        return r;
      }
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (failSpace) throw new Error("network");
        return view;
      }
      if (path.includes("/plugins/panels")) return [];
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

// The api mock is module-scoped, so its call log outlives a test. Tests that
// count calls need the log to be about their own render and nothing else.
beforeEach(() => {
  vi.mocked(api).mockClear();
  decks = [];
  kudos = [];
  trend = { weeks: [] };
  awayRanges = [];
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

    // Live rooms sit on cards above the list; the chip is on the card.
    const row = main.getByText("Sprint 12 grooming").closest("li")!;
    expect(within(row).getByText("Poker")).toBeTruthy();
    expect(row.querySelector('[data-token="card"]')).toBeTruthy();
    const daily = main.getByText("Daily").closest("a")!;
    expect(within(daily).getByText("Standup")).toBeTruthy();
    expect(daily.querySelector('[data-token="round"]')).toBeTruthy();

    // An unknown kind still gets named — by its wire id — and no object.
    const dotted = main.getByText("Retro of record").closest("li")!;
    expect(within(dotted).getByText("acme.retro")).toBeTruthy();
    expect(dotted.querySelector("[data-token]")).toBe(null);
  });

  // Filtered to one kind, every row would repeat the same word: the object
  // stays, the label goes, and the kind still reaches the row's name.
  it("drops the kind label once the list is filtered to one kind", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    await userEvent.click(screen.getByRole("button", { name: "Poker" }));
    const main = within(screen.getByRole("main"));
    const row = main.getByText("Sprint 12 grooming").closest("li")!;
    expect(within(row).queryByText("Poker")).toBe(null);
    expect(within(row).getByRole("img", { name: "Poker" }).querySelector('[data-token="card"]')).toBeTruthy();
  });

  it("drops the kind label in a space whose sessions are all one kind", async () => {
    view = {
      ...space,
      sessions: (space.sessions ?? []).filter((s) => s.kind === "standup"),
    } as SpaceView;
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await screen.findAllByText("Daily");
      const main = within(screen.getByRole("main"));
      const row = main.getByText("Daily").closest("a")!;
      expect(within(row).queryByText("Standup")).toBe(null);
      expect(within(row).getByRole("img", { name: "Standup" })).toBeTruthy();
    } finally {
      view = space;
    }
  });

  // The empty state borrows the chip's label vocabulary as inline text: it
  // has to say which filter came up empty, in the same words as the tab.
  it("names the active kind filter when nothing matches", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await findSessionsHeading();
    await userEvent.click(screen.getByRole("button", { name: "Standup" }));
    await userEvent.type(screen.getByLabelText("Search sessions"), "zzz");

    const main = within(screen.getByRole("main"));
    expect(main.getByText(/Nothing matches/).textContent).toContain("in Standup sessions");
  });
});

/**
 * The main list in three groups: whatever has people in it right now, the
 * rooms still open, and a folded logbook of the ones that ended. The base
 * fixture has two live rooms (s1 with 3, s3 with 1), one open and empty (s2),
 * and one ended room that still carries a count (s4) — which must not be
 * offered as a live one.
 */
describe("SpacePage live, open and logbook groups", () => {
  const main = () => within(screen.getByRole("main"));

  afterEach(() => {
    view = space;
    vi.useRealTimers();
    try {
      localStorage.clear();
    } catch {
      // Nothing was remembered to forget.
    }
  });

  function sessions(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      kind: "poker",
      title: `Round ${i}`,
      createdAt: "2026-08-18T10:00:00.000Z",
      endedAt: null,
      here: 0,
      lastActivityAt: "2026-08-18T10:00:00.000Z",
      present: [],
      progress: null,
    }));
  }

  it("lifts only sessions with people in them onto the table, each with a Rejoin link", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");

    const live = main().getByRole("list", { name: "On the table now" });
    const rejoin = within(live).getByRole("link", { name: "Rejoin Sprint 12 grooming" });
    expect(rejoin.getAttribute("href")).toBe("/session/s1");
    expect(within(live).getByRole("link", { name: "Rejoin Retro of record" }).getAttribute("href")).toBe(
      "/session/s3",
    );
    expect(within(live).getByText("3 here")).toBeTruthy();
    expect(within(live).getByText("1 here")).toBeTruthy();
    // Open but empty is not on the table, and ended beats any count.
    expect(within(live).queryByText("Daily")).toBe(null);
    expect(within(live).queryByText("Pokerful planning")).toBe(null);
    expect(main().queryByRole("link", { name: /Rejoin Daily/ })).toBe(null);
    expect(main().queryByRole("link", { name: /Rejoin Pokerful/ })).toBe(null);
  });

  it("shows no table card when nobody is in any session", async () => {
    view = {
      ...space,
      sessions: space.sessions!.map((s) => ({ ...s, here: 0 })),
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    expect(main().queryByRole("list", { name: "On the table now" })).toBe(null);
    expect(main().queryByRole("link", { name: /^Rejoin/ })).toBe(null);
  });

  it("folds ended sessions into a closed logbook that counts them", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");

    const summary = main().getByText("Logbook · 1 ended");
    const logbook = summary.closest("details")!;
    expect(logbook).toBeTruthy();
    expect(logbook.open).toBe(false);
    expect(within(logbook).getByText("Pokerful planning")).toBeTruthy();
    // Only ended rooms are in it, and it no longer shouts "ended" in a pill.
    expect(within(logbook).queryByText("Daily")).toBe(null);
    expect(within(logbook).queryByText("ended")).toBe(null);

    const open = main().getByRole("list", { name: "Open rooms" });
    expect(within(open).getByText("Daily")).toBeTruthy();
    expect(within(open).queryByText("Pokerful planning")).toBe(null);
  });

  it("remembers the logbook open for this viewer", async () => {
    const first = renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    await userEvent.click(main().getByText("Logbook · 1 ended"));
    expect(main().getByText("Logbook · 1 ended").closest("details")!.open).toBe(true);
    first.unmount();

    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    expect(main().getByText("Logbook · 1 ended").closest("details")!.open).toBe(true);
  });

  it("says when an open room was last active, and never calls it idle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    // Made ten days ago, last touched six days ago: the age is the touch.
    view = {
      ...space,
      sessions: [
        { id: "o1", kind: "standup", title: "Daily", createdAt: "2026-08-14T12:00:00.000Z", endedAt: null, here: 0, lastActivityAt: "2026-08-18T12:00:00.000Z", present: [], progress: null },
      ],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Daily");

    const open = main().getByRole("list", { name: "Open rooms" });
    expect(within(open).getAllByText("active 6 days ago").length).toBeGreaterThan(0);
    expect(within(open).queryByText(/opened/)).toBe(null);
    expect(within(open).queryByText(/idle/)).toBe(null);
    // The date under the title is still the day it was made.
    expect(within(open).getByText(/Fri, Aug 14/)).toBeTruthy();
    // The row names itself, kind first, the way the sidebar does.
    expect(main().getByRole("link", { name: "Standup · Daily · active 6 days ago" })).toBeTruthy();
  });

  it("says active today and active yesterday by the viewer's calendar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    view = {
      ...space,
      sessions: [
        { id: "o1", kind: "poker", title: "Touched now", createdAt: "2026-08-10T12:00:00.000Z", endedAt: null, here: 0, lastActivityAt: "2026-08-24T11:00:00.000Z", present: [], progress: null },
        { id: "o2", kind: "poker", title: "Touched before", createdAt: "2026-08-10T12:00:00.000Z", endedAt: null, here: 0, lastActivityAt: "2026-08-23T12:00:00.000Z", present: [], progress: null },
      ],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Touched now");
    expect(main().getByRole("link", { name: "Poker · Touched now · active today" })).toBeTruthy();
    expect(main().getByRole("link", { name: "Poker · Touched before · active yesterday" })).toBeTruthy();
  });

  // Live cards read `present`, which is who the server names: members only,
  // facilitator first. Their faces come from the roster by id.
  const crew = [
    { userId: "dana", name: "Dana", avatarHue: 20, spectator: false, role: "member" },
    { userId: "bojan", name: "Bojan", avatarHue: 120, spectator: false, role: "member" },
    { userId: "jalynn", name: "Jalynn", avatarHue: 240, spectator: false, role: "member" },
  ];
  function liveView(rooms: Record<string, unknown>[]) {
    return {
      ...space,
      members: crew,
      sessions: rooms.map((r, i) => ({
        id: `l${i}`,
        kind: "poker",
        title: `Live ${i}`,
        createdAt: "2026-08-18T10:00:00.000Z",
        endedAt: null,
        here: 1,
        lastActivityAt: "2026-08-18T10:00:00.000Z",
        present: [],
        progress: null,
        ...r,
      })),
    } as unknown as SpaceView;
  }
  const card = (title: string) => main().getByRole("link", { name: `Rejoin ${title}` }).closest("li")!;

  it("shows the faces of who is in, facilitator first, with brass on the facilitator alone", async () => {
    view = liveView([
      {
        title: "Refinement",
        here: 3,
        present: [
          { id: "dana", name: "Dana", facilitator: true },
          { id: "bojan", name: "Bojan", facilitator: false },
          { id: "jalynn", name: "Jalynn", facilitator: false },
        ],
      },
    ]);
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Refinement");

    const live = card("Refinement");
    expect(within(live).getByText("Dana, Bojan and Jalynn are in")).toBeTruthy();
    const faces = live.querySelector("[data-faces]")!;
    expect(faces).toBeTruthy();
    const discs = Array.from(faces.children);
    expect(discs.map((d) => d.textContent)).toEqual(["DA", "BO", "JA"]);
    const brass = faces.querySelectorAll(".bg-brass");
    expect(brass.length).toBe(1);
    expect(discs[0].contains(brass[0])).toBe(true);
  });

  it("counts the people it cannot name as more, and names nobody it was not given", async () => {
    view = liveView([
      {
        title: "Crowded",
        here: 5,
        present: [
          { id: "dana", name: "Dana", facilitator: true },
          { id: "bojan", name: "Bojan", facilitator: false },
        ],
      },
      { title: "Alone", here: 1, present: [{ id: "jalynn", name: "Jalynn", facilitator: false }] },
      // Two link guests: counted in `here`, never named.
      { title: "Guests only", here: 2, present: [] },
    ]);
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Crowded");

    expect(within(card("Crowded")).getByText("Dana, Bojan and 3 more are in")).toBeTruthy();
    expect(within(card("Crowded")).queryAllByText(/Jalynn/)).toEqual([]);
    expect(within(card("Alone")).getByText("Jalynn is in")).toBeTruthy();
    const guests = card("Guests only");
    expect(within(guests).getByText("2 here")).toBeTruthy();
    expect(within(guests).queryByText(/ in$/)).toBe(null);
    expect(guests.querySelector("[data-faces]")).toBe(null);
  });

  it("says how far a live room has got, by kind, and nothing when there is nothing to count", async () => {
    view = liveView([
      { title: "Estimating", progress: { kind: "poker", settled: 4, total: 9 } },
      { title: "Morning", kind: "standup", progress: { kind: "standup", answered: 5, total: 6 } },
      { title: "Plugin room", kind: "acme.retro", progress: null },
      { title: "No stories yet", progress: { kind: "poker", settled: 0, total: 0 } },
    ]);
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Estimating");

    expect(within(card("Estimating")).getByText("4 of 9 settled")).toBeTruthy();
    expect(within(card("Morning")).getByText("5 of 6 answered")).toBeTruthy();
    for (const quiet of ["Plugin room", "No stories yet"]) {
      expect(within(card(quiet)).queryByText(/settled|answered/)).toBe(null);
    }
    // We know how many are settled, not which story is up.
    expect(main().queryByText(/Story \d/)).toBe(null);
  });

  it("says what each ended session came to in the logbook", async () => {
    view = {
      ...space,
      sessions: [
        { id: "e1", kind: "poker", title: "Refinement", createdAt: "2026-08-18T10:00:00.000Z", endedAt: "2026-08-18T11:00:00.000Z", here: 0, lastActivityAt: "2026-08-18T11:00:00.000Z", present: [], progress: { kind: "poker", settled: 7, total: 9 } },
        { id: "e2", kind: "standup", title: "Morning", createdAt: "2026-08-18T09:00:00.000Z", endedAt: "2026-08-18T09:30:00.000Z", here: 0, lastActivityAt: "2026-08-18T09:30:00.000Z", present: [], progress: { kind: "standup", answered: 5, total: 6 } },
        { id: "e3", kind: "acme.retro", title: "Plugin room", createdAt: "2026-08-18T08:00:00.000Z", endedAt: "2026-08-18T08:30:00.000Z", here: 0, lastActivityAt: "2026-08-18T08:30:00.000Z", present: [], progress: null },
      ],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Refinement");
    const logbook = main().getByText("Logbook · 3 ended").closest("details")!;

    const settled = within(logbook).getByText("7 settled");
    expect(settled.className).toContain("text-settled");
    const answered = within(logbook).getByText("5 of 6 answered");
    expect(answered.className).toContain("text-ink-faint");
    expect(answered.className).not.toContain("text-settled");
    // The link's own name carries it, since the label replaces its text.
    expect(within(logbook).getByRole("link", { name: "Poker · Refinement · ended · 7 settled" })).toBeTruthy();
    expect(within(logbook).getByRole("link", { name: "Standup · Morning · ended · 5 of 6 answered" })).toBeTruthy();
    expect(within(logbook).getByRole("link", { name: "acme.retro · Plugin room · ended" })).toBeTruthy();
  });

  it("remembers the logbook per space, so one space's open logbook leaves another's shut", async () => {
    const first = renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    await userEvent.click(main().getByText("Logbook · 1 ended"));
    expect(localStorage.getItem("parley:logbook-open:acme/platform-team")).toBe("1");
    first.unmount();

    renderApp(<SpacePage />, { route: "/o/acme/s/other-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    expect(main().getByText("Logbook · 1 ended").closest("details")!.open).toBe(false);
  });

  it("draws the search glyph as an svg, not a styled span", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const field = await screen.findByLabelText("Search sessions");
    const glyph = field.closest("label")!.querySelector("svg");
    expect(glyph).toBeTruthy();
    expect(glyph!.getAttribute("aria-hidden")).toBe("true");
    expect(field.closest("label")!.querySelector("span.rounded-full")).toBe(null);
  });

  it("focuses search on / from the page, but types a / into a field that has focus", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const field = (await screen.findByLabelText("Search sessions")) as HTMLInputElement;
    expect(document.activeElement).not.toBe(field);

    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(field);
    // The shortcut key is not typed into the field it just focused.
    expect(field.value).toBe("");

    // Once inside a field, / is just a character.
    await userEvent.keyboard("a/b");
    expect(field.value).toBe("a/b");
  });

  it("does not steal / from a field in an open dialog", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await userEvent.type(title, "1/2");
    expect(title.value).toBe("1/2");
    expect(document.activeElement).toBe(title);

    // A button in the dialog is not a field, and / still stays put: the
    // search sits behind the dialog, where focus must not go.
    const cancel = within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(cancel);
  });

  it("announces how many sessions a search leaves, politely", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const field = await screen.findByLabelText("Search sessions");
    const status = main().getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");

    await userEvent.type(field, "Daily");
    expect(status.textContent).toBe("1 session matches");

    await userEvent.clear(field);
    await userEvent.type(field, "r");
    // "Sprint 12 grooming", "Retro of record", "Pokerful planning" — across
    // all three groups, the folded logbook included.
    expect(status.textContent).toBe("3 sessions match");

    await userEvent.type(field, "zzz");
    expect(status.textContent).toBe("No sessions match");
  });

  it("says the list stops at the latest 50 when the server sent 50", async () => {
    view = { ...space, sessions: sessions(50) } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Round 0");
    expect(main().getByText("Showing the latest 50 sessions")).toBeTruthy();
  });

  it("says nothing about a cap at 49 sessions", async () => {
    view = { ...space, sessions: sessions(49) } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Round 0");
    expect(main().queryByText(/latest 50/)).toBe(null);
  });

  it("has no axe violations with the table card, the list and an open logbook", async () => {
    view = {
      ...space,
      members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "owner" }],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    await userEvent.click(main().getByText("Logbook · 1 ended"));
    await expectNoViolations(screen.getByRole("main"));
  }, 15_000);

  it("groups the kind tabs under a name", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    const tabs = main().getByRole("group", { name: "Filter by kind" });
    expect(within(tabs).getByRole("button", { name: "All" })).toBeTruthy();
  });

  it("puts Manage after the row it manages, as a real touch target", async () => {
    view = {
      ...space,
      members: [{ userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "owner" }],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const manage = await screen.findByRole("button", { name: "Manage Daily" });
    const rowLink = main().getByRole("link", { name: /^Standup · Daily/ });
    expect(rowLink.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(manage.className).toContain("touch-hit");
    expect(manage.className).toContain("border-line-strong");
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
      expect(dialog.getByRole("radio", { name: "Poker" })).toBeTruthy();
      // The tab strip still names Standup — that filters existing sessions —
      // so this assertion has to be scoped to the dialog, and it fails for a
      // dialog that simply rendered every built-in kind.
      expect(dialog.queryByRole("radio", { name: "Standup" })).toBe(null);
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
      expect(dialog.getByRole("radio", { name: "Poker" })).toBeTruthy();
      expect(dialog.getByRole("radio", { name: "Standup" })).toBeTruthy();
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
    expect(dialog.getByRole("radio", { name: "Poker" })).toBeTruthy();
    expect(dialog.getByRole("radio", { name: "Standup" })).toBeTruthy();
  });

  // The picker shows each kind as its object, scaled up, and the object adds
  // nothing to the radio's name: "Poker", not "Poker Poker".
  it("shows each kind's object in the picker without changing the radio's name", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog"));
    const poker = dialog.getByRole("radio", { name: "Poker" }).closest("label")!;
    expect([...poker.querySelector('[data-token="card"]')!.classList]).toContain("w-[34px]");
    // Hover is on the whole choice, so the label is the group.
    expect([...poker.classList]).toContain("group");
    const standup = dialog.getByRole("radio", { name: "Standup" }).closest("label")!;
    expect(standup.querySelector('[data-token="round"]')).toBeTruthy();
  });

  it("offers the kind as one named radio group, like Mode beside it", async () => {
    // The kind picker was a pair of aria-pressed buttons under a bare "Kind"
    // span: two tab stops, no group name, and a different pattern from the
    // Mode radios in the same dialog. A native radio group gives one tab
    // stop, arrow keys and the group's name from the platform.
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog"));
    const group = within(dialog.getByRole("group", { name: "Kind" }));
    const poker = group.getByRole("radio", { name: "Poker" }) as HTMLInputElement;
    const standup = group.getByRole("radio", { name: "Standup" }) as HTMLInputElement;
    expect(poker.checked).toBe(true);
    expect(standup.checked).toBe(false);
    expect(poker.name).toBe(standup.name);
    expect(dialog.queryByRole("button", { name: "Poker" })).toBe(null);

    await userEvent.click(standup);
    expect(standup.checked).toBe(true);
    expect(poker.checked).toBe(false);
    // Standup's own fields follow the choice.
    expect(dialog.getByRole("group", { name: "Mode" })).toBeTruthy();

    // Arrow keys move the choice, the platform's radio path.
    standup.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(poker.checked).toBe(true);
    expect(document.activeElement).toBe(poker);
    expect(dialog.queryByRole("group", { name: "Mode" })).toBe(null);
    await userEvent.keyboard("{ArrowRight}");
    expect(standup.checked).toBe(true);
    expect(document.activeElement).toBe(standup);
  });

  it("hides New session when the space offers no kinds", async () => {
    space.kinds = [];
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await findSessionsHeading();
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
      await userEvent.click(dialog.getByRole("radio", { name: "Standup" }));
      expect(dialog.queryByRole("checkbox", { name: /Auto-reveal when everyone has voted/ })).toBe(null);
      expect(dialog.queryByRole("checkbox", { name: /Open voting/ })).toBe(null);
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
          config: { deck: "fibonacci", autoReveal: false, openVoting: false },
        });
      });
    } finally {
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    }
  });

  it("offers open voting in the create dialog and says what it changes", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await userEvent.click(await screen.findByRole("button", { name: "New session" }));
    const dialog = within(screen.getByRole("dialog"));
    const box = dialog.getByRole("checkbox", { name: /Open voting/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    // It is not a second reveal switch, and the dialog has to say so.
    expect(dialog.getByText(/waits for/)).toBeTruthy();
  });

  it("posts openVoting true when the create-dialog open-voting toggle is checked", async () => {
    space.kinds = ["poker"];
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((async (method: string, path: string, _body?: unknown) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (method === "POST" && path === "/api/orgs/acme/spaces/platform-team/sessions") {
        return {
          id: "new-3",
          kind: "poker",
          title: "Sprint open",
          createdAt: "2026-08-18T12:00:00.000Z",
          endedAt: null,
          here: 0,
        };
      }
      if (path.endsWith("/decks")) return decks;
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
      throw new Error(`unexpected api call: ${path}`);
    }) as typeof defaultApi);
    try {
      renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
      await userEvent.click(await screen.findByRole("button", { name: "New session" }));
      const dialog = within(screen.getByRole("dialog"));
      await userEvent.type(dialog.getByLabelText("Title"), "Sprint open");
      await userEvent.click(dialog.getByRole("checkbox", { name: /Open voting/ }));
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => {
        const create = vi.mocked(api).mock.calls.find(
          ([m, p]) => m === "POST" && String(p).endsWith("/sessions"),
        );
        expect(create?.[2]).toEqual({
          kind: "poker",
          title: "Sprint open",
          config: { deck: "fibonacci", autoReveal: false, openVoting: true },
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
          config: { deck: "fibonacci", autoReveal: true, openVoting: false },
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

  // A room's whole entry in the main column — the table card for a live
  // room, the list row otherwise — found by its title.
  function row(title: string) {
    // The sidebar lists the same sessions, so scope to the main column first.
    const main = within(screen.getByRole("main"));
    return within(main.getByText(title).closest("li")!);
  }

  it("counts the people in each session rather than calling every open one live", async () => {
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await findSessionsHeading();

    // A busy session says how many, and never the old word.
    expect(row("Sprint 12 grooming").getByText("3 here")).toBeTruthy();
    expect(row("Sprint 12 grooming").queryByText("live")).toBe(null);
    // One person is still a count, not a special case.
    expect(row("Retro of record").getByText("1 here")).toBeTruthy();
    // An open session nobody is in is quiet — no count, not "live".
    expect(row("Daily").queryByText(/here/)).toBe(null);
    expect(row("Daily").queryByText("live")).toBe(null);
    // Ended beats any count: it goes to the logbook, never to the table.
    expect(row("Pokerful planning").queryByText(/here/)).toBe(null);
    expect(row("Pokerful planning").queryByRole("link", { name: /Rejoin/ })).toBe(null);
    expect(within(screen.getByRole("main")).getByText("Pokerful planning").closest("details")).toBeTruthy();
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
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Sessions" })).toBeTruthy();

    // One flaky response — a deploy, a proxy hiccup, a single 5xx. The cached
    // space is still perfectly good, so the dead-end screen must not appear.
    failSpace = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(screen.queryByText("No table under that name")).toBe(null);
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Sessions" })).toBeTruthy();
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
// without a Route here, so the slug in the path is empty. The panels hanging
// off the page read their own sub-resources under the same prefix; those are
// not the space, so they are excluded by suffix rather than counted as one.
function spaceReads(): number {
  return vi
    .mocked(api)
    .mock.calls.filter(
      (c) =>
        c[0] === "GET" &&
        String(c[1]).startsWith("/api/orgs/acme/spaces/") &&
        !String(c[1]).endsWith("/kudos") &&
        !String(c[1]).endsWith("/decks") &&
        !String(c[1]).endsWith("/standup-trend"),
    ).length;
}

// kudosReads counts reads of the kudos panel specifically — spaceReads above
// excludes /kudos on purpose, so nothing else in this file would notice the
// wall over-polling.
function kudosReads(): number {
  return vi
    .mocked(api)
    .mock.calls.filter((c) => c[0] === "GET" && String(c[1]).endsWith("/kudos")).length;
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
    await findSessionsHeading();
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (path.endsWith("/seen") && method === "POST") return undefined;
        return view;
      }
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) {
        if (path.endsWith("/seen") && method === "POST") return undefined;
        return view;
      }
      if (path.includes("/plugins/panels")) return [];
      throw new Error(`unexpected api call: ${method} ${path}`);
    });

    const { queryClient } = renderApp(<SpacePage />, {
      route: "/o/acme/s/platform-team",
      path: "/o/:org/s/:slug",
    });
    await findSessionsHeading();
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
      if (path.endsWith("/kudos")) return [];
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
      if (path.includes("/plugins/panels")) return [];
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
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();

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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
      if (path.endsWith("/kudos")) return [];
      if (path.startsWith("/api/orgs/acme/spaces/")) return view;
      if (path.includes("/plugins/panels")) return [];
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
          config: { deck: { name: "House deck", values: ["S", "M", "L"], ordinal: true }, autoReveal: false, openVoting: false },
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

  // #444: the sample chips were fixed-width boxes on a nowrap row, so a deck
  // of long ordinal words ran together into "lowmediuhigh". At 375px — the
  // narrowest viewport this UI supports — five 8-character chips cannot sit
  // on one line, so the row has to wrap and each chip has to size to its word.
  it("renders a deck of 8-character ordinal words legibly", async () => {
    space.kinds = ["poker"];
    decks = [{ ...house, name: "Sizes", cards: ["smallest", "mediumly", "largerly"] }];
    try {
      const dialog = await openDialog();
      await dialog.findByRole("radio", { name: /Sizes/ });
      const chip = dialog.getByText("smallest");
      const classes = [...chip.classList];
      // No fixed width in any form: a chip narrower than its word clips the
      // word, whether the width is a scale step (w-5), an arbitrary value
      // (w-[999px]) or hidden behind a breakpoint (sm:w-5). This is
      // deliberately blind to which width utility is used, so it also rejects
      // content-sized ones like w-fit and w-auto. Those would be fine here;
      // swap this assertion rather than working around it.
      expect(classes.filter((c) => /(^|:)w-/.test(c))).toEqual([]);
      // The word still gets a gutter, and a one-character sample still holds
      // the 20px floor the shipped decks are drawn at. Two-character samples
      // (16, XS, XL) clear the floor at ~22.5px.
      expect(classes).toContain("px-1");
      expect(classes).toContain("min-w-5");
      // And the row wraps forwards rather than overflowing the option.
      expect([...chip.parentElement!.classList]).toContain("flex-wrap");
    } finally {
      delete space.kinds;
    }
  });

  it("is reachable via Tab, not only programmatic focus", async () => {
    space.kinds = ["poker"];
    decks = [house];
    try {
      const dialog = await openDialog();
      await dialog.findByRole("radio", { name: /House deck/ });
      dialog.getByLabelText("Title").focus();
      let active: Element | null = null;
      for (let i = 0; i < 10; i += 1) {
        await userEvent.tab();
        active = document.activeElement;
        if ((active as HTMLInputElement | null)?.type === "radio") break;
      }
      expect(active).toBe(dialog.getByRole("radio", { name: /Fibonacci/ }));
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

  it("offers the standup a mode, not a deck, and asks for no decks", async () => {
    space.kinds = ["standup"];
    try {
      const dialog = await openDialog();
      expect(dialog.queryByRole("group", { name: "Deck" })).toBe(null);
      expect(dialog.getByRole("group", { name: "Mode" })).toBeTruthy();
      expect(vi.mocked(api).mock.calls.some(([, p]) => String(p).endsWith("/decks"))).toBe(false);
    } finally {
      delete space.kinds;
    }
  });

  it("posts mode async when the standup is created async", async () => {
    space.kinds = ["standup"];
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path.endsWith("/sessions")) {
        return { id: "new-1", kind: "standup", title: "Daily", createdAt: "2026-08-18T12:00:00.000Z", endedAt: null, here: 0 };
      }
      return defaultApi(method, path, body);
    }) as typeof defaultApi);
    try {
      const dialog = await openDialog();
      await userEvent.type(dialog.getByLabelText("Title"), "Daily");
      await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => {
        const create = vi.mocked(api).mock.calls.find(([m, p]) => m === "POST" && String(p).endsWith("/sessions"));
        expect(create?.[2]).toEqual({ kind: "standup", title: "Daily", config: { mode: "async" } });
      });
    } finally {
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    }
  });

  /**
   * The cutoff is driven through the dialog the way a person fills it: by
   * keyboard, in their own local time. The expected instant is worked out by
   * hand for a pinned zone — 17:00 on 23 September in Chicago is CDT, UTC-5 —
   * rather than computed with the same Date call the dialog makes, which would
   * agree with any conversion at all.
   */
  describe("async cutoff", () => {
    const realTZ = process.env.TZ;
    // The module's own mock, captured before any test swaps it.
    const defaultApi = vi.mocked(api).getMockImplementation()!;
    let refuse = "";

    beforeEach(() => {
      process.env.TZ = "America/Chicago";
      // Pinned well before every cutoff typed in this suite (17:00-17:30
      // Chicago), so these tests don't fail once the wall clock catches up
      // to a hardcoded cutoff later the same day.
      vi.setSystemTime(new Date("2026-09-23T08:00:00.000Z")); // 03:00 Chicago
      space.kinds = ["standup"];
      refuse = "";
      const fallback = defaultApi;
      vi.mocked(api).mockImplementation((async (method: string, path: string, body?: unknown) => {
        if (method === "POST" && path === "/api/orgs/acme/spaces/platform-team/sessions") {
          if (refuse) throw new ApiError(400, refuse);
          return { id: "new-1", kind: "standup", title: "Daily", createdAt: "2026-08-18T12:00:00.000Z", endedAt: null, here: 0 };
        }
        return fallback(method, path, body);
      }) as typeof fallback);
    });

    afterEach(() => {
      process.env.TZ = realTZ;
      vi.useRealTimers();
      delete space.kinds;
      vi.mocked(api).mockImplementation(defaultApi);
    });

    const created = () =>
      vi.mocked(api).mock.calls.find(([m, p]) => m === "POST" && String(p).endsWith("/sessions"))?.[2];

    it("stores the exact instant typed, entered with the keyboard alone", async () => {
      const dialog = await openDialog();
      // The title is autofocused; nothing below touches the mouse.
      await userEvent.keyboard("Daily");
      await userEvent.tab();
      expect(document.activeElement).toBe(dialog.getByRole("radio", { name: /Live round/ }));
      expect(dialog.queryByLabelText(/Cutoff/)).toBe(null);
      await userEvent.keyboard("{ArrowRight}");
      expect((dialog.getByRole("radio", { name: /Async/ }) as HTMLInputElement).checked).toBe(true);
      await userEvent.tab();
      expect(document.activeElement).toBe(dialog.getByLabelText(/Cutoff/));
      await userEvent.keyboard("2026-09-23T17:00");
      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(created()).toEqual({
          kind: "standup",
          title: "Daily",
          config: { mode: "async", closesAt: "2026-09-23T22:00:00.000Z" },
        }),
      );
    });

    it("drops a cutoff typed before the mode went back to a live round", async () => {
      const dialog = await openDialog();
      await userEvent.type(dialog.getByLabelText("Title"), "Daily");
      await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
      await userEvent.type(dialog.getByLabelText(/Cutoff/), "2026-09-23T17:00");
      await userEvent.click(dialog.getByRole("radio", { name: /Live round/ }));
      expect(dialog.queryByLabelText(/Cutoff/)).toBe(null);
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      // The server refuses a cutoff on a live round, so it must not be sent.
      await waitFor(() =>
        expect(created()).toEqual({ kind: "standup", title: "Daily", config: { mode: "sync" } }),
      );
    });

    it("shows the server's refusal inside the dialog and keeps it open", async () => {
      refuse = "closesAt is only meaningful for an async standup";
      const dialog = await openDialog();
      await userEvent.type(dialog.getByLabelText("Title"), "Daily");
      await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
      await userEvent.type(dialog.getByLabelText(/Cutoff/), "2026-09-23T17:00");
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));
      const alert = await dialog.findByRole("alert");
      expect(alert.textContent).toContain("closesAt is only meaningful for an async standup");
      // Still open, still holding what was typed, so it can be corrected.
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect((dialog.getByLabelText(/Cutoff/) as HTMLInputElement).value).toBe("2026-09-23T17:00");
      await expectNoViolations(screen.getByRole("dialog"));
    });

    // Date.* alone is mocked here — setSystemTime without useFakeTimers, per
    // Vitest's own docs — so findByRole/userEvent keep running on the real
    // clock and only "now" as the component reads it is pinned.
    describe("with a fixed clock", () => {
      beforeEach(() => {
        vi.setSystemTime(new Date("2026-09-23T22:30:00.000Z")); // 17:30 in Chicago
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("sets the cutoff's minimum to now, in the viewer's local time", async () => {
        const dialog = await openDialog();
        await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
        expect((dialog.getByLabelText(/Cutoff/) as HTMLInputElement).min).toBe("2026-09-23T17:30");
      });

      it("refuses a cutoff already in the past and sends nothing", async () => {
        const dialog = await openDialog();
        await userEvent.type(dialog.getByLabelText("Title"), "Daily");
        await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
        await userEvent.type(dialog.getByLabelText(/Cutoff/), "2026-09-23T17:00");
        await userEvent.click(dialog.getByRole("button", { name: "Start session" }));

        const alert = await dialog.findByRole("alert");
        expect(alert.textContent).toBe("The cutoff has to be in the future.");
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(created()).toBe(undefined);
      });
    });

    /**
     * At hh:mm:20 the picker's own `min` still offers the current minute
     * (localNowMinute truncates to minute precision), so the submit check has
     * to agree with it rather than compare against the exact millisecond —
     * otherwise the option the picker hands out is refused the instant it is
     * chosen.
     */
    describe("with a clock mid-minute", () => {
      beforeEach(() => {
        vi.setSystemTime(new Date("2026-09-23T22:30:20.000Z")); // 17:30:20 in Chicago
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("accepts the current minute the picker offers and sends it", async () => {
        const dialog = await openDialog();
        await userEvent.type(dialog.getByLabelText("Title"), "Daily");
        await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
        await userEvent.type(dialog.getByLabelText(/Cutoff/), "2026-09-23T17:30");
        await userEvent.click(dialog.getByRole("button", { name: "Start session" }));

        await waitFor(() =>
          expect(created()).toEqual({
            kind: "standup",
            title: "Daily",
            config: { mode: "async", closesAt: "2026-09-23T22:30:00.000Z" },
          }),
        );
      });

      it("still refuses the minute before", async () => {
        const dialog = await openDialog();
        await userEvent.type(dialog.getByLabelText("Title"), "Daily");
        await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
        await userEvent.type(dialog.getByLabelText(/Cutoff/), "2026-09-23T17:29");
        await userEvent.click(dialog.getByRole("button", { name: "Start session" }));

        const alert = await dialog.findByRole("alert");
        expect(alert.textContent).toBe("The cutoff has to be in the future.");
        expect(created()).toBe(undefined);
      });
    });

    /**
     * noValidate turns off the browser's own validation bubble, so a
     * half-typed value ("" with validity.badInput set) must be caught by hand
     * before it is silently skipped — otherwise the standup is created with no
     * cutoff at all.
     */
    it("refuses a half-typed cutoff instead of sending nothing", async () => {
      const dialog = await openDialog();
      await userEvent.type(dialog.getByLabelText("Title"), "Daily");
      await userEvent.click(dialog.getByRole("radio", { name: /Async/ }));
      const cutoff = dialog.getByLabelText(/Cutoff/) as HTMLInputElement;
      Object.defineProperty(cutoff, "validity", {
        configurable: true,
        value: { badInput: true },
      });
      await userEvent.click(dialog.getByRole("button", { name: "Start session" }));

      const alert = await dialog.findByRole("alert");
      expect(alert.textContent).toBe("The cutoff is not a complete date and time.");
      expect(created()).toBe(undefined);
    });
  });
});


/**
 * The wall driven through the page that owns it, not through the panel in
 * isolation. Feeding a kudo straight into the component would prove it renders
 * a list; it would not prove SpacePage can ever produce one.
 */
describe("SpacePage kudos wall", () => {
  const roster = {
    ...space,
    members: [
      { userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "member" },
      { userId: "dana", name: "Dana Whitfield", avatarHue: 120, spectator: false, role: "owner" },
    ],
  } as unknown as SpaceView;

  // Earlier describes swap the api implementation in; this one wants the
  // module's own, so it puts it back rather than inheriting whatever ran last.
  const defaultApi = vi.mocked(api).getMockImplementation()!;

  afterEach(() => {
    view = space;
    vi.useRealTimers();
  });

  async function open() {
    vi.mocked(api).mockImplementation(defaultApi);
    view = roster;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    return within(await screen.findByTestId("kudos"));
  }

  it("gives a kudo from the page and shows it on the wall", async () => {
    const wall = await open();
    expect(await wall.findByTestId("kudos-empty")).toBeTruthy();

    await userEvent.click(wall.getByRole("button", { name: "Thank someone" }));
    await userEvent.selectOptions(wall.getByLabelText("To"), "dana");
    await userEvent.type(wall.getByLabelText("For what"), "Unblocked the release.");
    await userEvent.click(wall.getByRole("button", { name: "Give kudos" }));

    const row = await wall.findByTestId("kudo-k1");
    expect(row.textContent).toContain("Unblocked the release.");
    expect(row.textContent).toContain("Dana Whitfield");
    expect(wall.queryByTestId("kudos-empty")).toBe(null);
    // Announced, not merely rendered.
    // The session list keeps its own polite status region, so the toast is
    // one of two.
    await waitFor(() => expect(statusText()).toContain("Kudos sent"));
  });

  it("never offers you as a recipient", async () => {
    const wall = await open();
    await userEvent.click(await wall.findByRole("button", { name: "Thank someone" }));
    const names = within(wall.getByLabelText("To"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toContain("Dana Whitfield");
    expect(names).not.toContain("Marcus Okonjo");
  });

  it("withdraws your own kudo, in two steps", async () => {
    kudos = [
      {
        id: "k9",
        fromUserId: "marcus",
        toUserId: "dana",
        text: "Wrote the migration nobody wanted to.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    const wall = await open();
    const row = await wall.findByTestId("kudo-k9");

    await userEvent.click(within(row).getByRole("button", { name: /^Withdraw:/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Withdraw it" }));

    await waitFor(() => expect(wall.queryByTestId("kudo-k9")).toBe(null));
    expect(await wall.findByTestId("kudos-empty")).toBeTruthy();
  });

  it("renders kudos in the order the GET returns them, newest first", async () => {
    kudos = [
      {
        id: "k11",
        fromUserId: "dana",
        toUserId: "marcus",
        text: "Second kudo, given later.",
        createdAt: "2026-09-03T10:00:00.000Z",
        sessionId: "",
      },
      {
        id: "k10",
        fromUserId: "marcus",
        toUserId: "dana",
        text: "First kudo, given earlier.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    const wall = await open();
    await wall.findByTestId("kudo-k11");
    const ids = wall.getAllByTestId(/^kudo-k\d+$/).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["kudo-k11", "kudo-k10"]);
  });

  it("offers no withdraw control on somebody else's kudo", async () => {
    kudos = [
      {
        id: "k8",
        fromUserId: "dana",
        toUserId: "marcus",
        text: "Reviewed everything on a Friday.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    const wall = await open();
    const row = await wall.findByTestId("kudo-k8");
    expect(within(row).queryByRole("button", { name: /Withdraw/ })).toBe(null);
  });

  it("shows the server's error when giving a kudo is rejected", async () => {
    const wall = await open();
    // Only the kudo POST is made to fail; everything else keeps reading the
    // normal fixtures, exactly like the server's real 409 cap response.
    vi.mocked(api).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path.endsWith("/kudos")) {
        throw new ApiError(409, "This space has reached its kudos cap for today.");
      }
      return defaultApi(method, path, body);
    });

    await userEvent.click(await wall.findByRole("button", { name: "Thank someone" }));
    await userEvent.selectOptions(wall.getByLabelText("To"), "dana");
    await userEvent.type(wall.getByLabelText("For what"), "Shipped the fix.");
    await userEvent.click(wall.getByRole("button", { name: "Give kudos" }));

    await waitFor(() =>
      expect(statusText()).toContain("This space has reached its kudos cap for today."),
    );
    // The failed kudo never joined the wall.
    expect(wall.queryByTestId("kudos-empty")).toBeTruthy();
  });

  it("reads the kudos wall once per mount and does not poll it on a timer", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(defaultApi);
    view = roster;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kudosReads()).toBe(1);

    // The space itself polls every 30s (see "re-reads the space on a timer"
    // above); the kudos wall must not ride along with it.
    await vi.advanceTimersByTimeAsync(30_100);
    expect(kudosReads()).toBe(1);
  });
});

describe("SpacePage standup participation trend", () => {
  const defaultApi = vi.mocked(api).getMockImplementation()!;
  afterEach(() => {
    view = space;
  });

  async function open() {
    vi.mocked(api).mockImplementation(defaultApi);
    const r = renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    return { region: await screen.findByRole("region", { name: "Standup participation" }), ...r };
  }

  it("shows the team's weekly ratio and says plainly when a week is not shown", async () => {
    trend = {
      weeks: [
        { weekStart: "2026-09-07", suppressed: true },
        { weekStart: "2026-09-14", ratio: 0.75 },
      ],
    };
    const { region, container } = await open();
    await waitFor(() => expect(region.textContent).toContain("75%"));
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Not shown");
    expect(rows[1].textContent).toContain("75%");
    await expectNoViolations(container);
  });

  it("explains the threshold when no week can be shown", async () => {
    trend = { weeks: [{ weekStart: "2026-09-07", suppressed: true }, { weekStart: "2026-09-14", suppressed: true }] };
    const { region } = await open();
    await waitFor(() => expect(region.textContent).toMatch(/at least four people/i));
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("sets your own away days from the space page, outside any room", async () => {
    const user = userEvent.setup();
    const { region } = await open();
    const first = await within(region).findByLabelText("First day away");
    await user.click(first);
    await user.keyboard("2026-10-05");
    await user.click(within(region).getByLabelText("Last day away"));
    await user.keyboard("2026-10-09");
    await user.click(within(region).getByRole("button", { name: "Add away days" }));
    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.filter((c) => c[0] === "POST" && c[1] === "/api/me/away").map((c) => c[2]),
      ).toEqual([{ startsOn: "2026-10-05", endsOn: "2026-10-09" }]),
    );
    expect(
      await within(region).findByRole("button", { name: "Remove away days 2026-10-05 to 2026-10-09" }),
    ).toBeTruthy();
  });

  it("asks for the trend only for a space that holds standups", async () => {
    view = { ...space, sessions: (space.sessions ?? []).filter((s) => s.kind !== "standup") } as SpaceView;
    vi.mocked(api).mockImplementation(defaultApi);
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    await screen.findAllByText("Sprint 12 grooming");
    expect(screen.queryByRole("region", { name: "Standup participation" })).toBeNull();
    expect(vi.mocked(api).mock.calls.some((c) => String(c[1]).endsWith("/standup-trend"))).toBe(false);
  });
});

/**
 * Kudos and standup participation as a column beside the sessions. jsdom has
 * no layout, so the column itself cannot be seen here; what is pinned is the
 * order everything reads in, which is the same at every width, and the
 * disclosure that keeps the give form out of the way until it is wanted.
 */
describe("SpacePage kudos rail", () => {
  const roster = {
    ...space,
    members: [
      { userId: "marcus", name: "Marcus Okonjo", avatarHue: 40, spectator: false, role: "member" },
      { userId: "dana", name: "Dana Whitfield", avatarHue: 120, spectator: false, role: "owner" },
      { userId: "visitor", name: "Link Visitor", avatarHue: 200, spectator: false, guest: true },
    ],
  } as unknown as SpaceView;

  const defaultApi = vi.mocked(api).getMockImplementation()!;

  afterEach(() => {
    view = space;
  });

  async function open() {
    vi.mocked(api).mockImplementation(defaultApi);
    view = roster;
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    return within(await screen.findByTestId("kudos"));
  }

  function precedes(a: Node, b: Node) {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it("reads kudos before standup participation, and the wall before the form", async () => {
    kudos = [
      {
        id: "k1",
        fromUserId: "dana",
        toUserId: "marcus",
        text: "Untangled the flaky seat test.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    const wall = await open();
    const trendRegion = await screen.findByRole("region", { name: "Standup participation" });
    expect(precedes(screen.getByTestId("kudos"), trendRegion)).toBe(true);
    const row = await wall.findByTestId("kudo-k1");
    expect(precedes(row, wall.getByRole("button", { name: "Thank someone" }))).toBe(true);
    // Both panels speak with one heading voice.
    const kh = wall.getByRole("heading", { name: "Kudos" });
    const th = within(trendRegion).getByRole("heading", { name: "Standup participation" });
    expect(kh.className).toBe(th.className);
  });

  it("keeps the form folded until Thank someone opens it, then hands focus to To", async () => {
    const wall = await open();
    const trigger = await wall.findByRole("button", { name: "Thank someone" });
    expect(wall.queryByLabelText("To")).toBe(null);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(trigger);
    const to = wall.getByLabelText("To");
    await waitFor(() => expect(document.activeElement).toBe(to));
  });

  it("folds the form on Escape and gives focus back to Thank someone", async () => {
    const wall = await open();
    await userEvent.click(await wall.findByRole("button", { name: "Thank someone" }));
    await waitFor(() => expect(document.activeElement).toBe(wall.getByLabelText("To")));
    await userEvent.keyboard("{Escape}");
    expect(wall.queryByLabelText("To")).toBe(null);
    await waitFor(() =>
      expect(document.activeElement).toBe(wall.getByRole("button", { name: "Thank someone" })),
    );
  });

  it("folds the form on Cancel too", async () => {
    const wall = await open();
    await userEvent.click(await wall.findByRole("button", { name: "Thank someone" }));
    await userEvent.click(wall.getByRole("button", { name: "Cancel" }));
    expect(wall.queryByLabelText("To")).toBe(null);
    await waitFor(() =>
      expect(document.activeElement).toBe(wall.getByRole("button", { name: "Thank someone" })),
    );
  });

  it("thanks a member from the sidebar: the form opens with them chosen and For what focused", async () => {
    const wall = await open();
    const nav = within(screen.getByRole("navigation", { name: "Space" }));
    await userEvent.click(await nav.findByRole("button", { name: "Thank Dana Whitfield" }));
    const to = wall.getByLabelText("To") as HTMLSelectElement;
    expect(to.value).toBe("dana");
    await waitFor(() => expect(document.activeElement).toBe(wall.getByLabelText("For what")));
  });

  it("offers no Thank on your own row or on a link guest's", async () => {
    await open();
    const nav = within(screen.getByRole("navigation", { name: "Space" }));
    expect(await nav.findByRole("button", { name: "Thank Dana Whitfield" })).toBeTruthy();
    expect(nav.queryByRole("button", { name: "Thank Marcus Okonjo" })).toBe(null);
    expect(nav.queryByRole("button", { name: /Thank Link Visitor/ })).toBe(null);
  });

  it("says the wall could not be read, with a Retry, rather than claiming it is empty", async () => {
    let failing = true;
    vi.mocked(api).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (failing && method === "GET" && path.endsWith("/kudos")) throw new Error("network");
      return defaultApi(method, path, body);
    });
    view = roster;
    kudos = [
      {
        id: "k2",
        fromUserId: "dana",
        toUserId: "marcus",
        text: "Held the release together.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const wall = within(await screen.findByTestId("kudos"));
    expect(await wall.findByText(/could not read the kudos/i)).toBeTruthy();
    expect(wall.queryByTestId("kudos-empty")).toBe(null);
    failing = false;
    await userEvent.click(wall.getByRole("button", { name: "Retry" }));
    expect(await wall.findByTestId("kudo-k2")).toBeTruthy();
  });

  it("says the participation trend could not be read, with a Retry, rather than nothing to show", async () => {
    let failing = true;
    vi.mocked(api).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (failing && path.endsWith("/standup-trend")) throw new Error("network");
      return defaultApi(method, path, body);
    });
    trend = { weeks: [{ weekStart: "2026-09-14", ratio: 0.8 }] };
    renderApp(<SpacePage />, { route: "/o/acme/s/platform-team", path: "/o/:org/s/:slug" });
    const region = within(await screen.findByRole("region", { name: "Standup participation" }));
    expect(await region.findByText(/could not read the participation trend/i)).toBeTruthy();
    expect(region.queryByText(/Nothing to show yet/)).toBe(null);
    failing = false;
    await userEvent.click(region.getByRole("button", { name: "Retry" }));
    expect(await region.findByText("80%")).toBeTruthy();
  });
});
