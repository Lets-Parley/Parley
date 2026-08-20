import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import type { Me, SpaceView } from "../lib/api";
import { SpacePage } from "./SpacePage";

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

describe("SpacePage member management", () => {
  it("shows roles to everyone but offers controls only to an owner", async () => {
    view = {
      ...base,
      members: [
        { userId: "ada", name: "Ada", avatarHue: 1, spectator: false, role: "member" },
        { userId: "bob", name: "Bob", avatarHue: 2, spectator: false, role: "owner" },
      ],
    } as unknown as SpaceView;
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    expect(await screen.findByText("Owner")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
    // A plain member gets no management buttons at all.
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
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    await userEvent.click(await screen.findByRole("button", { name: "Make member: Bob" }));
    expect(calls).toContainEqual([
      "POST",
      "/api/spaces/platform-team/members/bob/role",
      { role: "member" },
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Remove: Bob" }));
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
    renderApp(<SpacePage />, { route: "/s/platform-team" });

    // Ada is the only owner: neither demoting nor removing her is on offer.
    const demote = await screen.findByRole("button", { name: "Make member: Ada" });
    expect(demote.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Remove: Ada" }).hasAttribute("disabled")).toBe(true);
    // Bob is a plain member, so both of his controls stay live.
    expect(screen.getByRole("button", { name: "Make owner: Bob" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Remove: Bob" }).hasAttribute("disabled")).toBe(false);

    await userEvent.click(demote);
    expect(calls.filter(([, path]) => path.includes("/members/"))).toEqual([]);
  });
});
