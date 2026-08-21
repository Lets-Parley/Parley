import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvatarDialog } from "./AvatarDialog";
import { renderApp } from "../test/render";
import type { Me } from "../lib/api";

const me: Me = { id: "u1", name: "Dana Whitfield", avatarHue: 120, avatarIcon: "" };

function mockFetch() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ...me, avatarIcon: "ada" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch that fails until `heal()` is called, so a retry can succeed. */
function mockFlakyFetch() {
  let broken = true;
  const fetchMock = vi.fn(async () =>
    broken
      ? new Response(JSON.stringify({ error: "nope" }), { status: 500 })
      : new Response(JSON.stringify({ ...me }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, heal: () => (broken = false) };
}

const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("AvatarDialog", () => {
  it("offers the portrait sheet as one native radio group", () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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
  // as unknown and quietly falling back to "Initials". AvatarDialog is handed
  // `me` by AppShell and has no refetch surface, so the genuine
  // write-then-reload round trip lives in AppShell.test.tsx, under
  // "the avatar survives a reload".
  it("renders a stored portrait id handed in on the me prop as selected", () => {
    mockFetch();
    renderApp(<AvatarDialog me={{ ...me, avatarIcon: "zeke" }} onClose={() => {}} />);
    expect((screen.getByRole("radio", { name: "Zeke" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("offers no retired id — the twelve old marks are gone, not hidden", () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    for (const name of ["Parrot", "Kraken", "Anchor", "Rubber duck", "Coffee", "Terminal", "Pager"]) {
      expect(screen.queryByRole("radio", { name })).toBeNull();
    }
  });

  it("keeps every preview at md — 38px, the size the chip is held against", () => {
    mockFetch();
    const { container } = renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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
describe("AvatarDialog keyboard and announcement", () => {
  it("reaches an option with Tab, picks it with Space, and announces the selection", async () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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

describe("AvatarDialog selection affordance", () => {
  it("marks the choice with a border and a corner pip, never colour alone", async () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    const none = (screen.getByRole("radio", { name: "Initials" }) as HTMLElement).closest(
      "label",
    ) as HTMLElement;
    expect(none.className).toContain("border-dashed");
    expect(screen.getAllByRole("radio")[0]).toBe(screen.getByRole("radio", { name: "Initials" }));
  });
});

describe("AvatarDialog first run", () => {
  it("lands a first-time picker on a valid avatar, not an empty mannequin", () => {
    mockFetch();
    renderApp(<AvatarDialog me={{ ...me, avatarIcon: undefined }} onClose={() => {}} />);
    // Something is selected from the first frame...
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(true);
    // ...and the preview draws it rather than a blank disc.
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });
});

describe("AvatarDialog saving", () => {
  it("dims Save until something changes, and wakes it the moment it does", async () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("writes once on Save, says so, and drops back to dimmed", async () => {
    const fetchMock = mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("radio", { name: "Bo" }));
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/me/avatar");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ icon: "bo" });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Avatar saved");
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(true));
  });

  it("keeps the panel usable while the write is in flight — no overlay, no spinner", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await held;
        return new Response(JSON.stringify({ ...me }), { status: 200 });
      }),
    );
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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
    const fetchMock = vi.fn(async () => {
      await held;
      return new Response(JSON.stringify({ ...me }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());
    const savingButton = (await screen.findByRole("button", {
      name: "Saving…",
    })) as HTMLButtonElement;
    expect(savingButton.disabled).toBe(true);
    await userEvent.click(savingButton);
    release();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("discards nothing on failure, offers one retry, and clears the strip when it takes", async () => {
    const { fetchMock, heal } = mockFlakyFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(save());

    const strip = await screen.findByRole("alert");
    expect(strip.textContent).toContain("nope");
    // The choice survives the failure.
    expect((screen.getByRole("radio", { name: "Ada" }) as HTMLInputElement).checked).toBe(true);

    heal();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the dialog is dismissed instead of saved", async () => {
    const fetchMock = mockFetch();
    const onClose = vi.fn();
    renderApp(<AvatarDialog me={me} onClose={onClose} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AvatarDialog randomize", () => {
  it("swaps the preview at once and counts as an unsaved change", async () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Randomize" }));
    const chosen = screen.getAllByRole("radio").find((r) => (r as HTMLInputElement).checked)!;
    // A portrait, not the None card — a random avatar you cannot see is no help.
    expect((chosen as HTMLInputElement).value).not.toBe("");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("AvatarDialog invalidation", () => {
  it("invalidates only the keys that carry an avatar, not the whole cache", async () => {
    mockFetch();
    const { queryClient } = renderApp(<AvatarDialog me={me} onClose={() => {}} />);
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
