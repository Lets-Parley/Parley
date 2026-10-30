import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api } from "../lib/api";
import { OrgAdminPage } from "./OrgAdminPage";

/**
 * Page-level: both tables arrive from the custody API the way they really do,
 * and every request the page makes is recorded, so a screen that reached for
 * anything space-scoped fails here.
 */

let refuse: number | null;
const calls: string[] = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (refuse) throw new actual.ApiError(refuse, "forbidden");
      if (path === "/api/orgs/acme/admin/spaces")
        return [
          { id: "s1", slug: "design", name: "Design crit", ownerIds: ["u1", "u2"], visibility: "org", memberCount: 4, archivedAt: null },
          { id: "s2", slug: "old", name: "Old planning", ownerIds: ["u2"], visibility: "private", memberCount: 1, archivedAt: "2026-01-02T00:00:00Z" },
        ];
      if (path === "/api/orgs/acme/admin/members")
        return [
          { userId: "u1", name: "Dana Whitfield", role: "admin", revokedAt: null },
          { userId: "u2", name: "Marcus Okonjo", role: "member", revokedAt: "2026-03-04T00:00:00Z" },
        ];
      return undefined;
    }),
  };
});

const render = (route: string) => renderApp(<OrgAdminPage />, { route, path: "/o/:org/admin/:tab?" });

beforeEach(() => {
  refuse = null;
  calls.length = 0;
  vi.mocked(api).mockClear();
});

describe("org admin hub", () => {
  it("lists the org's spaces read-only, with owners named and no way into a space", async () => {
    const { container } = render("/o/acme/admin");
    const row = (await screen.findByText("Design crit")).closest("tr")!;
    expect(within(row).getByText("design")).toBeTruthy();
    expect(within(row).getByText("Org")).toBeTruthy();
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText("Dana Whitfield, Marcus Okonjo")).toBeTruthy();
    expect(within(container.querySelector("table")!).queryAllByRole("link")).toHaveLength(0);
    expect(within(container.querySelector("table")!).queryAllByRole("button")).toHaveLength(0);
    // Archived spaces are hidden until asked for.
    expect(screen.queryByText("Old planning")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Show"), "archived");
    expect(screen.getByText("Old planning")).toBeTruthy();
    expect(screen.queryByText("Design crit")).toBeNull();
    for (const c of calls) expect(c).toMatch(/^GET \/api\/orgs\/acme\/admin\/(spaces|members)$/);
    await expectNoViolations(container);
  });

  it("filters spaces by name", async () => {
    render("/o/acme/admin/spaces");
    await screen.findByText("Design crit");
    await userEvent.type(screen.getByLabelText("Filter by name"), "nothing");
    expect(screen.queryByText("Design crit")).toBeNull();
  });

  it("lists members with role and status", async () => {
    const { container } = render("/o/acme/admin/members");
    const row = (await screen.findByText("Marcus Okonjo")).closest("tr")!;
    expect(within(row).getByText("Member")).toBeTruthy();
    expect(within(row).getByText(/^Revoked/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plugins" }).getAttribute("href")).toBe("/o/acme/admin/plugins");
    expect(screen.getByRole("link", { name: "Members" }).getAttribute("aria-current")).toBe("page");
    await expectNoViolations(container);
  });

  it.each([403, 404])("shows a non-admin the neutral notice on %i", async (status) => {
    refuse = status;
    render("/o/acme/admin");
    expect(await screen.findByText(/You are not an administrator of acme/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
