import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { api, type Me } from "../lib/api";
import { Landing } from "./Landing";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (_method: string, path: string) => {
      if (path === "/api/me") return signedIn ? me : null;
      if (path === "/api/auth") return { mode: "oidc" };
      if (path === "/api/spaces") {
        if (createFails) throw new Error("Could not create the space.");
        return {
          slug: "platform-team",
          name: "Platform Team",
          protected: false,
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

let signedIn = true;
let createFails = false;

const pendingKey = "parley:pending-space";
const stash = (name: string, at = Date.now()) =>
  sessionStorage.setItem(pendingKey, JSON.stringify({ name, at }));
const spaceCalls = () =>
  vi.mocked(api).mock.calls.filter((c) => c[1] === "/api/spaces");

beforeEach(() => {
  signedIn = true;
  createFails = false;
  sessionStorage.clear();
  navigate.mockClear();
  vi.mocked(api).mockClear();
});

describe("Landing", () => {
  it("finishes the create left pending by a sign-in round trip", async () => {
    stash("Platform Team");

    renderApp(<Landing />);

    const input = await screen.findByPlaceholderText<HTMLInputElement>(
      /Name your space/,
    );
    expect(input.value).toBe("Platform Team");
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(vi.mocked(api).mock.calls).toContainEqual([
      "POST",
      "/api/spaces",
      { name: "Platform Team" },
    ]);
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

  it("does not create anything on its own while signed out", async () => {
    signedIn = false;
    stash("Platform Team");

    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(
        true,
      ),
    );
    expect(spaceCalls()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("creates on submit for someone already signed in", async () => {
    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Name your space/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
  });

  it("creates nothing on a plain signed-in visit with nothing pending", async () => {
    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(
        true,
      ),
    );
    expect(spaceCalls()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["a stale", JSON.stringify({ name: "Platform Team", at: Date.now() - 16 * 60 * 1000 })],
    ["an unparseable", "Platform Team"],
  ])("discards %s pending value instead of replaying it", async (_label, raw) => {
    sessionStorage.setItem(pendingKey, raw);

    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(
        true,
      ),
    );
    expect(spaceCalls()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

  it("leaves nothing pending when the resumed create fails", async () => {
    createFails = true;
    stash("Platform Team");

    const view = renderApp(<Landing />);

    await screen.findByText("Could not create the space.");
    expect(sessionStorage.getItem(pendingKey)).toBeNull();

    view.unmount();
    vi.mocked(api).mockClear();
    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(
        true,
      ),
    );
    expect(spaceCalls()).toHaveLength(0);
  });
});
