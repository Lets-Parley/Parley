import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { ApiError, api } from "../lib/api";
import { linkGuestFor } from "../lib/links";
import { LinkPage } from "./LinkPage";

const navigated: string[] = [];
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => (to: string) => navigated.push(to) };
});

// What the redeem route answers with. A test swaps it for a failure.
let redeem: () => unknown = () => ({
  sessionId: "sess-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  me: { id: "guest-1", name: "Priya", avatarHue: 200 },
});

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/auth") return { mode: "open" };
      if (path === "/api/links/redeem") return redeem();
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

const calls = () =>
  (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    ([, path]) => path === "/api/links/redeem",
  );

beforeEach(() => {
  (api as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
  navigated.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/link#t=tok-abc");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  redeem = () => ({
    sessionId: "sess-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    me: { id: "guest-1", name: "Priya", avatarHue: 200 },
  });
});

describe("LinkPage", () => {
  // The fragment is the credential. It must not survive into a bookmark, the
  // back button or a screenshot, and it must never have been in the query.
  it("takes the token from the fragment and wipes it on arrival", async () => {
    renderApp(<LinkPage />, { route: "/link" });

    await screen.findByLabelText("Your name");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  it("redeems with the name, remembers the guest, and opens the room", async () => {
    renderApp(<LinkPage />, { route: "/link" });

    await userEvent.type(await screen.findByLabelText("Your name"), "Priya");
    await userEvent.click(screen.getByRole("button", { name: "Take a seat" }));

    await waitFor(() => expect(navigated).toEqual(["/session/sess-1"]));
    expect(calls()).toEqual([["POST", "/api/links/redeem", { token: "tok-abc", name: "Priya" }]]);
    expect(linkGuestFor("sess-1")?.me.name).toBe("Priya");
  });

  // Every redemption spends one of the link's 25. A redeem that fires twice —
  // on a re-render, or on a second click while the first is in flight — burns
  // one for nothing. The invite equivalent is guarded in SpacePage.test.tsx.
  it("redeems exactly once across re-renders and repeat clicks", async () => {
    const { rerender } = renderApp(<LinkPage />, { route: "/link" });

    await userEvent.type(await screen.findByLabelText("Your name"), "Priya");
    const seat = screen.getByRole("button", { name: "Take a seat" });
    await userEvent.click(seat);
    await userEvent.click(seat);
    rerender(<LinkPage />);
    rerender(<LinkPage />);

    await waitFor(() => expect(navigated.length).toBe(1));
    expect(calls()).toHaveLength(1);
  });

  // Expired, revoked, exhausted and simply wrong are all one 404 on the wire,
  // and the UI must not guess which — telling a holder "expired" rather than
  // "wrong" tells them the token was real.
  it("says the link no longer works, without echoing the token", async () => {
    redeem = () => {
      throw new ApiError(404, "this link is not valid");
    };
    renderApp(<LinkPage />, { route: "/link" });

    await userEvent.type(await screen.findByLabelText("Your name"), "Priya");
    await userEvent.click(screen.getByRole("button", { name: "Take a seat" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no longer works/i);
    expect(alert.textContent).not.toMatch(/tok-abc/);
    expect(document.body.textContent).not.toMatch(/tok-abc/);
    expect(navigated).toEqual([]);
  });

  // The fragment is wiped on arrival and the token then lives only in React
  // state, so a dismissed prompt is unrecoverable — no reload can bring the
  // token back. Escape must therefore leave the prompt standing. jsdom fires
  // no `cancel`, so Escape is modelled the way Modal.test.tsx models it.
  it("keeps the prompt up when Escape cancels it, since the token is unrecoverable", async () => {
    renderApp(<LinkPage />, { route: "/link" });

    await screen.findByLabelText("Your name");
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));

    expect(dialog.open).toBe(true);
    expect(screen.queryByRole("button", { name: "Take a seat" })).not.toBe(null);
    // The fragment stays wiped regardless: dismissal must never be the reason
    // a token lingers in the URL.
    expect(window.location.hash).toBe("");
  });

  it("asks for nothing when the URL carries no token", async () => {
    window.history.replaceState(null, "", "/link");
    renderApp(<LinkPage />, { route: "/link" });

    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer works/i);
    expect(screen.queryByLabelText("Your name")).toBe(null);
    expect(calls()).toEqual([]);
  });
});
