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

  it("writes exactly once when the dialog is dismissed", async () => {
    const fetchMock = mockFetch();
    const onClose = vi.fn();
    renderApp(<AvatarDialog me={me} onClose={onClose} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("radio", { name: "Bo" }));
    expect(fetchMock).not.toHaveBeenCalled();

    (screen.getByRole("dialog") as HTMLDialogElement).dispatchEvent(
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Flush any pending async work (a second, sequential write included)
    // before counting calls, so this cannot pass on the first of two writes.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/me/avatar");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ icon: "bo" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the choice did not change", async () => {
    const fetchMock = mockFetch();
    const onClose = vi.fn();
    renderApp(<AvatarDialog me={me} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so rather than silently keeping the old chip when the write fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
    );
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "nope");
  });
});

describe("AvatarDialog invalidation", () => {
  it("invalidates only the keys that carry an avatar, not the whole cache", async () => {
    mockFetch();
    const { queryClient } = renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await userEvent.click(screen.getByRole("radio", { name: "Ada" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // An unfiltered invalidateQueries() refetches every mounted query in the
    // room; only three keys carry an avatar.
    const keys = spy.mock.calls.map(([f]) => (f as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toEqual([["me"], ["space"], ["session"]]);
  });
});
