import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import type { Me, SpaceView } from "../lib/api";
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
const calls: Array<[string, string, unknown]> = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/api/me") return me;
      if (path === "/api/auth") return { mode: "open" };
      if (method === "GET" && path.startsWith("/api/spaces/")) return view;
      calls.push([method, path, body]);
      return undefined;
    }),
  };
});

// Both routes are mounted so the redirect and the shared cache are testable
// against the real router rather than a component rendered on its own.
const routed = (
  <Routes>
    <Route path="/s/:slug" element={<SpacePage />} />
    <Route path="/s/:slug/settings" element={<SpaceSettingsPage />} />
  </Routes>
);

beforeEach(() => {
  calls.length = 0;
  view = base;
});

afterEach(() => {
  view = base;
});

describe("SpaceSettingsPage", () => {
  it("gives the page a heading and a link back to the space", async () => {
    renderApp(routed, { route: "/s/platform-team/settings" });

    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    const back = screen.getByRole("link", { name: /Back to Platform Team/ });
    expect(back.getAttribute("href")).toBe("/s/platform-team");
  });

  it("is where the manageable roster lives, with its role controls", async () => {
    renderApp(routed, { route: "/s/platform-team/settings" });

    const main = within(await screen.findByRole("main"));
    expect(main.getByRole("heading", { name: "Members" })).toBeTruthy();
    await userEvent.click(main.getByRole("button", { name: "Make owner: Bob" }));
    expect(calls).toContainEqual([
      "POST",
      "/api/spaces/platform-team/members/bob/role",
      { role: "owner" },
    ]);
  });

  it("holds the mutating passcode controls", async () => {
    renderApp(routed, { route: "/s/platform-team/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "New passcode" }));
    expect(calls).toContainEqual(["POST", "/api/spaces/platform-team/passcode", { open: false }]);

    await userEvent.click(screen.getByRole("button", { name: "Make open" }));
    expect(calls).toContainEqual(["POST", "/api/spaces/platform-team/passcode", { open: true }]);
  });

  it("copies just the passcode from the secondary action", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderApp(routed, { route: "/s/platform-team/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Copy passcode" }));

    expect(writeText).toHaveBeenCalledWith("TEAM49");
    expect(screen.getByText("Passcode copied")).toBeTruthy();
  });

  it("renames the space and keeps the slug", async () => {
    renderApp(routed, { route: "/s/platform-team/settings" });

    const field = await screen.findByRole("textbox", { name: "Space name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Platform Guild");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(calls).toContainEqual([
      "PATCH",
      "/api/spaces/platform-team",
      { name: "Platform Guild" },
    ]);
  });

  // Nothing here is recoverable. The confirmation is the whole guard, and it
  // has to survive the move to its own page unchanged.
  it("fences delete in a danger zone and still asks for the name to be typed back", async () => {
    renderApp(routed, { route: "/s/platform-team/settings" });

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
    expect(calls).toContainEqual(["DELETE", "/api/spaces/platform-team", undefined]);
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
    renderApp(routed, { route: "/s/platform-team/settings" });

    expect(await screen.findByText(/Only an owner can manage this space/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete this space" })).toBe(null);
    expect(screen.queryByRole("button", { name: "New passcode" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Make open" })).toBe(null);
    expect(screen.queryByRole("button", { name: /Make owner/ })).toBe(null);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBe(null);
    expect(screen.queryByRole("textbox", { name: "Space name" })).toBe(null);
    // The way back is still there — a dead end would be worse than the gate.
    expect(screen.getByRole("link", { name: /Back to Platform Team/ })).toBeTruthy();
  });

  // Settings is not a way into a space: someone who has not joined belongs at
  // the gate, which is what /s/:slug renders for them.
  it("sends a non-member to the space itself", async () => {
    view = { slug: "platform-team", name: "Platform Team", protected: true } as SpaceView;
    renderApp(routed, { route: "/s/platform-team/settings" });

    expect(await screen.findByLabelText("Space passcode")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBe(null);
  });

  // One query key across both routes: arriving at settings from the space must
  // not re-read what is already in hand.
  it("shares the space query key with the space page", async () => {
    const { queryClient } = renderApp(routed, { route: "/s/platform-team/settings" });
    await screen.findByRole("heading", { name: "Settings", level: 1 });

    expect(queryClient.getQueryData(["space", "platform-team"])).toBeTruthy();
  });
});

describe("SpacePage after the split", () => {
  it("keeps a one-line invite strip and nothing that mutates", async () => {
    renderApp(routed, { route: "/s/platform-team" });

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
    const { container } = renderApp(routed, { route: "/s/platform-team" });

    const main = within(await screen.findByRole("main"));
    expect(main.getByText(/Open — anyone with the link/)).toBeTruthy();
    expect(main.getByRole("button", { name: "Copy invite" })).toBeTruthy();
    expect(container.querySelector('[data-testid="invite-strip"]')).toBeTruthy();
  });

  it("links an owner to the settings route from the sidebar", async () => {
    renderApp(routed, { route: "/s/platform-team" });

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/s/platform-team/settings");
  });

  it("offers no settings link to a plain member", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(routed, { route: "/s/platform-team" });

    await screen.findByText("Recent sessions");
    expect(screen.queryByRole("link", { name: "Settings" })).toBe(null);
  });

  // The one bit the page-section roster carried that the sidebar did not.
  it("moves the Owner/Member chip onto the sidebar roster", async () => {
    renderApp(routed, { route: "/s/platform-team" });

    const nav = within(await screen.findByRole("navigation", { name: "Space" }));
    const ada = nav.getByRole("button", { name: /Ada/ });
    expect(within(ada).getByText("Owner")).toBeTruthy();
    const bob = nav.getByRole("button", { name: /Bob/ });
    expect(within(bob).getByText("Member")).toBeTruthy();
  });
});
