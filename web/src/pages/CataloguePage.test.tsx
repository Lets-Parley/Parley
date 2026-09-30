import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { CataloguePage } from "./CataloguePage";

const catalogue = {
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
    if (path === "/api/catalogue" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(catalogue), { status: 200 });
    }
    return new Response("{}", { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  catalogue.can_upload = false;
});

describe("CataloguePage", () => {
  it("lists bundles with the server's capability copy and offers no upload to a non-curator", async () => {
    const { container } = renderApp(<CataloguePage />);
    expect(await screen.findByText("Copy written by the server.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "retro" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    await expectNoViolations(container);
  });

  it("uploads the raw file with the bundle content type for a curator", async () => {
    catalogue.can_upload = true;
    const { container } = renderApp(<CataloguePage />);
    const input = await screen.findByLabelText("A signed .parley file");
    await expectNoViolations(container);
    const file = new File([new Uint8Array([31, 139])], "retro.parley");
    await userEvent.upload(input, file);
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await screen.findByText("Added retro.parley to the catalogue.");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/catalogue/bundles");
    expect((post?.[1]?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/vnd.parley.bundle",
    );
    expect(post?.[1]?.body).toBe(file);
  });

  it("shows a loading line while the catalogue is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderApp(<CataloguePage />);
    expect(await screen.findByText("Loading the catalogue…")).toBeTruthy();
  });

  const refusals: Array<[string, () => Promise<Response>, string]> = [
    ["409", async () => new Response(JSON.stringify({ error: "another bundle already holds this plugin name and version" }), { status: 409 }), "another bundle already holds this plugin name and version"],
    ["422", async () => new Response(JSON.stringify({ error: "the bundle is not signed by a key this instance trusts" }), { status: 422 }), "the bundle is not signed by a key this instance trusts"],
    ["413", async () => new Response("", { status: 413 }), "That bundle is too large to upload."],
    ["a network error", async () => { throw new TypeError("Failed to fetch"); }, "Can't reach the server — check your connection and try again."],
  ];
  for (const [label, answer, text] of refusals) {
    it(`reports ${label} as an alert, and clears it when a new file is chosen`, async () => {
      catalogue.can_upload = true;
      fetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? answer() : new Response(JSON.stringify(catalogue), { status: 200 }),
      );
      renderApp(<CataloguePage />);
      const input = await screen.findByLabelText("A signed .parley file");
      await userEvent.upload(input, new File([new Uint8Array([1])], "a.parley"));
      await userEvent.click(screen.getByRole("button", { name: "Upload" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      expect(screen.queryByText(/to the catalogue\./)).toBeNull();
      await userEvent.upload(input, new File([new Uint8Array([2])], "b.parley"));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  }
});
