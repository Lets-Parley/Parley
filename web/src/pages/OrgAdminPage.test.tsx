import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api } from "../lib/api";
import { OrgAdminPage } from "./OrgAdminPage";
import { actionText, familyOf } from "../lib/auditActions";

/**
 * Page-level: both tables arrive from the custody API the way they really do,
 * and every request the page makes is recorded, so a screen that reached for
 * anything space-scoped fails here.
 */

let refuse: number | null;
const calls: string[] = [];
const bodies: unknown[] = [];
// A mutation answer to throw, keyed "METHOD path".
let fail: Record<string, [number, string, unknown?]> = {};
// Extra member rows, and a gate holding /api/me unresolved, for one case at a time.
let extra: unknown[] = [];
let meGate: Promise<void> | null = null;
// Replaces the audit log's first page for one case.
let auditRows: unknown[] | null = null;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/api/me") await meGate;
      if (path === "/api/me") return { id: "u1", name: "Dana Whitfield", avatarHue: 1 };
      calls.push(`${method} ${path}`);
      if (method !== "GET") bodies.push(body);
      const f = fail[`${method} ${path}`];
      if (f) throw new actual.ApiError(f[0], f[1], undefined, undefined, f[2]);
      if (refuse) throw new actual.ApiError(refuse, "forbidden");
      if (path === "/api/orgs/acme/admin/spaces")
        return [
          { id: "s1", slug: "design", name: "Design crit", ownerIds: ["u1", "u2"], visibility: "org", memberCount: 4, archivedAt: null },
          { id: "s3", slug: "gone", name: "Orphaned", ownerIds: ["u9"], visibility: "private", memberCount: 2, archivedAt: null },
          { id: "s5", slug: "retro", name: "Retro", ownerIds: ["u4"], visibility: "private", memberCount: 3, archivedAt: null },
          { id: "s4", slug: "empty", name: "Empty room", ownerIds: [], visibility: "private", memberCount: 0, archivedAt: null },
          { id: "s2", slug: "old", name: "Old planning", ownerIds: ["u2"], visibility: "private", memberCount: 1, archivedAt: "2026-01-02T00:00:00Z" },
        ];
      if (path === "/api/orgs/acme/admin/members")
        return [
          { userId: "u1", name: "Dana Whitfield", role: "admin", revokedAt: null },
          { userId: "u2", name: "Marcus Okonjo", role: "member", revokedAt: "2026-03-04T00:00:00Z" },
          { userId: "u3", name: "Priya Raman", role: "member", revokedAt: null },
          { userId: "u4", name: "Leo Fischer", role: "member", revokedAt: null },
          ...extra,
        ];
      if (path === "/api/orgs/acme/admin/audit" && auditRows) return auditRows;
      if (path === "/api/orgs/acme/admin/audit")
        return [
          { id: "a1", createdAt: "2026-05-02T10:00:00Z", actorName: "Dana Whitfield", action: "space.delete", spaceSlug: "old", detail: "" },
          { id: "a2", createdAt: "2026-05-01T10:00:00Z", actorName: null, action: "plugin.install", spaceSlug: "", detail: "retro 1.0.0" },
          { id: "a3", createdAt: "2026-04-30T10:00:00Z", actorName: "Leo Fischer", action: "theme.reset", spaceSlug: "", detail: "" },
          ...Array.from({ length: 47 }, (_, i) => ({
            id: `f${i}`, createdAt: "2026-04-01T10:00:00Z", actorName: "Leo Fischer", action: "space.mystery", spaceSlug: "", detail: "",
          })),
        ];
      if (path.startsWith("/api/orgs/acme/admin/audit?before="))
        return [{ id: "z1", createdAt: "2026-03-01T10:00:00Z", actorName: "Priya Raman", action: "space.claim", spaceSlug: "empty", detail: "" }];
      return undefined;
    }),
  };
});

const render = (route: string) => renderApp(<OrgAdminPage />, { route, path: "/o/:org/admin/:tab?" });

beforeEach(() => {
  refuse = null;
  calls.length = 0;
  bodies.length = 0;
  fail = {};
  extra = [];
  meGate = null;
  auditRows = null;
  vi.mocked(api).mockClear();
});

describe("org admin hub", () => {
  it("lists the org's spaces, with owners named and no way into a space", async () => {
    const { container } = render("/o/acme/admin");
    const row = (await screen.findByText("Design crit")).closest("tr")!;
    expect(within(row).getByText("design")).toBeTruthy();
    expect(within(row).getByText("Org")).toBeTruthy();
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText("Dana Whitfield, Marcus Okonjo")).toBeTruthy();
    expect(within(container.querySelector("table")!).queryAllByRole("link")).toHaveLength(0);
    // Archived spaces are hidden until asked for.
    expect(screen.queryByText("Old planning")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Show"), "archived");
    expect(screen.getByText("Old planning")).toBeTruthy();
    expect(screen.queryByText("Design crit")).toBeNull();
    for (const c of calls) expect(c).toMatch(/^GET \/api\/orgs\/acme\/admin\/(spaces|members)$/);
    await expectNoViolations(container);
  });

  it("marks Spaces current on the bare hub route", async () => {
    render("/o/acme/admin");
    await screen.findByText("Design crit");
    expect(screen.getByRole("link", { name: "Spaces" }).getAttribute("aria-current")).toBe("page");
  });

  it("names an owner missing from the member list as Unknown", async () => {
    render("/o/acme/admin");
    const row = (await screen.findByText("Orphaned")).closest("tr")!;
    expect(within(row).getByText("Unknown")).toBeTruthy();
  });

  it("fetches nothing for an unknown tab", async () => {
    render("/o/acme/admin/bogus");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
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

  describe("audit log", () => {
    it("reads each record as a sentence, keeps the raw code, and names a departed actor plainly", async () => {
      const { container } = render("/o/acme/admin/audit");
      const row = (await screen.findByText("Deleted a space")).closest("tr")!;
      expect(within(row).getByText("space.delete")).toBeTruthy();
      expect(within(row).getByText("Dana Whitfield")).toBeTruthy();
      expect(within(row).getByText("old")).toBeTruthy();
      const plugin = screen.getByText("Installed a plugin").closest("tr")!;
      expect(within(plugin).getByText("Unknown or removed account")).toBeTruthy();
      expect(within(plugin).getByText("retro 1.0.0")).toBeTruthy();
      // An unknown code falls back to itself.
      expect(screen.getAllByText("space.mystery").length).toBeGreaterThan(0);
      expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
      for (const c of calls) expect(c).toMatch(/^GET \/api\/orgs\/acme\/admin\/(members|audit)$/);
      await expectNoViolations(container);
    });

    it("filters by family", async () => {
      render("/o/acme/admin/audit");
      await screen.findByText("Deleted a space");
      await userEvent.selectOptions(screen.getByLabelText("Show"), "plugins");
      expect(screen.getByText("Installed a plugin")).toBeTruthy();
      expect(screen.queryByText("Deleted a space")).toBeNull();
      expect(screen.getByText("Reset the theme")).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("Show"), "spaces");
      expect(screen.queryByText("Installed a plugin")).toBeNull();
      expect(screen.getByText("Deleted a space")).toBeTruthy();
    });

    it("says an empty filter covers only the records loaded so far", async () => {
      auditRows = Array.from({ length: 50 }, (_, i) => ({
        id: `p${i}`, createdAt: "2026-04-01T10:00:00Z", actorName: "Leo Fischer", action: "plugin.install", spaceSlug: "", detail: "",
      }));
      render("/o/acme/admin/audit");
      await screen.findAllByText("Installed a plugin");
      await userEvent.selectOptions(screen.getByLabelText("Show"), "spaces");
      expect(screen.getByText("No matches in the records loaded so far")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Load older" })).toBeTruthy();
    });

    it("pins the codes the server writes and their families", () => {
      // Hand-written: every code a server path writes to org_audit_log.
      expect(Object.keys(actionText).sort()).toEqual([
        "org.purge", "plugin.action", "plugin.catalog.refused", "plugin.catalog.upload", "plugin.dev_register",
        "plugin.disable", "plugin.enable", "plugin.install", "plugin.rollback", "plugin.rollback_requested",
        "plugin.settings", "plugin.uninstall", "plugin.upgrade", "plugin.upgrade_approved", "plugin.upgrade_requested",
        "space.add_owner", "space.claim", "space.delete", "theme.install", "theme.reset",
      ]);
      expect(familyOf("theme.reset")).toBe("plugins");
      expect(familyOf("plugin.install")).toBe("plugins");
      expect(familyOf("space.claim")).toBe("spaces");
      expect(familyOf("org.purge")).toBe("all");
    });

    it("loads older records from the last one shown", async () => {
      render("/o/acme/admin/audit");
      await userEvent.click(await screen.findByRole("button", { name: "Load older" }));
      expect(await screen.findByText("Claimed an abandoned space")).toBeTruthy();
      expect(calls).toContain("GET /api/orgs/acme/admin/audit?before=2026-04-01T10%3A00%3A00Z&beforeId=f46");
      // A short page is the end of the log.
      expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    });

    it("shows a non-admin the neutral notice", async () => {
      refuse = 403;
      render("/o/acme/admin/audit");
      expect(await screen.findByText(/You are not an administrator of acme/)).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
    });
  });

  describe("space panel", () => {
    const open = async (name = "Design crit") => {
      const r = render("/o/acme/admin/spaces");
      await userEvent.click(await screen.findByRole("button", { name: `Manage ${name}` }));
      return { ...r, dialog: await screen.findByRole("dialog") };
    };
    const mutations = () => calls.filter((c) => !c.startsWith("GET"));
    const spaceGets = () => calls.filter((c) => c === "GET /api/orgs/acme/admin/spaces").length;

    it("opens with only the custody actions, starting on the name field, and passes axe", async () => {
      const { container, dialog } = await open();
      const d = within(dialog);
      expect(document.activeElement).toBe(d.getByLabelText("Name"));
      expect(d.getByRole("button", { name: "Make private…" })).toBeTruthy();
      expect(d.queryByRole("button", { name: /claim/i })).toBeNull();
      expect(d.queryAllByRole("link")).toHaveLength(0);
      expect(d.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
      await expectNoViolations(container);
      for (const c of calls) expect(c).toMatch(/^GET \/api\/orgs\/acme\/admin\/(spaces|members)$/);
    });

    it("renames and refetches the spaces", async () => {
      const { dialog } = await open();
      const before = spaceGets();
      const name = within(dialog).getByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "Design review");
      await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
      await vi.waitFor(() => expect(spaceGets()).toBeGreaterThan(before));
      expect(mutations()).toEqual(["PATCH /api/orgs/acme/admin/spaces/design"]);
      expect(bodies).toEqual([{ name: "Design review" }]);
    });

    it("makes an org-visible space private only after a confirm", async () => {
      const { dialog } = await open();
      await userEvent.click(within(dialog).getByRole("button", { name: "Make private…" }));
      expect(mutations()).toEqual([]);
      await userEvent.click(within(dialog).getByRole("button", { name: "Make private" }));
      await vi.waitFor(() => expect(mutations()).toEqual(["PATCH /api/orgs/acme/admin/spaces/design"]));
      expect(bodies).toEqual([{ visibility: "private" }]);
    });

    it("never offers a visibility change on a private space", async () => {
      const { dialog } = await open("Orphaned");
      expect(within(dialog).queryByRole("button", { name: /private|visible|org/i })).toBeNull();
    });

    it("offers as owners only active members who are not the admin or an owner already", async () => {
      // Dana is the admin, Marcus is revoked, Leo already owns Retro.
      const { dialog } = await open("Retro");
      const pick = within(dialog).getByLabelText("Add owner");
      const names = within(pick).getAllByRole("option").map((o) => o.textContent);
      expect(names).toEqual(["Choose a member", "Priya Raman"]);
      await userEvent.selectOptions(pick, "u3");
      await userEvent.click(within(dialog).getByRole("button", { name: "Add owner" }));
      await vi.waitFor(() => expect(mutations()).toEqual(["POST /api/orgs/acme/admin/spaces/retro/owners"]));
      expect(bodies).toEqual([{ userId: "u3" }]);
    });

    it("claims an empty space and shows the server's refusal in its words", async () => {
      fail = { "POST /api/orgs/acme/admin/spaces/empty/claim": [409, "this space still has members — claiming is only for a space nobody is left in"] };
      const { dialog } = await open("Empty room");
      await userEvent.click(within(dialog).getByRole("button", { name: "Claim this space" }));
      expect(await within(dialog).findByText(/this space still has members/)).toBeTruthy();
    });

    it("says a vanished space is not in this org", async () => {
      fail = { "PATCH /api/orgs/acme/admin/spaces/design": [404, "no such space"] };
      const { dialog } = await open();
      await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
      expect(await within(dialog).findByText(/not in this org/)).toBeTruthy();
    });

    it("archives after a one-step confirm", async () => {
      const { dialog } = await open();
      await userEvent.click(within(dialog).getByRole("button", { name: "Archive…" }));
      expect(mutations()).toEqual([]);
      await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
      await vi.waitFor(() => expect(bodies).toEqual([{ archived: true }]));
    });

    it("unarchives an archived space", async () => {
      render("/o/acme/admin/spaces");
      await userEvent.selectOptions(await screen.findByLabelText("Show"), "archived");
      await userEvent.click(await screen.findByRole("button", { name: "Manage Old planning" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Unarchive…" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Unarchive" }));
      await vi.waitFor(() => expect(bodies).toEqual([{ archived: false }]));
    });

    it("deletes only once the exact space name is typed", async () => {
      const { dialog } = await open();
      const d = within(dialog);
      expect(d.getByText(/every session in this space and its history/i)).toBeTruthy();
      const go = d.getByRole("button", { name: "Delete this space" }) as HTMLButtonElement;
      const typed = d.getByLabelText(/Type Design crit to confirm/);
      expect(document.activeElement).not.toBe(typed);
      expect(go.disabled).toBe(true);
      await userEvent.type(typed, "design crit");
      expect(go.disabled).toBe(true);
      await userEvent.click(go);
      expect(mutations()).toEqual([]);
      await userEvent.clear(typed);
      await userEvent.type(typed, "Design crit");
      expect(go.disabled).toBe(false);
      await userEvent.click(go);
      await vi.waitFor(() => expect(mutations()).toEqual(["DELETE /api/orgs/acme/admin/spaces/design"]));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });
  describe("member panel", () => {
    const open = async (name: string) => {
      const r = render("/o/acme/admin/members");
      await userEvent.click(await screen.findByRole("button", { name: `Manage ${name}` }));
      return { ...r, dialog: await screen.findByRole("dialog") };
    };
    const mutations = () => calls.filter((c) => !c.startsWith("GET"));
    const gets = (what: string) => calls.filter((c) => c === `GET /api/orgs/acme/admin/${what}`).length;

    it("never lets the admin demote or revoke themself, and says why", async () => {
      const { container, dialog } = await open("Dana Whitfield");
      const d = within(dialog);
      expect(d.queryByRole("button", { name: /make|revoke|restore/i })).toBeNull();
      expect(d.getByText(/cannot change your own role or revoke yourself/)).toBeTruthy();
      await expectNoViolations(container);
    });

    it("promotes a member and refetches the members", async () => {
      const { container, dialog } = await open("Priya Raman");
      await expectNoViolations(container);
      expect(within(dialog).queryByRole("button", { name: "Restore" })).toBeNull();
      const before = gets("members");
      await userEvent.click(within(dialog).getByRole("button", { name: "Make admin" }));
      await vi.waitFor(() => expect(mutations()).toEqual(["POST /api/orgs/acme/admin/members/u3/role"]));
      expect(bodies).toEqual([{ role: "admin" }]);
      await vi.waitFor(() => expect(gets("members")).toBeGreaterThan(before));
    });

    it("revokes only after a confirm that is not focused, then refetches spaces too", async () => {
      const { dialog, queryClient } = await open("Priya Raman");
      const d = within(dialog);
      await userEvent.click(d.getByRole("button", { name: "Revoke…" }));
      expect(mutations()).toEqual([]);
      expect(d.getByText(/every space in this org/)).toBeTruthy();
      expect(d.getByText(/live sessions/)).toBeTruthy();
      const go = d.getByRole("button", { name: "Revoke" });
      expect(document.activeElement).toBe(d.getByRole("button", { name: "Cancel" }));
      await userEvent.click(go);
      await vi.waitFor(() => expect(mutations()).toEqual(["DELETE /api/orgs/acme/admin/members/u3"]));
      // A revoke can promote owners, so the (inactive) spaces table must refetch when next shown.
      await vi.waitFor(() =>
        expect(queryClient.getQueryState(["admin", "acme", "spaces"])?.isInvalidated).toBe(true),
      );
    });

    it("offers only Restore on a revoked member", async () => {
      const { dialog } = await open("Marcus Okonjo");
      const d = within(dialog);
      expect(d.queryByRole("button", { name: /make|revoke/i })).toBeNull();
      expect(d.getByText(/Restoring returns them as a member/)).toBeTruthy();
      await userEvent.click(d.getByRole("button", { name: "Restore" }));
      await vi.waitFor(() => expect(mutations()).toEqual(["POST /api/orgs/acme/admin/members/u2/restore"]));
    });

    it("shows the last-admin and stranded-space refusals in the server's words", async () => {
      fail = {
        "POST /api/orgs/acme/admin/members/u3/role": [409, "this org would be left with no admin — promote somebody else first"],
        "DELETE /api/orgs/acme/admin/members/u3": [
          409,
          "these spaces would be left with no owner — promote somebody else in them first",
          { spaces: ["design", "retro"] },
        ],
      };
      const { dialog } = await open("Priya Raman");
      const d = within(dialog);
      await userEvent.click(d.getByRole("button", { name: "Make admin" }));
      expect((await d.findByRole("alert")).textContent).toMatch(/left with no admin/);
      await userEvent.click(d.getByRole("button", { name: "Revoke…" }));
      await userEvent.click(d.getByRole("button", { name: "Revoke" }));
      await vi.waitFor(() => expect(d.getByRole("alert").textContent).toMatch(/spaces would be left with no owner/));
      const alert = d.getByRole("alert");
      expect(within(alert).getByText("design")).toBeTruthy();
      expect(within(alert).getByText("retro")).toBeTruthy();
      expect(alert.textContent).toMatch(/Spaces tab/);
      expect(within(dialog).queryAllByRole("link")).toHaveLength(0);
    });

    it("demotes another admin", async () => {
      extra = [{ userId: "u5", name: "Ada Kim", role: "admin", revokedAt: null }];
      const { dialog } = await open("Ada Kim");
      await userEvent.click(within(dialog).getByRole("button", { name: "Make member" }));
      await vi.waitFor(() => expect(mutations()).toEqual(["POST /api/orgs/acme/admin/members/u5/role"]));
      expect(bodies).toEqual([{ role: "member" }]);
    });

    it("offers nothing until it knows who the admin is", async () => {
      let release!: () => void;
      meGate = new Promise((r) => (release = r));
      const { dialog } = await open("Priya Raman");
      expect(within(dialog).queryByRole("button", { name: /make|revoke|restore/i })).toBeNull();
      release();
      expect(await within(dialog).findByRole("button", { name: "Make admin" })).toBeTruthy();
    });

    it("says a vanished member is not in this org", async () => {
      fail = { "POST /api/orgs/acme/admin/members/u3/role": [404, "that person is not a member of this org"] };
      const { dialog } = await open("Priya Raman");
      await userEvent.click(within(dialog).getByRole("button", { name: "Make admin" }));
      expect(await within(dialog).findByText(/not in this org any more/)).toBeTruthy();
    });
  });
});
