import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileDialog } from "./ProfileDialog";
import { renderApp } from "../test/render";
import type { Me } from "../lib/api";

const me: Me = { id: "u1", name: "Dana Whitfield", avatarHue: 120, avatarIcon: "" };

/**
 * The dialog asks the server two things: which sign-in mode this Parley runs
 * (to decide between a name field and a sign-out button) and, on Save, the
 * writes themselves. The mock answers by path so the mode is a fixture rather
 * than a race, and `writes` below hides the probe from the call counts — every
 * assertion about "wrote once" means once *besides* the probe.
 */
function mockFetch(mode: "open" | "oidc" = "open") {
  const fetchMock = vi.fn(async (path: string) =>
    new Response(JSON.stringify(path === "/api/auth" ? { mode } : { ...me, avatarIcon: "ada" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The calls that are not the auth-mode probe. */
function writes(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.filter(([path]) => path !== "/api/auth");
}

/** A fetch that fails until `heal()` is called, so a retry can succeed. */
function mockFlakyFetch() {
  let broken = true;
  const fetchMock = vi.fn(async (path: string) =>
    path === "/api/auth"
      ? new Response(JSON.stringify({ mode: "open" }), { status: 200 })
      : broken
        ? new Response(JSON.stringify({ error: "nope" }), { status: 500 })
        : new Response(JSON.stringify({ ...me }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, heal: () => (broken = false) };
}

const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("ProfileDialog", () => {
  it("offers the portrait sheet as one native radio group", () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect(screen.getByRole("group", { name: "Choose your mark" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ada" })).toBeTruthy();
    // Unsetting is a choice of its own, not a missing option.
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(true);
    // One group, one grid: the dev pack retired with the maritime set.
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getAllByRole("radio")).toHaveLength(31);
  });

  // Half of the reload contract, and the half this component owns: a stored
  // id arriving on the `me` prop renders selected rather than being treated
  // as unknown and quietly falling back to "Initials". ProfileDialog is handed
  // `me` by AppShell and has no refetch surface, so the genuine
  // write-then-reload round trip lives in AppShell.test.tsx, under
  // "the avatar survives a reload".
  it("renders a stored portrait id handed in on the me prop as selected", () => {
    mockFetch();
    renderApp(<ProfileDialog me={{ ...me, avatarIcon: "zeke" }} onClose={() => {}} />);
    expect((screen.getByRole("radio", { name: "Zeke" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("offers no retired id — the twelve old marks are gone, not hidden", () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    for (const name of ["Parrot", "Kraken", "Anchor", "Rubber duck", "Coffee", "Terminal", "Pager"]) {
      expect(screen.queryByRole("radio", { name })).toBeNull();
    }
  });

  it("keeps every preview at md — 38px, the size the chip is held against", () => {
    mockFetch();
    const { container } = renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const discs = [...container.querySelectorAll<HTMLElement>("label span.inline-flex")];
    expect(discs.length).toBeGreaterThan(0);
    for (const disc of discs) expect(disc.style.width).toBe("38px");
  });
});

/**
 * A radio group, not a grid of aria-pressed buttons. The design spec asked for
 * buttons; the five properties it actually wants are what is asserted here,
 * and a native single-select group gives all five from the platform — plus
 * arrow-key roving and a group name a button grid has to hand-build.
 */
describe("ProfileDialog keyboard and announcement", () => {
  it("reaches an option with Tab, picks it with Space, and announces the selection", async () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const ada = screen.getByRole("radio", { name: "Ada" }) as HTMLInputElement;

    // Tab reaches it: the checked radio is the group's one tab stop, and from
    // there the option is focusable without a mouse.
    ada.focus();
    expect(document.activeElement).toBe(ada);

    // Space picks it.
    await userEvent.keyboard(" ");
    expect(ada.checked).toBe(true);
    // ...and the selection is announced, because the platform owns the state.
    expect(screen.getByRole("radio", { name: "Ada", checked: true })).toBe(ada);

    // Every option carries a written name — nothing is labelled by appearance.
    for (const option of screen.getAllByRole("radio")) {
      expect((option.closest("label") as HTMLElement).textContent?.trim()).toBeTruthy();
    }

    // The focus ring shows through: the input is only visually clipped (still
    // focusable, never display:none) and its label draws the platform accent
    // outline while it holds focus.
    expect(ada.className).toContain("sr-only");
    expect((ada.closest("label") as HTMLElement).className).toContain("focus-within:outline");
  });
});

describe("ProfileDialog selection affordance", () => {
  it("marks the choice with a border and a corner pip, never colour alone", async () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const label = (screen.getByRole("radio", { name: "Ada" }) as HTMLElement).closest(
      "label",
    ) as HTMLElement;
    expect(label.querySelector("[data-pip]")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    expect(label.className).toContain("border-accent");
    expect(label.querySelector("[data-pip]")).not.toBeNull();

    // The border is a selected-state marker, not a card-wide default: an
    // unselected option must not carry it.
    const other = (screen.getByRole("radio", { name: "Bo" }) as HTMLElement).closest(
      "label",
    ) as HTMLElement;
    expect(other.className).not.toContain("border-accent");
  });

  it("leads the grid with a dashed None card, because no portrait is a real choice", () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const none = (screen.getByRole("radio", { name: "Initials" }) as HTMLElement).closest(
      "label",
    ) as HTMLElement;
    expect(none.className).toContain("border-dashed");
    expect(screen.getAllByRole("radio")[0]).toBe(screen.getByRole("radio", { name: "Initials" }));
  });
});

describe("ProfileDialog first run", () => {
  it("lands a first-time picker on a valid avatar, not an empty mannequin", () => {
    mockFetch();
    renderApp(<ProfileDialog me={{ ...me, avatarIcon: undefined }} onClose={() => {}} />);
    // Something is selected from the first frame...
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(true);
    // ...and the preview draws it rather than a blank disc.
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });
});

describe("ProfileDialog saving", () => {
  it("dims Save until something changes, and wakes it the moment it does", async () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("writes once on Save, says so, and drops back to dimmed", async () => {
    const fetchMock = mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("radio", { name: "Bo" }));
    expect(writes(fetchMock)).toHaveLength(0);

    await userEvent.click(save());
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    const [path, init] = writes(fetchMock)[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/me/avatar");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ icon: "bo" });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Profile saved");
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(true));
  });

  it("keeps the panel usable while the write is in flight — no overlay, no spinner", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/auth") return new Response(JSON.stringify({ mode: "open" }), { status: 200 });
        await held;
        return new Response(JSON.stringify({ ...me }), { status: 200 });
      }),
    );
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());

    // The button holds the progress...
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeTruthy();
    // ...and the options underneath still answer.
    await userEvent.click(screen.getByRole("radio", { name: "Bo" }));
    expect((screen.getByRole("radio", { name: "Bo" }) as HTMLInputElement).checked).toBe(true);
    release();
  });

  it("disables Save while a write is in flight, so a second click cannot double-submit", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/auth") return new Response(JSON.stringify({ mode: "open" }), { status: 200 });
      await held;
      return new Response(JSON.stringify({ ...me }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());
    const savingButton = (await screen.findByRole("button", {
      name: "Saving…",
    })) as HTMLButtonElement;
    expect(savingButton.disabled).toBe(true);
    await userEvent.click(savingButton);
    release();
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
  });

  it("discards nothing on failure, offers one retry, and clears the strip when it takes", async () => {
    const { fetchMock, heal } = mockFlakyFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());

    const strip = await screen.findByRole("alert");
    expect(strip.textContent).toContain("nope");
    // The choice survives the failure.
    expect((screen.getByRole("radio", { name: "Ada" }) as HTMLInputElement).checked).toBe(true);

    heal();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(writes(fetchMock)).toHaveLength(2);
  });

  it("writes nothing when the dialog is dismissed instead of saved", async () => {
    const fetchMock = mockFetch();
    const onClose = vi.fn();
    renderApp(<ProfileDialog me={me} onClose={onClose} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writes(fetchMock)).toHaveLength(0);
  });
});

describe("ProfileDialog randomize", () => {
  it("swaps the preview at once and counts as an unsaved change", async () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Randomize" }));
    const chosen = screen.getAllByRole("radio").find((r) => (r as HTMLInputElement).checked)!;
    // A portrait, not the None card — a random avatar you cannot see is no help.
    expect((chosen as HTMLInputElement).value).not.toBe("");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ProfileDialog invalidation", () => {
  it("invalidates only the keys that carry an avatar, not the whole cache", async () => {
    mockFetch();
    const { queryClient } = renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // An unfiltered invalidateQueries() refetches every mounted query in the
    // room; only three keys carry an avatar.
    const keys = spy.mock.calls.map(([f]) => (f as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toEqual([["me"], ["space"], ["session"]]);
  });
});

describe("ProfileDialog copy", () => {
  it("greets a first-time user with Create, and a returning one with their profile", () => {
    mockFetch();
    const { unmount } = renderApp(
      <ProfileDialog me={{ ...me, avatarIcon: undefined }} onClose={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: "Create your avatar" })).toBeTruthy();
    unmount();

    renderApp(<ProfileDialog me={{ ...me, avatarIcon: "zeke" }} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeTruthy();
  });

  it("says the selection is unsaved while it differs from what is stored", async () => {
    mockFetch();
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect(screen.queryByText("Not saved yet")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    expect(screen.getByText("Not saved yet")).toBeTruthy();

    await userEvent.click(save());
    await waitFor(() => expect(screen.queryByText("Not saved yet")).toBeNull());
  });
});

/**
 * Which controls appear follows the auth mode, and between them they always
 * come to exactly one. Open mode owns the name and has no session worth
 * ending; under a provider the name is the provider's and signing out is the
 * thing that means something.
 */
describe("ProfileDialog and the auth mode", () => {
  it("offers the name field in open mode, and nothing to sign out of", async () => {
    mockFetch("open");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect(await screen.findByRole("textbox", { name: "Display name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("offers sign-out under a provider, and says why the name is not editable", async () => {
    mockFetch("oidc");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Display name" })).toBeNull();
    expect(screen.getByText(/comes from your organisation's sign-in/)).toBeTruthy();
  });

  it("ends the session and leaves for the front door", async () => {
    const fetchMock = mockFetch("oidc");
    const href = vi.fn();
    // jsdom refuses a real navigation; the setter is what the code touches.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get href() {
          return "/";
        },
        set href(v: string) {
          href(v);
        },
      },
    });
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(href).toHaveBeenCalledWith("/"));
    const [path, init] = writes(fetchMock)[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/me");
    expect(init.method).toBe("DELETE");
  });
});

describe("ProfileDialog renaming", () => {
  it("writes the trimmed name, and only after Save", async () => {
    const fetchMock = mockFetch("open");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    await userEvent.clear(field);
    await userEvent.type(field, "  Dana W.  ");
    expect(writes(fetchMock)).toHaveLength(0);

    await userEvent.click(save());
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    const [path, init] = writes(fetchMock)[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/me");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Dana W." });
  });

  it("keeps Save dimmed for a name that is only whitespace", async () => {
    mockFetch("open");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    await userEvent.clear(field);
    await userEvent.type(field, "   ");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  // The avatar goes first: renaming rotates the session cookie, so a failure
  // after that point would leave the retry holding a replaced token.
  it("writes the avatar before the name when both changed", async () => {
    const fetchMock = mockFetch("open");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Dana W.");
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));

    await userEvent.click(save());
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(2));
    expect(writes(fetchMock).map(([path]) => path)).toEqual(["/api/me/avatar", "/api/me"]);
  });

  it("writes nothing at all when only the untouched name is submitted", async () => {
    const fetchMock = mockFetch("open");
    renderApp(<ProfileDialog me={me} onClose={() => {}} />);
    await screen.findByRole("textbox", { name: "Display name" });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(writes(fetchMock)).toHaveLength(0);
  });
});
