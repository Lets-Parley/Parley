import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { CatalogPage } from "./CatalogPage";

const catalog = {
  can_upload: false,
  plugins: [
    {
      name: "retro",
      versions: [
        {
          version: "1.0.0",
          digest: "abc123",
          key_id: "k1",
          grants: [{ capability: "log", scope: "", permits: "Copy written by the server." }],
        },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/catalog" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    return new Response("{}", { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  catalog.can_upload = false;
});

describe("CatalogPage", () => {
  it("lists bundles with the server's capability copy and offers no upload to a non-curator", async () => {
    const { container } = renderApp(<CatalogPage />);
    expect(await screen.findByText("Copy written by the server.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "retro" })).toBeTruthy();
    expect(screen.queryByLabelText("A signed .parley file")).toBeNull();
    await expectNoViolations(container);
  });

  it("offers an org admin a link that installs a version in their org", async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path === "/api/orgs"
        ? new Response(
            JSON.stringify([
              { slug: "acme", name: "Acme", role: "admin" },
              { slug: "beta", name: "Beta", role: "member" },
            ]),
            { status: 200 },
          )
        : new Response(JSON.stringify(catalog), { status: 200 }),
    );
    const { container } = renderApp(<CatalogPage />);
    const link = await screen.findByRole("link", { name: "Install retro 1.0.0 in Acme" });
    expect(link.getAttribute("href")).toBe("/o/acme/admin/plugins?install=abc123/k1");
    expect(screen.queryByRole("link", { name: /in Beta/ })).toBeNull();
    await expectNoViolations(container);
  });

  it("summarizes each plugin once and flags only what changes between versions", async () => {
    const log = { capability: "log", scope: "", permits: "Copy written by the server." };
    const kv = { capability: "kv", scope: "", permits: "Keeps its own notes." };
    const saved = catalog.plugins;
    catalog.plugins = [
      {
        name: "retro",
        versions: [
          { version: "1.0.0", digest: "abc123", key_id: "k1", grants: [log], provides: ["Retrospective"], published_at: "2026-09-01T00:00:00Z" },
          { version: "1.1.0", digest: "def456", key_id: "k1", grants: [log, kv], provides: ["Retrospective"], published_at: "2026-09-20T00:00:00Z" },
        ],
      },
    ] as unknown as typeof catalog.plugins;
    try {
      const { container } = renderApp(<CatalogPage />);
      const card = await screen.findByRole("region", { name: "retro" });
      expect(card.textContent).toContain("2 versions");
      expect(card.textContent).toContain("Latest 1.1.0");
      expect(card.textContent).toContain("Retrospective");
      expect(screen.getAllByText("Copy written by the server.")).toHaveLength(1);
      expect(screen.getByText(/adds kv/)).toBeTruthy();
      expect(screen.getAllByRole("row").length).toBeGreaterThanOrEqual(2);
      await expectNoViolations(container);
    } finally {
      catalog.plugins = saved;
    }
  });

  it("shows a loading line while the catalog is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderApp(<CatalogPage />);
    expect(await screen.findByText("Loading the catalog…")).toBeTruthy();
  });


  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  const zone = () => screen.findByRole("button", { name: /Drop a \.parley bundle here or browse/ });
  const answerPost = (post: () => Promise<Response>) =>
    fetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "POST" ? post() : new Response(JSON.stringify(catalog), { status: 200 }),
    );

  describe("uploading", () => {
    beforeEach(() => {
      catalog.can_upload = true;
    });

    it("uploads a picked file at once, raw, with the bundle content type", async () => {
      const { container } = renderApp(<CatalogPage />);
      await zone();
      await expectNoViolations(container);
      const file = new File([new Uint8Array([31, 139])], "retro.parley");
      await userEvent.upload(screen.getByLabelText("A signed .parley file"), file);
      await screen.findByText("Added retro.parley to the catalog.");
      expect(posts()).toHaveLength(1);
      const [path, init] = posts()[0];
      expect(path).toBe("/api/catalog/bundles");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/vnd.parley.bundle");
      expect(init?.body).toBe(file);
    });

    it("uploads a dropped file at once, with no click", async () => {
      renderApp(<CatalogPage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.parley")] } });
      await screen.findByText("Added retro.parley to the catalog.");
      expect(posts()).toHaveLength(1);
    });

    it("refuses a file that is not a .parley bundle with no upload", async () => {
      renderApp(<CatalogPage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.zip")] } });
      expect(await screen.findByText(/retro\.zip/)).toBeTruthy();
      expect(posts()).toHaveLength(0);
    });

    it("shows the upload on the zone and ignores a second drop meanwhile", async () => {
      let finish: (r: Response) => void = () => {};
      answerPost(() => new Promise<Response>((res) => (finish = res)));
      renderApp(<CatalogPage />);
      const z = await zone();
      fireEvent.drop(z, { dataTransfer: { files: [new File(["x"], "one.parley")] } });
      // Announced, not only drawn on the zone.
      await waitFor(() =>
        expect(document.querySelector("[data-upload-result] [role=status]")?.textContent).toBe("Uploading one.parley…"),
      );
      expect(z.getAttribute("aria-busy")).toBe("true");
      expect((screen.getByLabelText("A signed .parley file") as HTMLInputElement).disabled).toBe(true);
      fireEvent.drop(z, { dataTransfer: { files: [new File(["y"], "two.parley")] } });
      expect(posts()).toHaveLength(1);
      finish(new Response("{}", { status: 201 }));
      await screen.findByText("Added one.parley to the catalog.");
      expect(z.getAttribute("aria-busy")).toBe("false");
      expect(screen.queryByText("Uploading one.parley…")).toBeNull();
    });

    it("says a bundle already held is already there, as a status", async () => {
      answerPost(async () =>
        new Response(JSON.stringify({ name: "retro", versions: [{ version: "1.0.0" }] }), { status: 200 }),
      );
      renderApp(<CatalogPage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.parley")] } });
      expect(await screen.findByText("retro 1.0.0 is already in the catalog.")).toBeTruthy();
      expect(screen.queryByText(/Added/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("reserves the result line before any upload, so nothing jumps", async () => {
      const { container } = renderApp(<CatalogPage />);
      await zone();
      const region = container.querySelector("[data-upload-result]");
      expect(region).not.toBeNull();
      expect(region?.className).toContain("min-h-");
      answerPost(async () => new Response("", { status: 413 }));
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "a.parley")] } });
      const line = await screen.findByText("That bundle is too large to upload.");
      expect(region?.contains(line)).toBe(true);
    });

    it("changes its copy and state while a file is dragged over, and restores both on leave", async () => {
      const { container } = renderApp(<CatalogPage />);
      const z = await zone();
      const one = { dataTransfer: { items: [{ kind: "file" }], types: ["Files"] } };
      fireEvent.dragEnter(z, one);
      expect(z.getAttribute("data-drag")).toBe("over");
      expect(screen.getByText("Release to add it to the catalog")).toBeTruthy();
      // Entering a child and leaving the zone's own box must not flicker.
      fireEvent.dragEnter(z.firstElementChild as Element, one);
      fireEvent.dragLeave(z, one);
      expect(z.getAttribute("data-drag")).toBe("over");
      fireEvent.dragLeave(z.firstElementChild as Element, one);
      expect(z.getAttribute("data-drag")).toBe("idle");
      expect(screen.queryByText("Release to add it to the catalog")).toBeNull();
      await expectNoViolations(container);
    });

    it("takes several files at once and reports each one", async () => {
      fetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
        if (init?.method !== "POST") return new Response(JSON.stringify(catalog), { status: 200 });
        const name = (init.body as File).name;
        if (name === "a.parley") return new Response("{}", { status: 201 });
        if (name === "b.parley")
          return new Response(JSON.stringify({ name: "retro", versions: [{ version: "1.0.0" }] }), { status: 200 });
        return new Response(JSON.stringify({ error: "another bundle already holds this plugin name and version" }), { status: 409 });
      });
      renderApp(<CatalogPage />);
      const z = await zone();
      fireEvent.dragEnter(z, { dataTransfer: { items: [{ kind: "file" }, { kind: "file" }], types: ["Files"] } });
      expect(screen.getByText("Release to add them to the catalog")).toBeTruthy();
      fireEvent.drop(z, {
        dataTransfer: {
          files: [
            new File(["a"], "a.parley"),
            new File(["b"], "b.parley"),
            new File(["c"], "c.zip"),
            new File(["d"], "d.parley"),
          ],
        },
      });
      expect(await screen.findByText("Added a.parley to the catalog.")).toBeTruthy();
      expect(await screen.findByText("retro 1.0.0 is already in the catalog.")).toBeTruthy();
      expect(await screen.findByText("1 added, 1 already there, 2 refused.")).toBeTruthy();
      expect(screen.getByText(/c\.zip/)).toBeTruthy();
      expect(screen.getByText("another bundle already holds this plugin name and version")).toBeTruthy();
      // One polite live region carries every result; no row interrupts.
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
      const live = document.querySelector("[data-upload-result] [aria-live=polite]");
      expect(live?.textContent).toContain("1 added, 1 already there, 2 refused.");
      expect(live?.textContent).toContain("c.zip");
      expect(posts()).toHaveLength(3);
      expect(z.getAttribute("aria-busy")).toBe("false");
      expect((screen.getByLabelText("A signed .parley file") as HTMLInputElement).multiple).toBe(true);
    });

    it("opens the file picker from the keyboard", async () => {
      renderApp(<CatalogPage />);
      const z = await zone();
      const click = vi.spyOn(screen.getByLabelText("A signed .parley file") as HTMLInputElement, "click");
      z.focus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(click).toHaveBeenCalledTimes(2);
    });

    const refusals: Array<[string, () => Promise<Response>, string]> = [
      ["409", async () => new Response(JSON.stringify({ error: "another bundle already holds this plugin name and version" }), { status: 409 }), "another bundle already holds this plugin name and version"],
      ["422", async () => new Response(JSON.stringify({ error: "the bundle is not signed by a key this instance trusts" }), { status: 422 }), "the bundle is not signed by a key this instance trusts"],
      ["413", async () => new Response("", { status: 413 }), "That bundle is too large to upload."],
      ["a network error", async () => { throw new TypeError("Failed to fetch"); }, "Can't reach the server — check your connection and try again."],
    ];
    for (const [label, answer, text] of refusals) {
      it(`reports ${label} as an alert, resets the zone, and clears it on the next file`, async () => {
        answerPost(answer);
        renderApp(<CatalogPage />);
        const z = await zone();
        fireEvent.drop(z, { dataTransfer: { files: [new File(["x"], "a.parley")] } });
        expect(await screen.findByText(text)).toBeTruthy();
        expect(z.getAttribute("aria-busy")).toBe("false");
        expect((screen.getByLabelText("A signed .parley file") as HTMLInputElement).disabled).toBe(false);
        expect(screen.queryByText(/to the catalog\./)).toBeNull();
        answerPost(() => new Promise<Response>(() => {}));
        fireEvent.drop(z, { dataTransfer: { files: [new File(["y"], "b.parley")] } });
        expect(screen.queryByText(text)).toBeNull();
      });
    }
  });
});
