import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import type { Me, SpaceView } from "../lib/api";
import { SpaceSettingsPage } from "./SpaceSettingsPage";

const me: Me = { id: "ada", name: "Ada", avatarHue: 40 };

const base = {
  slug: "platform-team",
  name: "Platform Team",
  protected: true,
  passcode: "ABC123",
  sessions: [],
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

beforeEach(() => {
  calls.length = 0;
});

describe("Space settings member management", () => {
  it("offers a plain member no management buttons at all", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(<SpaceSettingsPage />, { route: "/s/platform-team/settings" });

    // Roles are still readable — the sidebar roster names them — but nothing
    // on this page is actionable.
    expect(await screen.findByText(/Only an owner can manage this space/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make owner/ })).toBe(null);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBe(null);
  });

  it("lets an owner promote, demote and remove", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "owner" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(<SpaceSettingsPage />, { route: "/s/platform-team/settings" });

    const main = within(await screen.findByRole("main"));
    await userEvent.click(main.getByRole("button", { name: "Make member: Bob" }));
    expect(calls).toContainEqual([
      "POST",
      "/api/spaces/platform-team/members/bob/role",
      { role: "member" },
    ]);

    await userEvent.click(main.getByRole("button", { name: "Remove: Bob" }));
    expect(calls).toContainEqual(["DELETE", "/api/spaces/platform-team/members/bob", undefined]);
  });

  it("does not offer to strand the space without an owner", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "owner" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "member" },
      ],
    } as unknown as SpaceView;
    renderApp(<SpaceSettingsPage />, { route: "/s/platform-team/settings" });

    // Ada is the only owner: neither demoting nor removing her is on offer.
    const main = within(await screen.findByRole("main"));
    const demote = main.getByRole("button", { name: "Make member: Ada" });
    expect(demote.hasAttribute("disabled")).toBe(true);
    expect(main.getByRole("button", { name: "Remove: Ada" }).hasAttribute("disabled")).toBe(true);
    // Bob is a plain member, so both of his controls stay live.
    expect(main.getByRole("button", { name: "Make owner: Bob" }).hasAttribute("disabled")).toBe(false);
    expect(main.getByRole("button", { name: "Remove: Bob" }).hasAttribute("disabled")).toBe(false);

    await userEvent.click(demote);
    expect(calls.filter(([, path]) => path.includes("/members/"))).toEqual([]);
  });
});
