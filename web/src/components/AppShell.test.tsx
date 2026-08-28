import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { AppShell, BuildStamp, ConnectionDot, Logo } from "./AppShell";
import { Avatar } from "./Avatar";
import { makePerson, renderApp } from "../test/render";
import { api, type Me } from "../lib/api";

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
    <AppShell orgSlug="acme" spaceSlug="platform-team" spaceName="Platform Team" me={me} {...over}>
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

  it("names each connection state in words a room understands, not wire enums", () => {
    const { rerender } = renderApp(<ConnectionDot status="live" />);
    expect(screen.getByText("live")).toBeTruthy();
    rerender(<ConnectionDot status="reconnecting" />);
    expect(screen.getByText("reconnecting")).toBeTruthy();
    rerender(<ConnectionDot status="stale" />);
    expect(screen.getByText("offline")).toBeTruthy();
    rerender(<ConnectionDot status="removed" />);
    expect(screen.getByText("no access")).toBeTruthy();
  });
});

describe("AppShell", () => {
  it("renders the space and its children", () => {
    stubAuthMode("open");
    renderShell();
    expect(screen.getByText("Platform Team")).toBeTruthy();
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
    expect(screen.getByText("offline")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connection lost");
  });

  it("treats missing presence as unknown, not as everyone being here", () => {
    // Falling back to the whole roster lit a green dot beside people who were
    // nowhere near the space.
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2) });
    for (const m of roster.slice(0, 2)) {
      expect(screen.getByRole("button", { name: m.name }).querySelector("span")!.style.opacity).toBe(
        "0.7",
      );
    }
  });

  it("lights only the members the presence feed names", () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), presence: ["dana"] });
    const opacity = (name: string) =>
      screen.getByRole("button", { name }).querySelector("span")!.style.opacity;
    expect(opacity("Dana Whitfield")).toBe("1");
    expect(opacity("Marcus Okonjo")).toBe("0.7");
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

  // Sign-out moved into the profile dialog, where the name lives too: the
  // header button was hidden below sm, so on a phone there was no way to sign
  // out at all. The mode-gated behaviour is asserted in ProfileDialog.test.
  // The header no longer asks the server anything about auth at all, which is
  // what makes the missing button a decision rather than a race with a probe.
  it("keeps sign-out out of the header, and stops probing the auth mode for it", async () => {
    const fetchMock = stubAuthMode("open");
    const { queryClient } = renderShell();
    await waitFor(() => expect(screen.getByText("table")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(queryClient.getQueryState(["auth-mode"])).toBeUndefined();
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/auth");
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

  it("names the palette it is on, and can get back to system", async () => {
    stubAuthMode("open");
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Theme: system. Switch to light." }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await userEvent.click(screen.getByRole("button", { name: "Theme: light. Switch to dark." }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "Theme: dark. Switch to system." }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("shows which palette is pinned, rather than hiding it in a shadow", () => {
    stubAuthMode("open");
    renderShell();
    expect(screen.getByText("system")).toBeTruthy();
  });
});

/** Renders as a phone: every min-width query answers no. */
function asPhone() {
  vi.stubGlobal("matchMedia", ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia);
}

function manySessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    kind: "poker",
    title: `Round ${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    endedAt: null,
  }));
}

describe("what the sidebar admits it is hiding", () => {
  it("offers the way to the rest when the list is cut", () => {
    stubAuthMode("open");
    renderShell({ sessions: manySessions(12) as never });
    const more = screen.getByRole("link", { name: "All 12 sessions" });
    expect(more.getAttribute("href")).toBe("/o/acme/s/platform-team");
  });

  it("says nothing about more sessions when the list is whole", () => {
    stubAuthMode("open");
    renderShell({ sessions: manySessions(3) as never });
    expect(screen.queryByRole("link", { name: /All \d+ sessions/ })).toBeNull();
  });

  it("makes the overflow badge open the roster it is counting", async () => {
    stubAuthMode("open");
    renderShell({ members: roster });
    await userEvent.click(screen.getByRole("button", { name: "Show all 6 members" }));
    expect(screen.getByRole("dialog", { name: "Members" })).toBeTruthy();
  });
});

describe("what the header says the screen is", () => {
  it("puts the room first when there is one, and the space under it", () => {
    stubAuthMode("open");
    renderShell({ title: "Checkout rewrite" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Checkout rewrite");
    // The space is still one click away, just no longer the loudest thing.
    expect(screen.getByRole("link", { name: "Platform Team" })).toBeTruthy();
  });

  it("falls back to the space where the page is the space itself", () => {
    stubAuthMode("open");
    renderShell();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Platform Team");
  });

  it("keeps the way home without spending the header on a wordmark", () => {
    stubAuthMode("open");
    renderShell({ title: "Checkout rewrite" });
    expect(screen.getByRole("link", { name: "Parley home" })).toBeTruthy();
    // The slug is in the address bar already; the header's tightest region
    // does not repeat it.
    expect(screen.queryByText("/o/acme/s/platform-team")).toBeNull();
  });
});

describe("the sidebar on a phone", () => {
  it("opens the space nav as a sheet, because the rail has nowhere to go", async () => {
    asPhone();
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), sessions: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    const sheet = screen.getByRole("dialog", { name: "Platform Team" });
    expect(within(sheet).getByRole("heading", { name: /Members/ })).toBeTruthy();
  });

  it("keeps the sheet shut on arrival even where the rail would start open", () => {
    asPhone();
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), sidebarDefault: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the rail, not a sheet, once there is width for it", async () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), sessions: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Space" })).toBeTruthy();
  });
});

describe("getting to the table", () => {
  it("offers a skip link that lands on the main region", async () => {
    stubAuthMode("open");
    const { container } = renderShell({ members: roster, sessions: [] });
    const skip = screen.getByRole("link", { name: "Skip to the table" });
    expect(skip.getAttribute("href")).toBe("#main");
    const main = container.querySelector("main");
    expect(main?.id).toBe("main");
    // The skip link must be the very first focusable thing on the page,
    // otherwise it saves nobody the traversal it exists to bypass.
    await userEvent.tab();
    expect(document.activeElement).toBe(skip);
  });

  it("announces a change of connection state to assistive tech", () => {
    renderApp(<ConnectionDot status="reconnecting" />);
    expect(screen.getByText("reconnecting").closest("[aria-live]")).toBeTruthy();
  });

  it("says online or offline in words, not only as a coloured dot", () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 2), presence: ["dana"] });
    const list = screen.getByRole("heading", { name: /Members/ }).parentElement!;
    expect(within(list).getByRole("button", { name: /Dana Whitfield.*online/i })).toBeTruthy();
    expect(within(list).getByRole("button", { name: /Marcus Okonjo.*offline/i })).toBeTruthy();
  });

  it("chips only the owners, so a plain member's name keeps the width", () => {
    stubAuthMode("open");
    // Every row but the name is shrink-0, so a chip on all six rows takes the
    // width out of the names — which is the one thing the roster is for.
    renderShell({
      members: [
        makePerson({ userId: "dana", name: "Dana Whitfield", role: "owner" }),
        makePerson({ userId: "marcus", name: "Marcus Okonjo", role: "member" }),
      ],
    });
    const list = screen.getByRole("heading", { name: /Members/ }).parentElement!;
    expect(within(list).getByText("Owner")).toBeTruthy();
    expect(within(list).queryByText("Member")).toBeNull();
  });

  it("says a name once, not twice, where a label already carries it", () => {
    stubAuthMode("open");
    renderShell({ members: roster.slice(0, 1) });
    // Where a visible label or an aria-label already names the person, the
    // avatar beside it is decoration — announcing it makes a reader stutter.
    expect(screen.queryAllByRole("img", { name: "Dana Whitfield" }).length).toBe(0);
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
      "https://github.com/lets-parley/parley/releases/tag/v0.3.0",
    );
  });

  it("does not double-prefix a version that already carries the v", async () => {
    stubShell("v0.3.0");
    renderShell();
    const link = await screen.findByRole("link", { name: "Parley v0.3.0 release notes" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/lets-parley/parley/releases/tag/v0.3.0",
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

describe("sidebar kind labels", () => {
  const sessions = [
    { id: "s1", kind: "poker", title: "Sprint 12", createdAt: "", endedAt: null, here: 0 },
    { id: "s2", kind: "standup", title: "Daily", createdAt: "", endedAt: null, here: 0 },
    { id: "s3", kind: "acme.retro", title: "Retro", createdAt: "", endedAt: null, here: 0 },
    { id: "s4", kind: "poker", title: "Sprint 11", createdAt: "", endedAt: "2024-01-01", here: 0 },
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

  // The chip carries a glyph for a kind that has one — and only text for one
  // that does not, so an unknown kind never borrows another kind's icon.
  it("draws a glyph for a known kind and none for an unknown one", () => {
    stubAuthMode("open");
    renderShell({ sessions });
    const known = screen.getByRole("link", { name: "Poker · Sprint 12" });
    expect(known.querySelector("svg")).not.toBe(null);
    const unknown = screen.getByRole("link", { name: "acme.retro · Retro" });
    expect(unknown.querySelector("svg")).toBe(null);
  });
});

describe("the chip you wear", () => {
  it("opens the profile dialog, and names you once while doing it", async () => {
    stubAuthMode("open");
    renderShell();
    const chip = screen.getByRole("button", { name: "Dana Whitfield — your profile" });
    await userEvent.click(chip);
    expect(await screen.findByRole("dialog", { name: "Create your avatar" })).toBeTruthy();
  });

  it("is reachable under an identity provider, where the name gate returns early", async () => {
    stubAuthMode("oidc");
    renderShell();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dana Whitfield — your profile" })).toBeTruthy(),
    );
  });

  it("hides the duplicate visible name from the accessibility tree", async () => {
    stubAuthMode("open");
    renderShell();
    const chip = screen.getByRole("button", { name: "Dana Whitfield — your profile" });
    const nameSpan = chip.querySelector("span.truncate");
    expect(nameSpan).toBeTruthy();
    expect(nameSpan?.getAttribute("aria-hidden")).not.toBeNull();
    expect(nameSpan?.textContent).toBe("Dana Whitfield");
  });
});

/**
 * The write-then-reload round trip, driven where both halves live: the `me`
 * query and the PATCH. AvatarDialog can only prove it sent the right body —
 * nothing there fails if the value stops surviving a refetch. Here the stub
 * server keeps the stored avatar, the picker's invalidation refetches `me`,
 * and the chip is asserted on what came back.
 */
describe("the avatar survives a reload", () => {
  /** A `me` query that a caller owns, exactly as the real pages do. */
  function MeHost() {
    const { data } = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("GET", "/api/me") });
    return (
      <AppShell orgSlug="acme" spaceSlug="platform-team" spaceName="Platform Team" me={data ?? null}>
        <p>table</p>
      </AppShell>
    );
  }

  /** Stores what the PATCH writes and serves it back on the next GET /api/me. */
  function stubServer(stored: { icon?: string }) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      const json = (v: unknown) =>
        ({ status: 200, ok: true, text: async () => JSON.stringify(v) }) as Response;
      if (path === "/api/me/avatar") {
        Object.assign(stored, JSON.parse(init!.body as string));
        return json({ ok: true });
      }
      if (path === "/api/me") {
        return json({ ...me, avatarIcon: stored.icon });
      }
      return json({ mode: "open" });
    });
  }

  /** What Avatar itself draws for an id — the portrait to hold the chip against. */
  function portraitFor(icon: string) {
    const { container, unmount } = renderApp(
      <Avatar name={me.name} hue={me.avatarHue} icon={icon} size="sm" decorative />,
    );
    const src = container.querySelector("img")!.getAttribute("src");
    unmount();
    return src;
  }

  async function wear(iconLabel: string) {
    const stored: { icon?: string } = {};
    stubServer(stored);
    renderApp(<MeHost />);
    const chip = await screen.findByRole("button", {
      name: "Dana Whitfield — your profile",
    });
    await userEvent.click(chip);
    await userEvent.click(await screen.findByRole("radio", { name: iconLabel }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // React re-renders the chip in place, so this node is the one the refetch
    // updates — held rather than re-queried, so a failure costs one poll, not
    // a full accessibility-tree scan per retry.
    return { stored, chip };
  }

  it("wears the chosen portrait after the refetch", async () => {
    const { stored, chip } = await wear("Ada");
    await waitFor(() => expect(stored).toEqual({ icon: "ada" }));
    const want = portraitFor("ada");
    await waitFor(() => expect(chip.querySelector("img")?.getAttribute("src")).toBe(want));
  });
});
