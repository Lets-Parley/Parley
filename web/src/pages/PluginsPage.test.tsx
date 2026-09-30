import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { Catalogue, DescribedGrant, PluginPreview, PluginRegistry } from "../lib/plugins";
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
let catalogue: Catalogue;
const calls: Array<[string, string, unknown]> = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET" && path === "/api/orgs/acme/admin/plugins") return registry;
      if (method === "POST" && path.endsWith("/preview")) return preview;
      if (method === "GET" && path === "/api/catalogue") return catalogue;
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
  localStorage.clear();
  registry = { hostRunning: true, secretsAvailable: true, installs: [] };
  catalogue = {
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
    await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));

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
    await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));

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
    await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));

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
    await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));

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
    expect(screen.queryByText("Install from the catalogue")).toBeNull();
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
  it("installs a catalogue version by its digest and key id", async () => {
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));
    expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
    expect(calls.find(([m, p]) => m === "POST" && p.endsWith("/preview"))?.[2]).toEqual({ digest: "d1", key_id: "k1" });
    await user.click(screen.getByRole("checkbox", { name: /I grant it/i }));
    await user.click(screen.getByRole("button", { name: "Install reporter 1.0.0" }));
    const install = calls.find(([m, p]) => m === "POST" && p === "/api/orgs/acme/admin/plugins");
    expect(install?.[2]).toEqual({ digest: "d1", key_id: "k1", grantsAccepted: true });
  });

  it("shows the pin, says when an install is not in the catalogue, and rolls back", async () => {
    registry.installs = [
      {
        id: "p1", name: "reporter", version: "2.0.0", enabled: true, grants: [logGrant], provides: [],
        health: { state: "healthy", reason: "" },
        bundle: { digest: "d2abcdef0123456789", key_id: "k1" }, inCatalogue: true,
        history: [
          { digest: "d2abcdef0123456789", key_id: "k1", version: "2.0.0" },
          { digest: "d1", key_id: "k1", version: "1.0.0" },
        ],
      },
      {
        id: "p2", name: "legacy", version: "1.0.0", enabled: true, grants: [], provides: [],
        health: { state: "healthy", reason: "" }, bundle: null, inCatalogue: false, history: [],
      },
    ];
    const { container } = render();
    const user = userEvent.setup();
    expect(await screen.findByText(/Not in catalogue/)).toBeTruthy();
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

  it("says so when the catalogue cannot be read", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    const real = registry;
    api.mockImplementation(async (method: string, path: string) => {
      if (path === "/api/catalogue") throw new ApiError(500, "could not load the catalogue");
      return method === "GET" ? real : undefined;
    });
    try {
      render();
      expect((await screen.findByRole("alert")).textContent).toContain("could not load the catalogue");
    } finally {
      api.mockImplementation(original);
    }
  });


  it("shows the catalogue loading", async () => {
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    api.mockImplementation(async (method: string, path: string) =>
      path === "/api/catalogue" ? new Promise(() => {}) : method === "GET" ? registry : undefined,
    );
    try {
      render();
      expect(await screen.findByText("Reading the catalogue…")).toBeTruthy();
    } finally {
      api.mockImplementation(original);
    }
  });

  it("never lets a late preview overwrite a newer pick", async () => {
    catalogue.plugins[0].versions.push({ version: "2.0.0", digest: "d2", key_id: "k1", grants: [logGrant] });
    let answerOld: (p: PluginPreview) => void = () => {};
    const api = (await import("../lib/api")).api as unknown as {
      getMockImplementation: () => unknown;
      mockImplementation: (f: unknown) => void;
    };
    const original = api.getMockImplementation();
    api.mockImplementation(async (method: string, path: string, body?: { digest?: string }) => {
      if (path === "/api/catalogue") return catalogue;
      if (path.endsWith("/preview"))
        return body?.digest === "d1"
          ? new Promise<PluginPreview>((res) => (answerOld = res))
          : { ...preview, version: "2.0.0", grants: [logGrant] };
      return method === "GET" ? registry : undefined;
    });
    try {
      render();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: "reporter 1.0.0" }));
      await user.click(screen.getByRole("radio", { name: "reporter 2.0.0" }));
      expect(await screen.findByText(/reporter 2\.0\.0/, { selector: "p,h3,h4,strong,span,div" })).toBeTruthy();
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
        health: { state: "healthy", reason: "" }, bundle: { digest: "a0", key_id: "k1" }, inCatalogue: true,
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

  it("points an empty catalogue at the page where bundles are added", async () => {
    catalogue.plugins = [];
    render();
    const link = await screen.findByRole("link", { name: "the plugin catalogue" });
    expect(link.getAttribute("href")).toBe("/catalogue");
  });

  it("preselects the version a catalogue link names", async () => {
    renderApp(routed, { route: "/o/acme/admin/plugins?install=d1/k1" });
    expect(await screen.findByText(/Can send anything it holds/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: "reporter 1.0.0" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /I grant it/i }) as HTMLInputElement).checked).toBe(false);
  });
});
