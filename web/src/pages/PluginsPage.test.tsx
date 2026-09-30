import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { Catalog, DescribedGrant, PluginPreview, PluginRegistry, PluginSettings } from "../lib/plugins";
import { ApiError } from "../lib/api";
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
let catalog: Catalog;
let settingsReply: (method: string, body: unknown) => unknown;
const calls: Array<[string, string, unknown]> = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET" && path === "/api/orgs/acme/admin/plugins") return registry;
      if (method === "POST" && path.endsWith("/preview")) return preview;
      if (method === "GET" && path === "/api/catalog") return catalog;
      if (path.endsWith("/settings")) return settingsReply(method, body);
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


beforeEach(() => {
  calls.length = 0;
  settingsReply = () => undefined;
  localStorage.clear();
  registry = { hostRunning: true, secretsAvailable: true, installs: [] };
  catalog = {
    can_upload: false,
    plugins: [{ name: "reporter", versions: [{ version: "1.0.0", digest: "d1", key_id: "k1", grants: [fetchGrant] }] }],
  };
  preview = {
    name: "reporter",
    version: "1.0.0",
    grants: [fetchGrant],
    upgrade: false,
    added: [],
    removed: [],
    widens: true,
    kinds: [],
  };
});

describe("the consent conversation", () => {
  it("names what a capability permits in consequence and expands the wildcard in full", async () => {
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));

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
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));

    const button = await screen.findByRole("button", { name: "Install reporter 1.0.0" });
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

  it("names the session kinds a package declares even when it asks for no capabilities", async () => {
    preview = {
      name: "retro",
      version: "1.0.0",
      grants: [],
      upgrade: false,
      added: [],
      removed: [],
      widens: false,
      kinds: [{ kind: "retro", display: "Retrospective" }],
    };
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));

    expect(await screen.findByText("This plugin asks for no capabilities at all.")).toBeTruthy();
    expect(screen.getByText(/Provides:\s*Retrospective/)).toBeTruthy();
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

  it("does not call an install healthy when no host is running to have observed it", async () => {
    registry = {
      hostRunning: false,
      secretsAvailable: false,
      installs: [
        {
          id: "p1",
          name: "jira-sync",
          version: "1.0.0",
          enabled: true,
          grants: [logGrant],
          provides: [],
          health: { state: "unknown", reason: "no plugin host is running on this instance" },
        },
      ],
    };
    render();
    const card = (await screen.findByRole("heading", { name: /jira-sync/i })).closest("article")!;
    expect(within(card).queryByText("Running")).toBeNull();
    expect(within(card).queryByText("Disabled")).toBeNull();
    expect(within(card).getByText("Not observable")).toBeTruthy();
    expect(within(card).getByText(/no plugin host is running on this instance/)).toBeTruthy();
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

describe("a payload shaped like the real API response", () => {
  // The type says provides/added/removed are string[]/DescribedGrant[], so a
  // fixture built by hand from the type is free to lie about what the server
  // actually sends. The Go handler used to marshal an unset slice as JSON
  // `null`, which `TestPluginJSONNeverSendsNullForADeclaredArray` (Go) now
  // pins against the wire bytes — but the frontend needs its own guard, since
  // nothing stops the two drifting apart again. This fixture is therefore
  // built from a literal JSON string with `null` in exactly those fields,
  // parsed with JSON.parse rather than constructed as a typed object, so
  // TypeScript's `string[]` cannot quietly disallow the value the server
  // really produced. mockRawResponse is what the fetch layer would decode,
  // not what the component's props claim it receives.
  function mockRawResponse(json: string) {
    return JSON.parse(json) as unknown;
  }

  it("renders an install whose provides/grants arrived as null instead of an empty array", async () => {
    registry = mockRawResponse(`{
      "hostRunning": true,
      "secretsAvailable": true,
      "installs": [{
        "id": "p1",
        "name": "reporter",
        "version": "1.0.0",
        "enabled": true,
        "grants": null,
        "provides": null,
        "health": { "state": "healthy", "reason": "" }
      }]
    }`) as PluginRegistry;

    render();
    // Before the fix this throws inside render: "Cannot read properties of
    // null (reading 'length')" on install.provides.length, white-screening
    // the whole page rather than showing this one card.
    expect(await screen.findByRole("heading", { name: /reporter/i })).toBeTruthy();
  });

  it("renders an upgrade preview whose added/removed arrived as null", async () => {
    preview = mockRawResponse(`{
      "name": "reporter",
      "version": "2.0.0",
      "grants": [{ "capability": "log", "scope": "", "permits": "logs." }],
      "upgrade": true,
      "current": [],
      "added": null,
      "removed": null,
      "widens": false
    }`) as PluginPreview;

    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));

    // Before the fix this throws on preview.added.length while rendering the
    // upgrade branch of the consent screen.
    expect(
      await screen.findByText(/This version asks for nothing beyond what you have already granted/i),
    ).toBeTruthy();
  });
});

describe("a viewer the server has refused", () => {
  it("does not render the install controls when the register comes back 403", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      mockImplementationOnce: (f: unknown) => void;
    };
    api.mockImplementationOnce(async () => {
      throw new ApiError(403, "only an org admin can do that");
    });

    render();

    expect(await screen.findByText(/only an org admin can do that/i)).toBeTruthy();
    expect(screen.queryByText("Install from the catalog")).toBeNull();
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

describe("installing by digest", () => {
  it("installs a catalog version by its digest and key id", async () => {
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
    expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
    expect(calls.find(([m, p]) => m === "POST" && p.endsWith("/preview"))?.[2]).toEqual({ digest: "d1", key_id: "k1" });
    await user.click(screen.getByRole("checkbox", { name: /I grant it/i }));
    await user.click(screen.getByRole("button", { name: "Install reporter 1.0.0" }));
    const install = calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins");
    expect(install?.[2]).toEqual({ digest: "d1", key_id: "k1", grantsAccepted: true });
  });

  it("shows the pin, says when an install is not in the catalog, and rolls back", async () => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "2.0.0", enabled: true, grants: [logGrant], provides: [],
        health: { state: "healthy", reason: "" },
        bundle: { digest: "d2abcdef0123456789", key_id: "k1" }, inCatalog: true,
        history: [
          { digest: "d2abcdef0123456789", key_id: "k1", version: "2.0.0" },
          { digest: "d1", key_id: "k1", version: "1.0.0" },
        ],
      },
      {
        id: "p2", name: "legacy", version: "1.0.0", enabled: true, grants: [], provides: [],
        health: { state: "healthy", reason: "" }, bundle: null, inCatalog: false, history: [],
      },
    ];
    const { container } = render();
    const user = userEvent.setup();
    expect(await screen.findByText(/Not in catalog/)).toBeTruthy();
    expect(screen.getByText(/d2abcdef0123/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back to 2.0.0" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Roll back to 1.0.0" }));
    expect(calls.some(([, p]) => p.endsWith("/rollback"))).toBe(false);
    const confirm = screen.getByRole("button", { name: "Confirm rollback to 1.0.0" });
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByText(/Confirm moving reporter from 2\.0\.0 to 1\.0\.0, or cancel\./)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Confirm rollback to 1.0.0" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Roll back to 1.0.0" }));
    await expectNoViolations(container);
    // Tab to Cancel keeps it armed; a blur with no new focus (a click that
    // does not focus, as in Safari) does not disarm it.
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.blur(document.activeElement as HTMLElement, { relatedTarget: null });
    await user.click(screen.getByRole("button", { name: "Confirm rollback to 1.0.0" }));
    const rollback = calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins/p1/rollback");
    expect(rollback?.[2]).toEqual({ digest: "d1", key_id: "k1" });
    await expectNoViolations(container);
  });

  it("says so when the catalog cannot be read", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    const real = registry;
    api.mockImplementation(async (method: string, path: string) => {
      if (path === "/api/catalog") throw new ApiError(500, "could not load the catalog");
      return method === "GET" ? real : undefined;
    });
    try {
      render();
      expect((await screen.findByRole("alert")).textContent).toContain("could not load the catalog");
    } finally {
      api.mockImplementation(original);
    }
  });


  it("shows the catalog loading", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    api.mockImplementation(async (method: string, path: string) =>
      path === "/api/catalog" ? new Promise(() => {}) : method === "GET" ? registry : undefined,
    );
    try {
      render();
      expect(await screen.findByText("Reading the catalog…")).toBeTruthy();
    } finally {
      api.mockImplementation(original);
    }
  });

  it("never lets a late preview overwrite a newer pick", async () => {
    catalog.plugins[0].versions.push({ version: "2.0.0", digest: "d2", key_id: "k1", grants: [logGrant] });
    let answerOld: (p: PluginPreview) => void = () => {};
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    api.mockImplementation(async (method: string, path: string, body?: { digest?: string }) => {
      if (path === "/api/catalog") return catalog;
      if (path.endsWith("/preview"))
        return body?.digest === "d1"
          ? new Promise<PluginPreview>((res) => (answerOld = res))
          : { ...preview, version: "2.0.0", grants: [logGrant] };
      return method === "GET" ? registry : undefined;
    });
    try {
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
      await user.click(screen.getByRole("button", { name: /^reporter 2\.0\.0,/ }));
      expect(await screen.findByRole("heading", { name: /reporter 2\.0\.0/ })).toBeTruthy();
      answerOld(preview);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText(/Can send anything it holds/)).toBeNull();
    } finally {
      api.mockImplementation(original);
    }
  });

  it("labels a newer entry in the history as an upgrade, not a rollback", async () => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "0.1.0", enabled: true, grants: [], provides: [],
        health: { state: "healthy", reason: "" }, bundle: { digest: "a0", key_id: "k1" }, inCatalog: true,
        history: [
          { digest: "a0", key_id: "k1", version: "0.1.0" },
          { digest: "a1", key_id: "k1", version: "0.1.1" },
        ],
      },
    ];
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Upgrade to 0.1.1" }));
    expect(screen.queryByRole("button", { name: /Roll back/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm upgrade to 0.1.1" })).toBeTruthy();
    expect(screen.getByText(/Confirm moving reporter from 0\.1\.0 to 0\.1\.1/)).toBeTruthy();
  });

  it("points an empty catalog at the page where bundles are added", async () => {
    catalog.plugins = [];
    render();
    const link = await screen.findByRole("link", { name: "the plugin catalog" });
    expect(link.getAttribute("href")).toBe("/catalog");
  });

  it("preselects the version a catalog link names", async () => {
    renderApp(routed, { route: "/o/acme/admin/plugins?install=d1/k1" });
    expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^reporter 1\.0\.0,/ }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("checkbox", { name: /I grant it/i }) as HTMLInputElement).checked).toBe(false);
  });

  describe("the chooser's direction and toggle", () => {
    const running = (version: string) => {
      registry.installs = [
        {
          id: "p1", name: "reporter", version, enabled: true, grants: [], provides: [],
          health: { state: "healthy", reason: "" }, bundle: { digest: `r${version}`, key_id: "k1" }, inCatalog: true, history: [],
        },
      ];
      catalog.plugins = [
        {
          name: "reporter",
          versions: ["0.1.0", "0.1.1", "0.2.0"].map((v) => ({ version: v, digest: `r${v}`, key_id: "k1", grants: [] })),
        },
      ];
    };

    it("names an older version a rollback and posts it to the rollback route", async () => {
      running("0.1.1");
      preview = { ...preview, name: "reporter", version: "0.1.0", upgrade: true, grants: [], added: [], widens: false };
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 0\.1\.0,/ }));
      expect(await screen.findByText(/reporter 0\.1\.0 — a rollback/)).toBeTruthy();
      await user.click(screen.getByRole("checkbox", { name: /I grant it/i }));
      await user.click(screen.getByRole("button", { name: "Roll back to reporter 0.1.0" }));
      expect(calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins/p1/rollback")?.[2]).toEqual({
        digest: "r0.1.0",
        key_id: "k1",
      });
    });

    it("names a newer version an upgrade", async () => {
      running("0.1.1");
      preview = { ...preview, name: "reporter", version: "0.2.0", upgrade: true, grants: [], added: [], widens: false };
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 0\.2\.0,/ }));
      expect(await screen.findByText(/reporter 0\.2\.0 — an upgrade/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Upgrade to reporter 0.2.0" })).toBeTruthy();
    });

    it("offers no action for the version already running", async () => {
      running("0.1.1");
      preview = { ...preview, name: "reporter", version: "0.1.1", upgrade: true, grants: [], added: [], widens: false };
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 0\.1\.1,/ }));
      expect(await screen.findByText(/already running/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^(Install|Upgrade to|Roll back to) reporter/ })).toBeNull();
    });

    it("deselects on a second press, by mouse or keyboard, and draws no divider when nothing is chosen", async () => {
      const { container } = render();
      const user = userEvent.setup();
      const chip = await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ });
      expect(container.querySelector("[data-consent]")).toBeNull();
      await user.click(chip);
      expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
      await user.click(chip);
      expect(chip.getAttribute("aria-pressed")).toBe("false");
      expect(screen.queryByText(/Can send anything it holds/)).toBeNull();
      expect(container.querySelector("[data-consent]")).toBeNull();
      chip.focus();
      await user.keyboard(" ");
      expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
      await user.keyboard("{Enter}");
      expect(screen.queryByText(/Can send anything it holds/)).toBeNull();
    });

    it("holds four plugins of several versions each", async () => {
      catalog.plugins = ["alpha", "beta", "gamma", "delta"].map((name, i) => ({
        name,
        versions: Array.from({ length: 3 + (i % 3) }, (_, j) => ({
          version: `1.${j}.0`, digest: `${name}${j}`.padEnd(64, "0"), key_id: j % 2 ? "" : "k1", grants: [],
        })),
      }));
      const { container } = render();
      expect(await screen.findByRole("button", { name: /^gamma 1\.4\.0,/ })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: /^(alpha|beta|gamma|delta) 1\.\d\.0,/ })).toHaveLength(3 + 4 + 5 + 3);
      for (const group of container.querySelectorAll("[data-versions]")) expect(group.className).toContain("flex-wrap");
      await expectNoViolations(container);
    });
  });

  it("opens the consent directly under the plugin that was chosen", async () => {
    catalog.plugins.push({ name: "other", versions: [{ version: "3.0.0", digest: "o3", key_id: "k1", grants: [] }] });
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
    await screen.findByText(/Can send anything it holds/);
    const group = screen.getByRole("group", { name: "reporter" });
    expect(group.querySelector("[data-consent]")).not.toBeNull();
    expect(screen.getByRole("group", { name: "other" }).querySelector("[data-consent]")).toBeNull();
  });

  it("puts a refused install's error beside its action, not above the title", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation() as (...a: unknown[]) => unknown;
    api.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/api/orgs/acme/admin/plugins") throw new ApiError(409, "the server said no");
      return original(method, path, body);
    });
    try {
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
      await user.click(await screen.findByRole("checkbox", { name: /I grant it/i }));
      const action = screen.getByRole("button", { name: "Install reporter 1.0.0" });
      await user.click(action);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("the server said no");
      const title = screen.getByRole("heading", { name: /reporter 1\.0\.0/ });
      expect(title.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(action.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      api.mockImplementation(original);
    }
  });

  it("names a chip with its signer and whether it runs, and announces the opened consent", async () => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "1.0.0", enabled: true, grants: [], provides: [],
        health: { state: "healthy", reason: "" }, bundle: { digest: "d1", key_id: "k1" }, inCatalog: true, history: [],
      },
    ];
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "reporter 1.0.0, running, signed by key k1" }));
    expect(await screen.findByText("Showing what reporter 1.0.0 may do, below.")).toBeTruthy();
  });

  it("offers a re-pin for the running version from another bundle, and for an unpinned install", async () => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "1.0.0", enabled: true, grants: [], provides: [],
        health: { state: "healthy", reason: "" }, bundle: { digest: "other", key_id: "" }, inCatalog: true, history: [],
      },
    ];
    preview = { ...preview, upgrade: true, grants: [], added: [], widens: false };
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
    await user.click(await screen.findByRole("checkbox", { name: /I grant it/i }));
    await user.click(screen.getByRole("button", { name: "Re-pin to this bundle" }));
    expect(calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins/p1/rollback")?.[2]).toEqual({
      digest: "d1",
      key_id: "k1",
    });
  });

  it("says a move waiting on approval is waiting, and on what", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation() as (...a: unknown[]) => unknown;
    api.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/api/orgs/acme/admin/plugins")
        return { id: "p1", pending: { version: "1.0.0", grants: [fetchGrant], added: [fetchGrant], removed: [] } };
      return original(method, path, body);
    });
    try {
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^reporter 1\.0\.0,/ }));
      await user.click(await screen.findByRole("checkbox", { name: /I grant it/i }));
      await user.click(screen.getByRole("button", { name: "Install reporter 1.0.0" }));
      expect(await screen.findByText("Waiting for approval: fetch *.example.com")).toBeTruthy();
    } finally {
      api.mockImplementation(original);
    }
  });
});

describe("plugin settings", () => {
  const settings: PluginSettings = {
    schema: {
      properties: {
        channel: { type: "string", title: "Channel", description: "Where reports go." },
        mode: { type: "string", title: "Mode", enum: ["fast", "slow"] },
        size: { type: "integer", title: "Size", minimum: 1 },
        loud: { type: "boolean", title: "Loud", default: true },
        token: { type: "string", title: "API token", format: "secret" },
      },
      required: ["mode"],
    },
    values: { channel: "#dev", mode: "slow" },
    secrets: { token: { set: true, undecryptable: false } },
  };

  beforeEach(() => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "1.0.0", enabled: true, grants: [logGrant], provides: [],
        health: { state: "healthy", reason: "" },
      },
    ];
    settingsReply = (method) => (method === "GET" ? settings : settings);
  });

  const refuse = () => {
    settingsReply = (method) => {
      if (method === "GET") return settings;
      throw new ApiError(400, "some settings are not valid: channel, mode", undefined, {
        channel: "does not match the required format",
        mode: "must be one of the listed choices",
      });
    };
  };

  async function open() {
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Settings"));
    await screen.findByLabelText("Channel");
    return user;
  }

  it("builds the form from the schema, and says whether a secret is set without showing it", async () => {
    await open();
    expect((screen.getByLabelText("Channel") as HTMLInputElement).value).toBe("#dev");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("slow");
    expect((screen.getByLabelText("Size") as HTMLInputElement).type).toBe("number");
    expect((screen.getByLabelText("Loud") as HTMLInputElement).checked).toBe(true);
    const secret = screen.getByLabelText(/API token/) as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(screen.getByText("Set")).toBeTruthy();
  });

  it("sends a replaced secret as a string and a cleared one as null, leaving an untouched one out", async () => {
    const user = await open();
    await user.type(screen.getByLabelText(/API token/), "new-token");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    let put = calls.find(([m, p]) => m === "PUT" && p.endsWith("/p1/settings"));
    expect(put?.[2]).toEqual({ channel: "#dev", mode: "slow", loud: true, token: "new-token" });

    calls.length = 0;
    await user.clear(screen.getByLabelText(/API token/));
    await user.click(screen.getByRole("button", { name: "Clear API token" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    put = calls.find(([m, p]) => m === "PUT" && p.endsWith("/p1/settings"));
    expect((put![2] as Record<string, unknown>).token).toBeNull();
  });

  it("reads nothing until the panel is opened", async () => {
    render();
    await screen.findByText("Settings");
    expect(calls.some(([, p]) => p.endsWith("/settings"))).toBe(false);
  });

  it("saves, says so as a status, and reads the settings back", async () => {
    const user = await open();
    await user.type(screen.getByLabelText("Size"), "3");
    await user.click(screen.getByLabelText("Loud"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    const put = calls.find(([m, p]) => m === "PUT" && p.endsWith("/p1/settings"));
    expect(put?.[2]).toEqual({ channel: "#dev", mode: "slow", size: 3, loud: false });
    await screen.findByText("Settings saved.");
    expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("Settings saved."))).toBe(true);
    const gets = calls.filter(([m, p]) => m === "GET" && p.endsWith("/p1/settings"));
    expect(gets.length).toBe(2);
  });

  it("shows the server's refusal beside each field it names", async () => {
    refuse();
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((a) => a.textContent).join(" | ");
    expect(text).toContain("does not match the required format");
    expect(text).toContain("must be one of the listed choices");
    expect(screen.getByLabelText("Channel").getAttribute("aria-invalid")).toBe("true");
    // The summary is the polite status, not another alert.
    expect(text).not.toContain("some settings are not valid");

    await user.type(screen.getByLabelText("Channel"), "x");
    expect(screen.getByLabelText("Channel").getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText(/does not match the required format/)).toBeNull();
  });

  it("has no accessibility violations", async () => {
    refuse();
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findAllByRole("alert");
    await expectNoViolations(document.body);
  });
});
