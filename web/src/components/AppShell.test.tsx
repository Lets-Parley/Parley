import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, BuildStamp, ConnectionDot, Logo } from "./AppShell";
import { makePerson, renderApp } from "../test/render";
import type { Me } from "../lib/api";
import { UNKNOWN_SWATCH } from "../lib/kinds";

const me: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 200 };

const roster = [
  makePerson({ userId: "dana", name: "Dana Whitfield" }),
  makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
  makePerson({ userId: "priya", name: "Priya Raman" }),
  makePerson({ userId: "tomas", name: "Tomas Herrera" }),
  makePerson({ userId: "nina", name: "Nina Kowalski" }),
  makePerson({ userId: "ben", name: "Ben Alvarez" }),
];

/** Answers the auth-mode probe every shell makes on mount. */
function stubAuthMode(mode: "open" | "oidc") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ mode }) }) as Response,
  );
}

function renderShell(over: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return renderApp(
    <AppShell spaceSlug="platform-team" spaceName="Platform Team" me={me} {...over}>
      <p>table</p>
    </AppShell>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Logo and ConnectionDot", () => {
  it("hides the logo from screen readers — it carries no information", () => {
    const { container } = renderApp(<Logo />);
    expect(container.querySelector("[aria-hidden]")).toBeTruthy();
  });

  it("names each connection state in words, not only in colour", () => {
    const { rerender } = renderApp(<ConnectionDot status="live" />);
    expect(screen.getByText("live")).toBeTruthy();
    rerender(<ConnectionDot status="reconnecting" />);
    expect(screen.getByText("reconnecting")).toBeTruthy();
    rerender(<ConnectionDot status="stale" />);
    expect(screen.getByText("stale")).toBeTruthy();
  });
});

describe("AppShell", () => {
  it("renders the space and its children", () => {
    stubAuthMode("open");
    renderShell();
    expect(screen.getByText("Platform Team")).toBeTruthy();
    expect(screen.getByText("/s/platform-team")).toBeTruthy();
    expect(screen.getByText("table")).toBeTruthy();
  });

  it("claims no connection state on a page that never opened a socket", () => {
    stubAuthMode("open");
    renderShell();
    for (const s of ["live", "reconnecting", "stale"]) expect(screen.queryByText(s)).toBeNull();
  });

  it("shows the dot and the banner when there is a socket to report on", () => {
    stubAuthMode("open");
    renderShell({ status: "stale" });
    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connection lost");
  });

  it("treats missing presence as unknown, not as everyone being here", () => {
    // Falling back to the whole roster lit a green dot beside people who were
    // nowhere near the space.
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2) });
    for (const m of roster.slice(0, 2)) {
      expect(screen.getByRole("button", { name: m.name }).querySelector("span")!.style.opacity).toBe(
        "0.55",
      );
    }
  });

  it("lights only the members the presence feed names", () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), presence: ["dana"] });
    const opacity = (name: string) =>
      screen.getByRole("button", { name }).querySelector("span")!.style.opacity;
    expect(opacity("Dana Whitfield")).toBe("1");
    expect(opacity("Marcus Okonjo")).toBe("0.55");
  });

  it("caps the avatar stack at five and counts the rest", () => {
    stubAuthMode("open");
    renderShell({ members: roster });
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ben Alvarez" })).toBeNull();
    expect(screen.getByRole("button", { name: "Nina Kowalski" })).toBeTruthy();
  });

  it("shows no overflow badge when everyone fits", () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 5) });
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });

  it("opens a member card from the stack and closes it again", async () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2) });
    await userEvent.click(screen.getByRole("button", { name: "Marcus Okonjo" }));
    expect(screen.getByRole("dialog", { name: "Marcus Okonjo" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no sign-out in open mode, where the identity is just a name in a cookie", async () => {
    stubAuthMode("open");
    const { queryClient } = renderShell();
    // Wait for the auth probe to actually land. Waiting for the button to be
    // absent proves nothing — it is absent before the fetch resolves too.
    await waitFor(() => expect(queryClient.getQueryData(["auth-mode"])).toEqual({ mode: "open" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("offers sign-out once identities come from a provider", async () => {
    stubAuthMode("oidc");
    renderShell();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());
  });

  it("offers nothing to sign out of when nobody is signed in", async () => {
    stubAuthMode("oidc");
    const { queryClient } = renderShell({ me: null });
    // Same trap: assert the mode resolved to oidc first, so the missing button
    // is a decision rather than a race with the fetch.
    await waitFor(() => expect(queryClient.getQueryData(["auth-mode"])).toEqual({ mode: "oidc" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("toggles the sidebar and reports its state", async () => {
    stubAuthMode("open");
    renderShell();
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts closed where the table wants the width", () => {
    stubAuthMode("open");
    renderShell({ sidebarDefault: false });
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("labels the theme toggle by what it will do", async () => {
    stubAuthMode("open");
    renderShell();
    const toggle = screen.getByRole("button", { name: "Switch to dark theme" });
    await userEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
  });
});

/** Answers both mount probes: the auth mode and the build's version. */
function stubShell(version: string | "fail") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/version") {
      if (version === "fail") throw new Error("offline");
      return { status: 200, ok: true, text: async () => JSON.stringify({ version }) } as Response;
    }
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ mode: "open" }),
    } as Response;
  });
}

describe("the build stamp", () => {
  it("links a released build to its release notes", async () => {
    stubShell("0.3.0");
    renderShell();
    const link = await screen.findByRole("link", { name: "Parley 0.3.0 release notes" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/lets-parley/parley/releases/tag/0.3.0",
    );
  });

  it("says dev for an unstamped build, and points at the releases page", async () => {
    stubShell("dev");
    renderShell();
    const link = await screen.findByRole("link", { name: "Parley dev release notes" });
    expect(link.getAttribute("href")).toBe("https://github.com/lets-parley/parley/releases");
  });

  // Asserted on the rendered output rather than on the absence of a link: a
  // guard that failed open with an error message renders no link either, so
  // querying for one passes on exactly the regression this test exists to catch.
  it("renders nothing at all when the version cannot be fetched", async () => {
    stubShell("fail");
    const { container, queryClient } = renderApp(<BuildStamp />);
    await waitFor(() => expect(queryClient.getQueryState(["version"])?.status).toBe("error"));
    expect(container.innerHTML).toBe("");
  });
});

describe("sidebar kind swatches", () => {
  const sessions = [
    { id: "s1", kind: "poker", title: "Sprint 12", createdAt: "", endedAt: null },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "", endedAt: null },
    { id: "s3", kind: "acme.retro", title: "Retro", createdAt: "", endedAt: null },
  ];

  /** The swatch is the first span inside the session link. */
  function swatchFor(title: string) {
    const link = screen.getByRole("link", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    return link.querySelector("span")!.className;
  }

  it("gives each known kind its registry swatch and an unknown kind neither", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    expect(swatchFor("Sprint 12")).toContain("bg-card-back");
    expect(swatchFor("Daily")).toContain("bg-felt-deep");
    const unknown = swatchFor("Retro");
    expect(unknown).toContain(UNKNOWN_SWATCH);
    expect(unknown).not.toContain("bg-felt-deep");
    expect(unknown).not.toContain("bg-card-back");
  });
});

describe("sidebar kind labels", () => {
  const sessions = [
    { id: "s1", kind: "poker", title: "Sprint 12", createdAt: "", endedAt: null },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "", endedAt: null },
    { id: "s3", kind: "acme.retro", title: "Retro", createdAt: "", endedAt: null },
    { id: "s4", kind: "poker", title: "Sprint 11", createdAt: "", endedAt: "2024-01-01" },
  ];

  /** The chip is an element of its own, so assert on it — not on the row's text. */
  function chipIn(accessibleName: string, label: string) {
    return within(screen.getByRole("link", { name: accessibleName })).getByText(label);
  }

  // Colour alone is not a distinction: the row carries a visible chip naming
  // its kind, in the same vocabulary the space page already uses.
  it("marks each row with a visible chip naming its kind", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    expect(chipIn("Poker · Sprint 12", "Poker").className).not.toContain("sr-only");
    expect(chipIn("Standup · Daily", "Standup")).toBeDefined();
  });

  // The kind has to reach the accessible name cleanly — separated from the
  // title, not run together with it.
  it("names the kind in the accessible name, separated from the title", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    expect(screen.getByRole("link", { name: "Poker · Sprint 12" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Standup · Daily" })).toBeDefined();
  });

  // An ended session still says so once the row names itself explicitly.
  it("keeps the ended marker in the accessible name", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    expect(screen.getByRole("link", { name: "Poker · Sprint 11 · ended" })).toBeDefined();
  });

  // An unregistered kind has no label to look up, so the wire id stands in
  // rather than the row going silent.
  it("falls back to the wire id for an unknown kind", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    expect(chipIn("acme.retro · Retro", "acme.retro")).toBeDefined();
  });
});
