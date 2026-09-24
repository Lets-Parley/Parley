import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, type Deck, type Me, type SpaceView } from "../lib/api";
import { SpacePage } from "./SpacePage";
import { SpaceSettingsPage } from "./SpaceSettingsPage";

const me: Me = { id: "ada", name: "Ada", avatarHue: 40 };

const base = {
  slug: "platform-team",
  name: "Platform Team",
  protected: true,
  passcode: "TEAM49",
  sessions: [],
  members: [
    { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "owner" },
    { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "member" },
  ],
} as unknown as SpaceView;

let view: SpaceView = base;
let decks: Deck[] = [];
const calls: Array<[string, string, unknown]> = [];
let meBehavior: "ok" | "pending" | "error" = "ok";
// The space's standup schedule as the server holds it; null is "none yet".
let schedule: unknown = null;
// When set, the next schedule PUT is refused with this 400 message.
let refuseSchedule = "";
const scheduleUrl = "/api/orgs/acme/spaces/platform-team/standup-schedule";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/api/me") {
        if (meBehavior === "pending") return new Promise<never>(() => {});
        if (meBehavior === "error") throw new Error("me blew up");
        return me;
      }
      if (path === "/api/auth") return { mode: "open" };
      if (method === "GET" && path.endsWith("/decks")) return decks;
      // Answered before the catch-all below, which would otherwise hand the
      // space view back as a "schedule" and make every assertion vacuous.
      if (path === scheduleUrl) {
        if (method === "GET") return { schedule };
        calls.push([method, path, body]);
        if (refuseSchedule) throw new actual.ApiError(400, refuseSchedule);
        schedule = body;
        return { schedule: body };
      }
      // The space page's kudos wall reads a list; answering it with the space
      // view crashes the wall if the read lands before the test unmounts.
      if (method === "GET" && path.endsWith("/kudos")) return [];
      if (method === "GET" && path.startsWith("/api/orgs/acme/spaces/")) return view;
      calls.push([method, path, body]);
      return undefined;
    }),
  };
});

// Both routes are mounted so the redirect and the shared cache are testable
// against the real router rather than a component rendered on its own.
const routed = (
  <Routes>
    <Route path="/o/:org/s/:slug" element={<SpacePage />} />
    <Route path="/o/:org/s/:slug/settings" element={<SpaceSettingsPage />} />
  </Routes>
);

beforeEach(() => {
  calls.length = 0;
  view = base;
  decks = [
    { id: "d1", name: "House deck", cards: ["S", "M", "L"], ordinal: true, createdAt: "2026-08-18T10:00:00.000Z" },
  ];
  meBehavior = "ok";
  schedule = null;
  refuseSchedule = "";
});

afterEach(() => {
  view = base;
});

describe("SpaceSettingsPage", () => {
  // Visibility and the passcode are two different questions, and the panel has
  // to keep saying so: a space listed in the org directory is findable, not
  // open. A control that read as "make this space public" would be a lie about
  // what the server does.
  it("lists and unlists the space without touching the passcode", async () => {
    view = { ...base, visibility: "private" } as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const panel = (await screen.findByRole("heading", { name: /who can find it/i }))
      .closest("section") as HTMLElement;
    expect(panel.textContent).toMatch(/only a link or an invite/i);
    expect(panel.textContent).toMatch(/a space with a passcode\s+still asks for it/i);

    await userEvent.click(within(panel).getByRole("button", { name: /list in the org/i }));
    // The build stamp asks for /version on mount, which is not what this is
    // about; the writes are.
    expect(calls.filter(([method]) => method !== "GET")).toEqual([
      ["PATCH", "/api/orgs/acme/spaces/platform-team/visibility", { visibility: "org" }],
    ]);
  });

  it("offers the way back out once a space is listed", async () => {
    view = { ...base, visibility: "org" } as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const panel = (await screen.findByRole("heading", { name: /who can find it/i }))
      .closest("section") as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: /unlist from the org/i }));
    expect(calls.filter(([method]) => method !== "GET")).toEqual([
      ["PATCH", "/api/orgs/acme/spaces/platform-team/visibility", { visibility: "private" }],
    ]);
  });

  it("gives the page a heading and a link back to the space", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    const back = screen.getByRole("link", { name: /Back to Platform Team/ });
    expect(back.getAttribute("href")).toBe("/o/acme/s/platform-team");
  });

  // An owner must never see the lockout note just because /api/me is still
  // in flight -- canManage has to wait on identity the same way it waits on
  // the space, or a slow me request reads as a false "you can't manage this".
  it("does not lock out an owner while identity is still loading", async () => {
    meBehavior = "pending";
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    // Give the space query a real chance to settle -- with the bug, that is
    // enough for canManage to be computed against a still-pending me and show
    // the lockout even though me will eventually say this visitor is the owner.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText(/Only an owner can manage this space/)).toBe(null);
    expect(screen.getByText("Finding the table\u2026")).toBeTruthy();
  });

  // When identity flatly fails to load (not just slow), the safest default is
  // the same lockout a genuine non-owner sees, not a spinner that never ends.
  it("locks out the page rather than spinning forever when identity fails to load", async () => {
    meBehavior = "error";
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    expect(
      await screen.findByText(/Only an owner can manage this space/),
    ).toBeTruthy();
  });

  it("is where the manageable roster lives, with its role controls", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const main = within(await screen.findByRole("main"));
    expect(main.getByRole("heading", { name: "Members" })).toBeTruthy();
    await userEvent.click(main.getByRole("button", { name: "Make owner: Bob" }));
    expect(calls).toContainEqual([
      "POST",
      "/api/orgs/acme/spaces/platform-team/members/bob/role",
      { role: "owner" },
    ]);
  });

  it("holds the mutating passcode controls", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "New passcode" }));
    expect(calls).toContainEqual(["POST", "/api/orgs/acme/spaces/platform-team/passcode", { open: false }]);

    await userEvent.click(screen.getByRole("button", { name: "Make open" }));
    expect(calls).toContainEqual(["POST", "/api/orgs/acme/spaces/platform-team/passcode", { open: true }]);
  });

  it("copies just the passcode from the secondary action", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy passcode" }));

    expect(writeText).toHaveBeenCalledWith("TEAM49");
    expect(screen.getByText("Passcode copied")).toBeTruthy();
  });

  it("renames the space and keeps the slug", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const field = await screen.findByRole("textbox", { name: "Space name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Platform Guild");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(calls).toContainEqual([
      "PATCH",
      "/api/orgs/acme/spaces/platform-team",
      { name: "Platform Guild" },
    ]);
  });

  // The toast names a URL as prose rather than as a link, so nothing else
  // would catch it going stale — and the sentence's whole claim is that the
  // address it names still works.
  it("names an address that still resolves in the rename toast", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const field = await screen.findByRole("textbox", { name: "Space name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Platform Guild");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(
      await screen.findByText("Renamed — the link /o/acme/s/platform-team still works"),
    ).toBeTruthy();
  });

  // Nothing here is recoverable. The confirmation is the whole guard, and it
  // has to survive the move to its own page unchanged.
  it("fences delete in a danger zone and still asks for the name to be typed back", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    const danger = (await screen.findByRole("heading", { name: "Danger zone" })).closest("section")!;
    await userEvent.click(within(danger).getByRole("button", { name: "Delete this space" }));

    const go = within(danger).getByRole("button", { name: "Delete this space" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    const confirm = within(danger).getByRole("textbox", { name: "Type Platform Team to confirm" });
    await userEvent.type(confirm, "Platform Tea");
    expect(
      (within(danger).getByRole("button", { name: "Delete this space" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await userEvent.type(confirm, "m");
    await userEvent.click(within(danger).getByRole("button", { name: "Delete this space" }));
    expect(calls).toContainEqual(["DELETE", "/api/orgs/acme/spaces/platform-team", undefined]);
  });

  // Hiding a control is a courtesy the server repeats, but a non-owner who
  // types the URL must not be handed the owner surface at all.
  it("shows a non-owner nothing it could act on", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    expect(await screen.findByText(/Only an owner can manage this space/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete this space" })).toBe(null);
    expect(screen.queryByRole("button", { name: "New passcode" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Make open" })).toBe(null);
    expect(screen.queryByRole("button", { name: /Make owner/ })).toBe(null);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBe(null);
    expect(screen.queryByRole("textbox", { name: "Space name" })).toBe(null);
    // The way back is still there — a dead end would be worse than the gate.
    expect(screen.getByRole("link", { name: /Back to Platform Team/ })).toBeTruthy();
    // The decks are reference, not control: a member picks one when they start
    // a session, so they get to see what is on offer without being able to
    // change it.
    expect(await screen.findByText("House deck")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New deck" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Edit: House deck" })).toBe(null);
  });

  it("gives an owner the deck controls", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    expect(await screen.findByRole("heading", { name: "Decks" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New deck" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Edit: House deck" })).toBeTruthy();
  });

  // Settings is not a way into a space: someone who has not joined belongs at
  // the gate, which is what /s/:slug renders for them.
  it("sends a non-member to the space itself", async () => {
    view = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBe(null);
  });

  // One query key across both routes: arriving at settings from the space must
  // not re-read what is already in hand.
  it("shares the space query key with the space page", async () => {
    const { queryClient } = renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    await screen.findByRole("heading", { name: "Settings", level: 1 });

    expect(queryClient.getQueryData(["space", "acme", "platform-team"])).toBeTruthy();
  });

  // The settings panel is a screen a space owner is sent to from the sidebar,
  // so it gets the same axe pass as the directory and the landing page. The
  // role queries above already catch a control that stops being a button at
  // all; what they cannot see is a control that still answers to its role but
  // has lost its accessible name, an image with no alt text, a skipped heading
  // level, or aria pointing at nothing. Contrast is not covered — jsdom has no
  // layout — so that stays a review item.
  it("has no axe violations in either theme", async () => {
    view = { ...base, visibility: "private" } as SpaceView;
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = renderApp(routed, {
        route: "/o/acme/s/platform-team/settings",
      });
      await screen.findByRole("heading", { name: /who can find it/i });
      await screen.findByText("House deck");
      await expectNoViolations(container);
      unmount();
    }
  });
});

describe("SpacePage after the split", () => {
  it("keeps a one-line invite strip and nothing that mutates", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    const main = within(await screen.findByRole("main"));
    // The passcode is still readable, and the invite still copyable.
    expect(main.getByText("TEAM49")).toBeTruthy();
    expect(main.getByRole("button", { name: "Copy invite" })).toBeTruthy();
    // Nothing here may rotate the code out from under the people holding it.
    expect(main.queryByRole("button", { name: "New passcode" })).toBe(null);
    expect(main.queryByRole("button", { name: "Make open" })).toBe(null);
    expect(main.queryByRole("button", { name: "Protect space" })).toBe(null);
    // The page-section roster is gone; the sidebar already lists everyone.
    expect(main.queryByRole("heading", { name: "Members" })).toBe(null);
    expect(main.queryByRole("textbox", { name: "Space name" })).toBe(null);
    expect(main.queryByRole("button", { name: "Delete this space" })).toBe(null);
  });

  it("collapses the strip to one line for an open space, never an empty panel", async () => {
    view = { ...base, protected: false, passcode: undefined } as SpaceView;
    const { container } = renderApp(routed, { route: "/o/acme/s/platform-team" });

    const main = within(await screen.findByRole("main"));
    expect(main.getByText(/Open — anyone with the link/)).toBeTruthy();
    expect(main.getByRole("button", { name: "Copy invite" })).toBeTruthy();
    expect(container.querySelector('[data-testid="invite-strip"]')).toBeTruthy();
  });

  it("links an owner to the settings route from the sidebar", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/o/acme/s/platform-team/settings");
  });

  it("offers no settings link to a plain member", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    await within(await screen.findByRole("main")).findByRole("heading", { name: "Sessions" });
    expect(screen.queryByRole("link", { name: "Settings" })).toBe(null);
  });

  // The one bit the page-section roster carried that the sidebar did not.
  // Only the owner is chipped: the row's other spans are all shrink-0, so a
  // chip on every row is paid for out of the names, and "Member" is what
  // appearing in this roster already means.
  it("moves the Owner chip onto the sidebar roster", async () => {
    renderApp(routed, { route: "/o/acme/s/platform-team" });

    const nav = within(await screen.findByRole("navigation", { name: "Space" }));
    const ada = nav.getByRole("button", { name: /^Ada/ });
    expect(within(ada).getByText("Owner")).toBeTruthy();
    const bob = nav.getByRole("button", { name: /^Bob/ });
    expect(within(bob).queryByText("Member")).toBe(null);
  });
});

describe("SpaceSettingsPage standup schedule", () => {
  const saved = {
    weekdays: [1, 3, 5],
    openTime: "09:30",
    timezone: "Europe/Berlin",
    windowMinutes: 120,
    enabled: true,
  };
  const asMember = {
    ...base,
    members: [
      { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
      { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
    ],
  } as unknown as SpaceView;

  async function panel() {
    const heading = await screen.findByRole("heading", { name: "Standup schedule" });
    return within(heading.closest("section")!);
  }
  const puts = () => calls.filter(([m, p]) => m === "PUT" && p === scheduleUrl);
  const checkbox = (p: Awaited<ReturnType<typeof panel>>, name: string) =>
    p.getByRole("checkbox", { name }) as HTMLInputElement;

  it("round-trips every field for an owner", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();

    // What was saved is what the form opens with.
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));
    expect(checkbox(p, "Tue").checked).toBe(false);
    expect(checkbox(p, "Wed").checked).toBe(true);
    expect(checkbox(p, "Fri").checked).toBe(true);
    expect(checkbox(p, "Sun").checked).toBe(false);
    expect((p.getByLabelText("Opens at") as HTMLInputElement).value).toBe("09:30");
    expect((p.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Europe/Berlin");
    expect((p.getByLabelText("Window (minutes)") as HTMLInputElement).value).toBe("120");
    expect(checkbox(p, "Open standups on this schedule").checked).toBe(true);

    await userEvent.click(checkbox(p, "Wed"));
    await userEvent.click(checkbox(p, "Tue"));
    await userEvent.click(checkbox(p, "Sun"));
    const time = p.getByLabelText("Opens at");
    await userEvent.clear(time);
    await userEvent.type(time, "10:15");
    const zone = p.getByLabelText("Time zone");
    await userEvent.clear(zone);
    await userEvent.type(zone, "America/Chicago");
    const windowField = p.getByLabelText("Window (minutes)");
    await userEvent.clear(windowField);
    await userEvent.type(windowField, "90");
    await userEvent.click(checkbox(p, "Open standups on this schedule"));
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(puts()).toEqual([
        [
          "PUT",
          scheduleUrl,
          { weekdays: [0, 1, 2, 5], openTime: "10:15", timezone: "America/Chicago", windowMinutes: 90, enabled: false },
        ],
      ]),
    );
  });

  it("normalises a time the browser reports with seconds to HH:MM", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();

    await waitFor(() => expect((p.getByLabelText("Opens at") as HTMLInputElement).value).toBe("09:30"));
    const time = p.getByLabelText("Opens at");
    fireEvent.change(time, { target: { value: "09:30:00" } });
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(puts()).toEqual([
        [
          "PUT",
          scheduleUrl,
          { weekdays: [1, 3, 5], openTime: "09:30", timezone: "Europe/Berlin", windowMinutes: 120, enabled: true },
        ],
      ]),
    );
  });

  it("starts a new schedule in the browser's own time zone", async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: "Asia/Kolkata" };
    });
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();

    await waitFor(() => expect((p.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Asia/Kolkata"));
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));
    await waitFor(() =>
      expect(puts()).toEqual([
        [
          "PUT",
          scheduleUrl,
          { weekdays: [1, 2, 3, 4, 5], openTime: "09:00", timezone: "Asia/Kolkata", windowMinutes: 240, enabled: true },
        ],
      ]),
    );
  });

  // Go and Postgres carry separate zone databases, so a zone the browser
  // offers can still be one the server refuses. Its words are what is shown.
  it("shows the server's refusal inline", async () => {
    schedule = saved;
    refuseSchedule = "timezone must be an IANA name such as America/New_York";
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));

    const alert = await p.findByRole("alert");
    expect(alert.textContent).toContain("timezone must be an IANA name such as America/New_York");
    // Nothing typed is thrown away by the refusal.
    expect((p.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Europe/Berlin");
  });

  // The server's own message for this refusal is "windowMinutes must be
  // between 1 and 1440"; the client check reads the same way rather than
  // parroting it, since the field is never sent as JSON here.
  it("refuses a fractional window and sends nothing", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));

    const windowField = p.getByLabelText("Window (minutes)");
    await userEvent.clear(windowField);
    await userEvent.type(windowField, "90.5");
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));

    const alert = await p.findByRole("alert");
    expect(alert.textContent).toBe("The window has to be a whole number of minutes from 1 to 1440.");
    expect(puts()).toEqual([]);
  });

  it("refuses a window outside 1-1440 and sends nothing", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));

    const windowField = p.getByLabelText("Window (minutes)");
    await userEvent.clear(windowField);
    await userEvent.type(windowField, "1441");
    await userEvent.click(p.getByRole("button", { name: "Save schedule" }));

    const alert = await p.findByRole("alert");
    expect(alert.textContent).toBe("The window has to be a whole number of minutes from 1 to 1440.");
    expect(puts()).toEqual([]);
  });

  it("has min, max and step set on the window field", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));
    const windowField = p.getByLabelText("Window (minutes)") as HTMLInputElement;
    expect(windowField.min).toBe("1");
    expect(windowField.max).toBe("1440");
    expect(windowField.step).toBe("1");
  });

  it("is operable from the keyboard alone", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    await waitFor(() => expect(checkbox(p, "Mon").checked).toBe(true));

    const tue = checkbox(p, "Tue");
    for (let i = 0; i < 60 && document.activeElement !== tue; i += 1) await userEvent.tab();
    expect(document.activeElement).toBe(tue);
    await userEvent.keyboard(" ");
    const save = p.getByRole("button", { name: "Save schedule" });
    for (let i = 0; i < 20 && document.activeElement !== save; i += 1) await userEvent.tab();
    expect(document.activeElement).toBe(save);
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0][2] as { weekdays: number[] }).weekdays).toEqual([1, 2, 3, 5]);
  });

  // A member sees when the standup opens; changing it is an owner's. The
  // server refuses a member's PUT with 403 as well
  // (TestOnlyTheSpaceOwnerEditsTheStandupSchedule), so this is the courtesy.
  it("shows a member the schedule and no control to change it", async () => {
    schedule = saved;
    view = asMember;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();

    expect(await p.findByText("Mon, Wed, Fri")).toBeTruthy();
    expect(p.getByText(/09:30/)).toBeTruthy();
    expect(p.getByText(/Europe\/Berlin/)).toBeTruthy();
    expect(p.getByText(/120 minutes/)).toBeTruthy();
    expect(p.queryByRole("button", { name: "Save schedule" })).toBe(null);
    expect(p.queryAllByRole("checkbox")).toEqual([]);
    expect(p.queryAllByRole("combobox")).toEqual([]);
    expect(puts()).toEqual([]);
  });

  it("tells a member when there is no schedule yet", async () => {
    view = asMember;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    expect(await p.findByText(/No schedule/)).toBeTruthy();
  });

  // A link guest is no member of the space: the settings route sends them to
  // the gate, and the schedule is never asked for on their behalf.
  it("never asks for the schedule for someone outside the space", async () => {
    vi.mocked(api).mockClear();
    view = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Standup schedule" })).toBe(null);
    expect(vi.mocked(api).mock.calls.some(([, path]) => path === scheduleUrl)).toBe(false);
  });

  it("has no axe violations for an owner or a member", async () => {
    schedule = saved;
    for (const who of [base, asMember]) {
      view = who;
      const { unmount } = renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
      const p = await panel();
      await waitFor(() => expect(p.queryByText("Checking the calendar…")).toBe(null));
      await expectNoViolations((await screen.findByRole("heading", { name: "Standup schedule" })).closest("section")!);
      unmount();
    }
  });

  // The fallback behaviour of supportedZones() itself — including a browser
  // that lacks Intl.supportedValuesOf entirely — is unit-tested directly in
  // StandupSchedulePanel.test.ts, since ZONES is computed once at module
  // import and stubbing the API inside a test body here runs too late to
  // exercise it. This just confirms the input renders and is editable.
  it("renders an editable time zone input for an owner", async () => {
    schedule = saved;
    renderApp(routed, { route: "/o/acme/s/platform-team/settings" });
    const p = await panel();
    const zone = (await p.findByLabelText("Time zone")) as HTMLInputElement;
    expect(zone.value).toBe("Europe/Berlin");
    await userEvent.clear(zone);
    await userEvent.type(zone, "America/Chicago");
    expect(zone.value).toBe("America/Chicago");
  });
});
