import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
    expect(screen.queryByLabelText("A signed .parley file")).toBeNull();
    await expectNoViolations(container);
  });

  it("shows a loading line while the catalogue is pending", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderApp(<CataloguePage />);
    expect(await screen.findByText("Loading the catalogue…")).toBeTruthy();
  });


  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  const zone = () => screen.findByRole("button", { name: /Drop a \.parley bundle here or browse/ });
  const answerPost = (post: () => Promise<Response>) =>
    fetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "POST" ? post() : new Response(JSON.stringify(catalogue), { status: 200 }),
    );

  describe("uploading", () => {
    beforeEach(() => {
      catalogue.can_upload = true;
    });

    it("uploads a picked file at once, raw, with the bundle content type", async () => {
      const { container } = renderApp(<CataloguePage />);
      await zone();
      await expectNoViolations(container);
      const file = new File([new Uint8Array([31, 139])], "retro.parley");
      await userEvent.upload(screen.getByLabelText("A signed .parley file"), file);
      await screen.findByText("Added retro.parley to the catalogue.");
      expect(posts()).toHaveLength(1);
      const [path, init] = posts()[0];
      expect(path).toBe("/api/catalogue/bundles");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/vnd.parley.bundle");
      expect(init?.body).toBe(file);
    });

    it("uploads a dropped file at once, with no click", async () => {
      renderApp(<CataloguePage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.parley")] } });
      await screen.findByText("Added retro.parley to the catalogue.");
      expect(posts()).toHaveLength(1);
    });

    it("refuses a file that is not a .parley bundle with no upload", async () => {
      renderApp(<CataloguePage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.zip")] } });
      expect((await screen.findByRole("alert")).textContent).toContain("retro.zip");
      expect(posts()).toHaveLength(0);
    });

    it("shows the upload on the zone and ignores a second drop meanwhile", async () => {
      let finish: (r: Response) => void = () => {};
      answerPost(() => new Promise<Response>((res) => (finish = res)));
      renderApp(<CataloguePage />);
      const z = await zone();
      fireEvent.drop(z, { dataTransfer: { files: [new File(["x"], "one.parley")] } });
      expect(await screen.findByText("Uploading one.parley…")).toBeTruthy();
      expect(z.getAttribute("aria-busy")).toBe("true");
      expect((screen.getByLabelText("A signed .parley file") as HTMLInputElement).disabled).toBe(true);
      fireEvent.drop(z, { dataTransfer: { files: [new File(["y"], "two.parley")] } });
      expect(posts()).toHaveLength(1);
      finish(new Response("{}", { status: 201 }));
      await screen.findByText("Added one.parley to the catalogue.");
      expect(z.getAttribute("aria-busy")).toBe("false");
      expect(screen.queryByText("Uploading one.parley…")).toBeNull();
    });

    it("says a bundle already held is already there, as a status", async () => {
      answerPost(async () =>
        new Response(JSON.stringify({ name: "retro", versions: [{ version: "1.0.0" }] }), { status: 200 }),
      );
      renderApp(<CataloguePage />);
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "retro.parley")] } });
      expect(await screen.findByText("retro 1.0.0 is already in the catalogue.")).toBeTruthy();
      expect(screen.queryByText(/Added/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("reserves the result line before any upload, so nothing jumps", async () => {
      const { container } = renderApp(<CataloguePage />);
      await zone();
      const region = container.querySelector("[data-upload-result]");
      expect(region).not.toBeNull();
      expect(region?.className).toContain("min-h-");
      answerPost(async () => new Response("", { status: 413 }));
      fireEvent.drop(await zone(), { dataTransfer: { files: [new File(["x"], "a.parley")] } });
      const alert = await screen.findByRole("alert");
      expect(region?.contains(alert)).toBe(true);
    });

    it("changes its copy and state while a file is dragged over, and restores both on leave", async () => {
      const { container } = renderApp(<CataloguePage />);
      const z = await zone();
      const one = { dataTransfer: { items: [{ kind: "file" }], types: ["Files"] } };
      fireEvent.dragEnter(z, one);
      expect(z.getAttribute("data-drag")).toBe("over");
      expect(screen.getByText("Release to add it to the catalogue")).toBeTruthy();
      // Entering a child and leaving the zone's own box must not flicker.
      fireEvent.dragEnter(z.firstElementChild as Element, one);
      fireEvent.dragLeave(z, one);
      expect(z.getAttribute("data-drag")).toBe("over");
      fireEvent.dragLeave(z.firstElementChild as Element, one);
      expect(z.getAttribute("data-drag")).toBe("idle");
      expect(screen.queryByText("Release to add it to the catalogue")).toBeNull();
      await expectNoViolations(container);
    });

    it("says one bundle at a time when several files are dragged over", async () => {
      renderApp(<CataloguePage />);
      const z = await zone();
      fireEvent.dragEnter(z, { dataTransfer: { items: [{ kind: "file" }, { kind: "file" }], types: ["Files"] } });
      expect(z.getAttribute("data-drag")).toBe("many");
      expect(screen.getByText("One bundle at a time")).toBeTruthy();
    });

    it("opens the file picker from the keyboard", async () => {
      renderApp(<CataloguePage />);
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
        renderApp(<CataloguePage />);
        const z = await zone();
        fireEvent.drop(z, { dataTransfer: { files: [new File(["x"], "a.parley")] } });
        expect((await screen.findByRole("alert")).textContent).toBe(text);
        expect(z.getAttribute("aria-busy")).toBe("false");
        expect((screen.getByLabelText("A signed .parley file") as HTMLInputElement).disabled).toBe(false);
        expect(screen.queryByText(/to the catalogue\./)).toBeNull();
        answerPost(() => new Promise<Response>(() => {}));
        fireEvent.drop(z, { dataTransfer: { files: [new File(["y"], "b.parley")] } });
        expect(screen.queryByRole("alert")).toBeNull();
      });
    }
  });
});
