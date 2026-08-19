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
      if (path === "/api/spaces")
        return {
          slug: "platform-team",
          name: "Platform Team",
          protected: false,
        };
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

let signedIn = true;

beforeEach(() => {
  signedIn = true;
  sessionStorage.clear();
  navigate.mockClear();
  vi.mocked(api).mockClear();
});

describe("Landing", () => {
  it("finishes the create left pending by a sign-in round trip", async () => {
    sessionStorage.setItem("parley:pending-space", "Platform Team");

    renderApp(<Landing />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(vi.mocked(api).mock.calls).toContainEqual([
      "POST",
      "/api/spaces",
      { name: "Platform Team" },
    ]);
    expect(sessionStorage.getItem("parley:pending-space")).toBeNull();
  });

  it("does not create anything on its own while signed out", async () => {
    signedIn = false;
    sessionStorage.setItem("parley:pending-space", "Platform Team");

    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(
        true,
      ),
    );
    expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/spaces")).toBe(
      false,
    );
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
});
