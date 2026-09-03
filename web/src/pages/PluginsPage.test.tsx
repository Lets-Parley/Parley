import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { DescribedGrant, PluginPreview, PluginRegistry } from "../lib/plugins";
import { PluginsPage } from "./PluginsPage";

/**
 * These are page-level: nothing is handed straight to a card. The registry and
 * the preview both arrive the way they really do — from the API — so a screen
 * that stopped asking for the preview, or stopped rendering what came back,
 * fails here rather than passing on a prop nobody could produce.
 */

const fetchGrant: DescribedGrant = {
  capability: "fetch",
  scope: "*.example.com",
  permits:
    "Can send anything it holds — including session data it has read — to any subdomain of example.com, however deep — but not example.com itself.",
  allows: ["api.example.com", "a.b.example.com"],
  refuses: ["example.com"],
};

const logGrant: DescribedGrant = {
  capability: "log",
  scope: "",
  permits: "Can write lines into this server's log, where they sit alongside Parley's own.",
};

let registry: PluginRegistry;
let preview: PluginPreview;
const calls: Array<[string, string, unknown]> = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET" && path === "/api/orgs/acme/admin/plugins") return registry;
      if (method === "POST" && path.endsWith("/preview")) return preview;
      return undefined;
    }),
  };
});

const routed = (
  <Routes>
    <Route path="/o/:org/admin/plugins" element={<PluginsPage />} />
  </Routes>
);

function render() {
  return renderApp(routed, { route: "/o/acme/admin/plugins" });
}

function packageFile(name = "reporter") {
  return new File(
    [
      JSON.stringify({
        manifest: 1,
        kind: "plugin",
        name,
        version: "1.0.0",
        capabilities: [{ capability: "fetch", scope: "*.example.com" }],
      }),
    ],
    "plugin.json",
    { type: "application/json" },
  );
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  registry = { hostRunning: true, secretsAvailable: true, installs: [] };
  preview = {
    name: "reporter",
    version: "1.0.0",
    grants: [fetchGrant],
    upgrade: false,
    added: [],
    removed: [],
    widens: true,
  };
});

describe("the consent conversation", () => {
  it("names what a capability permits in consequence and expands the wildcard in full", async () => {
    render();
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText(/plugin package file/i), packageFile());

    // The sentence, not the identifier.
    expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
    // Every wildcard, expanded — the examples the server produced from its own
    // matching, including the near-miss it refuses.
    expect(screen.getByText(/api\.example\.com, a\.b\.example\.com/)).toBeTruthy();
    expect(screen.getAllByText(/but not example\.com/).length).toBeGreaterThan(0);
  });

  it("cannot install a plugin without an explicit grant decision", async () => {
    render();
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText(/plugin package file/i), packageFile());

    const button = await screen.findByRole("button", { name: /grant and install/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(calls.some(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins")).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: /I grant it/i }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    const install = calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins");
    expect(install).toBeTruthy();
    expect((install![2] as { grantsAccepted: boolean }).grantsAccepted).toBe(true);
  });
});

describe("an upgrade asking for wider capabilities", () => {
  beforeEach(() => {
    registry = {
      hostRunning: true,
      secretsAvailable: true,
      installs: [
        {
          id: "p1",
          name: "reporter",
          version: "1.0.0",
          enabled: true,
          grants: [logGrant],
          provides: [],
          health: { state: "healthy", reason: "" },
          pending: {
            version: "2.0.0",
            grants: [logGrant, fetchGrant],
            added: [fetchGrant],
            removed: [],
          },
        },
      ],
    };
  });

  it("renders as a diff and says the plugin keeps running on the old grants", async () => {
    render();
    expect(await screen.findByText(/Version 2\.0\.0 is waiting for you/)).toBeTruthy();
    expect(screen.getByText(/It would gain:/)).toBeTruthy();
    expect(
      screen.getByText(/keeps running on 1\.0\.0 under the capabilities\s+already in force/),
    ).toBeTruthy();
  });

  it("never makes approval the default action", async () => {
    render();
    const user = userEvent.setup();
    const approve = await screen.findByRole("button", { name: /approve the upgrade/i });
    const keep = screen.getByRole("button", { name: /keep the current capabilities/i });

    // Inert until the operator says so, and never the focused control.
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).not.toBe(approve);
    // Keeping the current grants comes first in the tab order.
    expect(keep.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(approve);
    expect(calls.some(([, p]) => p === "/api/orgs/acme/admin/plugins/p1/upgrade")).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: /I grant the additional capabilities/i }));
    await user.click(approve);
    const call = calls.find(([, p]) => p === "/api/orgs/acme/admin/plugins/p1/upgrade");
    expect(call).toBeTruthy();
    expect((call![2] as { approve: boolean }).approve).toBe(true);
  });
});

describe("health", () => {
  it("says a degraded plugin is degraded, with its reason and last error", async () => {
    registry = {
      hostRunning: true,
      secretsAvailable: true,
      installs: [
        {
          id: "p1",
          name: "reporter",
          version: "1.0.0",
          enabled: true,
          grants: [logGrant],
          provides: [],
          health: {
            state: "degraded",
            reason: "it failed repeatedly, so calls to it are being refused",
            lastError: "dial tcp: connection refused",
          },
        },
      ],
    };
    render();
    const card = (await screen.findByRole("heading", { name: /reporter/i })).closest("article")!;
    expect(within(card).getByText("Degraded")).toBeTruthy();
    expect(within(card).getByText(/failed repeatedly/)).toBeTruthy();
    expect(within(card).getByText(/dial tcp: connection refused/)).toBeTruthy();
  });

  it("explains which sessions block an uninstall rather than just refusing", async () => {
    registry = {
      hostRunning: true,
      secretsAvailable: true,
      installs: [
        {
          id: "p1",
          name: "retro",
          version: "1.0.0",
          enabled: true,
          grants: [],
          provides: ["Retrospective"],
          health: { state: "healthy", reason: "" },
        },
      ],
    };
    const api = (await import("../lib/api")).api as unknown as {
      mockImplementationOnce: (f: unknown) => void;
    };
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /uninstall…/i }));
    // The irreversibility is stated before the second click, not after it.
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();

    api.mockImplementationOnce(async () => {
      throw new (await import("../lib/api")).ApiError(
        409,
        "this plugin cannot be uninstalled while sessions of the kinds it provides still exist: Retrospective (3). Delete or export those rooms first.",
      );
    });
    await user.click(screen.getByRole("button", { name: /uninstall for good/i }));
    expect(await screen.findByText(/Retrospective \(3\)/)).toBeTruthy();
  });
});

describe("themes", () => {
  const failing = {
    manifest: 1,
    kind: "theme",
    id: "murk",
    name: "Murk",
    version: "1.0.0",
    modes: {
      light: Object.fromEntries(
        [
          "felt",
          "felt-deep",
          "surface",
          "surface-hi",
          "ink",
          "ink-soft",
          "ink-faint",
          "line",
          "line-strong",
          "accent",
          "accent-ink",
          "accent-soft",
          "brass",
          "settled",
          "go",
          "stop",
        ].map((t) => [t, "#808080"]),
      ),
    },
  };

  it("refuses a pack that fails the contrast gate until it is acknowledged", async () => {
    render();
    const user = userEvent.setup();
    await user.upload(
      await screen.findByLabelText(/theme pack file/i),
      new File([JSON.stringify(failing)], "theme.json", { type: "application/json" }),
    );
    const apply = await screen.findByRole("button", { name: /apply this theme/i });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/fails the contrast gate/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("checkbox", { name: /apply it anyway/i }));
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    await user.click(apply);
    expect(localStorage.getItem("parley:theme-pack")).toContain("Murk");
    // The tier that executes nothing is still accountable to the same log.
    const audit = calls.find(([m, p]) => m === "POST" && p.endsWith("/themes"));
    expect(audit).toBeTruthy();
    expect((audit![2] as { contrastAcknowledged: boolean }).contrastAcknowledged).toBe(true);
  });

  it("offers a reset drawn in literal colours, so a hostile pack cannot hide it", async () => {
    render();
    const reset = await screen.findByRole("button", { name: /reset to the built-in palette/i });
    // Not a single themeable token: a control painted in --color-accent on
    // --color-surface is exactly what a hostile pack turns invisible.
    const style = (reset.getAttribute("style") ?? "").toLowerCase();
    expect(style).not.toContain("var(--color-");
    // Literal values, present and opaque — jsdom serialises the hex as rgb().
    expect(style).toMatch(/background:\s*rgb\(/);
    expect(style).toMatch(/color:\s*rgb\(/);
    expect(style).toMatch(/border:\s*2px solid rgb\(/);
    // And no themeable class is doing the work instead.
    expect(reset.className).toBe("");

    localStorage.setItem("parley:theme-pack", JSON.stringify(failing));
    await userEvent.setup().click(reset);
    expect(localStorage.getItem("parley:theme-pack")).toBe(null);
    expect(calls.some(([m, p]) => m === "DELETE" && p.endsWith("/themes"))).toBe(true);
  });
});

it("has no accessibility violations", async () => {
  registry = {
    hostRunning: true,
    secretsAvailable: true,
    installs: [
      {
        id: "p1",
        name: "reporter",
        version: "1.0.0",
        enabled: true,
        grants: [fetchGrant],
        provides: ["Retrospective"],
        health: { state: "disabled", reason: "an operator switched it off" },
      },
    ],
  };
  const { container } = render();
  await screen.findByRole("heading", { name: /reporter/i });
  await expectNoViolations(container);
});
