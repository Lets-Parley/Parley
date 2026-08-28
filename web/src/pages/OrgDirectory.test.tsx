import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, ApiError, type OrgSpace, type OrgSpacePage } from "../lib/api";
import { OrgDirectory } from "./OrgDirectory";

let directory: OrgSpace[] = [];
/** How many rows the fake server puts on a page. 0 means all of them. */
let pageSize = 0;
let fails: unknown = null;
let authMode: "open" | "oidc" = "oidc";

/** The paging the server actually does: a cursor naming the last row sent. */
function serve(after: string): OrgSpacePage {
  const from = after ? directory.findIndex((sp) => sp.slug === after) + 1 : 0;
  const rest = directory.slice(from);
  if (pageSize <= 0 || rest.length <= pageSize) return { spaces: rest };
  const spaces = rest.slice(0, pageSize);
  return { spaces, next: spaces[spaces.length - 1].slug };
}

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path.startsWith("/api/orgs/acme/spaces")) {
        if (fails) throw fails;
        return serve(new URL(path, "http://x").searchParams.get("after") ?? "");
      }
      if (path === "/api/auth") return { mode: authMode };
      if (path === "/api/me") return null;
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

function space(over: Partial<OrgSpace> = {}): OrgSpace {
  return {
    slug: "platform-team",
    name: "Platform Team",
    visibility: "org",
    protected: false,
    member: false,
    ...over,
  };
}

function show() {
  return renderApp(<OrgDirectory />, { route: "/o/acme", path: "/o/:org" });
}

beforeEach(() => {
  directory = [];
  pageSize = 0;
  fails = null;
  authMode = "oidc";
  vi.mocked(api).mockClear();
  document.documentElement.removeAttribute("data-theme");
});

describe("OrgDirectory", () => {
  it("lists what the server sent, and links each space at its org-scoped URL", async () => {
    directory = [
      space(),
      space({ slug: "design", name: "Design", protected: true }),
      space({ slug: "secret", name: "Secret", visibility: "private", member: true }),
    ];
    show();

    const list = await screen.findByRole("list", { name: /spaces in acme/i });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/o/acme/s/secret",
      "/o/acme/s/platform-team",
      "/o/acme/s/design",
    ]);
  });

  it("warns that a listed space can still be locked", async () => {
    // The security statement the page has to make: org visibility governs
    // being found, never being let in. A row with no badge would read as
    // "click and you're in", which is false for a protected space.
    directory = [space({ slug: "design", name: "Design", protected: true })];
    show();

    const row = await screen.findByRole("link", { name: /design/i });
    expect(within(row).getByText(/passcode/i)).toBeTruthy();
  });

  it("says so when the org has nothing to show, rather than looking broken", async () => {
    show();
    expect(await screen.findByText(/nothing here yet/i)).toBeTruthy();
    expect(screen.queryByRole("list", { name: /spaces in acme/i })).toBeNull();
  });

  it("surfaces a refusal and offers a retry", async () => {
    fails = new ApiError(404, "no such org");
    show();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no such org");

    fails = null;
    directory = [space()];
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole("link", { name: /platform team/i })).toBeTruthy());
  });

  // The docs advertise /o/:org as the address of the directory, so a bookmark
  // or a link pasted into a channel is opened by somebody with no session at
  // all. "Unauthorized" with a Try again button is a dead end for them: the
  // button cannot conjure an identity. The rest of the app answers a 401 with
  // the gate, and so does this.
  it("sends a signed-out visitor to sign in rather than showing a raw refusal", async () => {
    fails = new ApiError(401, "unauthorized");
    show();

    const signin = await screen.findByRole("link", { name: /sign in/i });
    expect(signin.getAttribute("href")).toContain("/auth/login?next=");
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.queryByText(/unauthorized/i)).toBeNull();
  });

  it("asks an open-mode visitor for a name instead of refusing them", async () => {
    authMode = "open";
    fails = new ApiError(401, "unauthorized");
    show();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText(/your name/i)).toBeTruthy();
  });

  // The directory is bounded, so an org with more rooms than one page has to
  // offer a way to the rest of them — and it has to be one that works without
  // a mouse. A button is in the tab order and says what it does; an
  // infinite-scroll sentinel is neither.
  it("asks for the next page from a keyboard-operable control", async () => {
    directory = [
      space({ slug: "aaa", name: "Aaa" }),
      space({ slug: "bbb", name: "Bbb" }),
      space({ slug: "ccc", name: "Ccc" }),
    ];
    pageSize = 2;
    show();

    const list = await screen.findByRole("list", { name: /spaces in acme/i });
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(2));

    const more = screen.getByRole("button", { name: /show more/i });
    more.focus();
    expect(document.activeElement).toBe(more);
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(3));
    // The end of the list is the end of the control: no button left offering
    // a page that is not there.
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  // The cursor is opaque and belongs to the server. The page hands back
  // exactly what it was given, because a client that parses it is a client
  // that breaks the day the paging key changes.
  it("hands the server's cursor back untouched", async () => {
    directory = [
      space({ slug: "aaa", name: "Aaa" }),
      space({ slug: "b b/b", name: "Bbb" }),
      space({ slug: "ccc", name: "Ccc" }),
    ];
    pageSize = 1;
    show();

    await screen.findByRole("link", { name: /aaa/i });
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    await screen.findByRole("link", { name: /bbb/i });
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    await screen.findByRole("link", { name: /ccc/i });

    expect(vi.mocked(api).mock.calls.map(([, path]) => path)).toContain(
      `/api/orgs/acme/spaces?after=${encodeURIComponent("b b/b")}`,
    );
  });

  it("has no axe violations with more pages to load, in either theme", async () => {
    directory = [
      space({ slug: "aaa", name: "Aaa" }),
      space({ slug: "bbb", name: "Bbb", member: true }),
    ];
    pageSize = 1;
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = show();
      await screen.findByRole("button", { name: /show more/i });
      await expectNoViolations(container);
      unmount();
    }
  });

  it("has no axe violations on the sign-in gate, in either theme", async () => {
    fails = new ApiError(401, "unauthorized");
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = show();
      await screen.findByRole("link", { name: /sign in/i });
      await expectNoViolations(container);
      unmount();
    }
  });

  it("has no axe violations in either theme", async () => {
    directory = [
      space(),
      space({ slug: "design", name: "Design", protected: true, member: true }),
    ];
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = show();
      await screen.findByRole("list", { name: /spaces in acme/i });
      await expectNoViolations(container);
      unmount();
    }
  });
});
