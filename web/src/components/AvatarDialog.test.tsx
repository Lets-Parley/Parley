import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvatarDialog } from "./AvatarDialog";
import { renderApp } from "../test/render";
import type { Me } from "../lib/api";

const me: Me = { id: "u1", name: "Dana Whitfield", avatarHue: 120, avatarIcon: "" };

function mockFetch() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ...me, avatarIcon: "anchor" }), {
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
  it("offers the crew as one native radio group", () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    expect(screen.getByRole("group", { name: "Choose your mark" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Anchor" })).toBeTruthy();
    // Unsetting is a choice of its own, not a missing option.
    expect((screen.getByRole("radio", { name: "Initials" }) as HTMLInputElement).checked).toBe(true);
  });

  it("writes exactly once when the dialog is dismissed", async () => {
    const fetchMock = mockFetch();
    const onClose = vi.fn();
    renderApp(<AvatarDialog me={me} onClose={onClose} />);
    await userEvent.click(screen.getByRole("radio", { name: "Anchor" }));
    await userEvent.click(screen.getByRole("radio", { name: "Kraken" }));
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
    expect(JSON.parse(init.body as string)).toEqual({ icon: "kraken", accessory: "" });
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
    await userEvent.click(screen.getByRole("radio", { name: "Anchor" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "nope");
  });
});

describe("AvatarDialog accessories", () => {
  it("offers the accessories as a second native radio group with its own legend", () => {
    mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    expect(screen.getByRole("group", { name: "Add an accessory" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Captain's hat" })).toBeTruthy();
    // "None" is the default, and is an option of its own rather than an absence.
    expect((screen.getByRole("radio", { name: "None" }) as HTMLInputElement).checked).toBe(true);
  });

  it("lets a chosen accessory be taken off again", async () => {
    mockFetch();
    renderApp(<AvatarDialog me={{ ...me, avatarAccessory: "captain" }} onClose={() => {}} />);
    expect((screen.getByRole("radio", { name: "Captain's hat" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("radio", { name: "None" }));
    expect((screen.getByRole("radio", { name: "None" }) as HTMLInputElement).checked).toBe(true);
  });

  it("sends the accessory along with the icon, in one write", async () => {
    const fetchMock = mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Anchor" }));
    await userEvent.click(screen.getByRole("radio", { name: "Eyepatch" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ icon: "anchor", accessory: "eyepatch" });
  });

  it("writes when only the accessory changed", async () => {
    const fetchMock = mockFetch();
    renderApp(<AvatarDialog me={me} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "Halo" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ icon: "", accessory: "halo" });
  });
});
