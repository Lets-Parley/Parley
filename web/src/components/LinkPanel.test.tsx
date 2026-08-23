import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import type { SessionLink } from "../lib/links";
import { LinkPanel } from "./LinkPanel";

const link = (over: Partial<SessionLink> = {}): SessionLink => ({
  id: "l1",
  sessionId: "sess-1",
  createdBy: "dana",
  expiresAt: "2099-01-01T10:00:00.000Z",
  revokedAt: null,
  redemptions: 3,
  createdAt: "2026-08-18T10:00:00.000Z",
  ...over,
});

let links: SessionLink[] = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path === "/api/sessions/sess-1/links") return { links };
      if (method === "POST" && path === "/api/sessions/sess-1/links") {
        links = [...links, link({ id: "l2", redemptions: 0 })];
        return { id: "l2", token: "tok-abc", expiresAt: "2099-01-01T10:00:00.000Z" };
      }
      if (method === "DELETE" && path.startsWith("/api/sessions/sess-1/links/")) {
        links = links.filter((l) => l.id !== path.split("/").pop());
        return undefined;
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    }),
  };
});

let copied: string[] = [];
let clipboardDenied = false;

beforeEach(() => {
  links = [link()];
  copied = [];
  clipboardDenied = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        if (clipboardDenied) throw new Error("denied");
        copied.push(text);
      }),
    },
  });
});

describe("LinkPanel", () => {
  it("lists live links with how much of the cap they have spent", async () => {
    renderApp(<LinkPanel sessionId="sess-1" ended={false} />);
    expect((await screen.findByText(/3 of 25/)).textContent).toMatch(/3 of 25/);
  });

  // The token goes in the fragment, never the query: a query string reaches the
  // Referer header and every access log, and the URL is the whole credential.
  it("mints a link whose token rides in the fragment", async () => {
    renderApp(<LinkPanel sessionId="sess-1" ended={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a guest link" }));

    const field = (await screen.findByLabelText("Guest link")) as HTMLInputElement;
    expect(field.value).toMatch(/\/link#t=tok-abc$/);
    expect(field.value).not.toMatch(/\?/);
  });

  it("copies the link, and says so", async () => {
    renderApp(<LinkPanel sessionId="sess-1" ended={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a guest link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toMatch(/#t=tok-abc$/);
    expect(screen.getByRole("status").textContent).toMatch(/copied/i);
  });

  // A clipboard write rejects on an insecure origin or a denied permission. A
  // success toast over a failed copy sends people off to paste nothing.
  it("owns up when the browser refuses the clipboard", async () => {
    clipboardDenied = true;
    renderApp(<LinkPanel sessionId="sess-1" ended={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a guest link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not copy/i);
  });

  it("drops the row when a link is revoked", async () => {
    renderApp(<LinkPanel sessionId="sess-1" ended={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke link 1" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke link 1" })).toBe(null));
    expect(screen.getByText(/No guest links/i)).toBeTruthy();
  });

  // The server refuses to mint on an ended session, so the button must not
  // offer it.
  it("cannot mint once the session has ended", async () => {
    renderApp(<LinkPanel sessionId="sess-1" ended={true} />);
    const create = (await screen.findByRole("button", {
      name: "Create a guest link",
    })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });
});
