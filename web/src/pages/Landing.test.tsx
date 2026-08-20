import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
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
    api: vi.fn(async (method: string, path: string) => {
      if (path === "/api/me") {
        if (method === "POST") {
          signedIn = true;
          return me;
        }
        return signedIn ? me : null;
      }
      if (path === "/api/auth") return { mode: authMode };
      if (path === "/api/spaces" && method === "GET") return mySpaces;
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
let authMode: "open" | "oidc" = "oidc";
let createFails = false;
let mySpaces: { slug: string; name: string; protected: boolean }[] = [];

const pendingKey = "parley:pending-space";
const stash = (name: string, at = Date.now()) =>
  sessionStorage.setItem(pendingKey, JSON.stringify({ name, at }));
const spaceCalls = () =>
  vi.mocked(api).mock.calls.filter(
    (c) => c[1] === "/api/spaces" && c[0] === "POST",
  );
const listCalls = () =>
  vi.mocked(api).mock.calls.filter(
    (c) => c[1] === "/api/spaces" && c[0] === "GET",
  );

beforeEach(() => {
  signedIn = true;
  authMode = "oidc";
  createFails = false;
  mySpaces = [];
  sessionStorage.clear();
  navigate.mockClear();
  vi.mocked(api).mockClear();
});

describe("Landing, signed in with spaces", () => {
  beforeEach(() => {
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", protected: true },
      { slug: "design-guild", name: "Design Guild", protected: false },
    ];
  });

  it("lists every space I am a member of, most recently active first", async () => {
    renderApp(<Landing />);

    const list = await screen.findByRole("list", { name: /your spaces/i });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Platform Team",
      "Design Guild",
    ]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/s/platform-team",
      "/s/design-guild",
    ]);
  });

  it("keeps creating a space available alongside the list", async () => {
    renderApp(<Landing />);

    await screen.findByRole("list", { name: /your spaces/i });
    await userEvent.type(
      screen.getByPlaceholderText(/Name your space/),
      "New Crew",
    );
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "New Crew" }]);
  });

  it("still finishes a create left pending by a sign-in round trip", async () => {
    stash("Platform Team");

    renderApp(<Landing />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(spaceCalls()).toContainEqual([
      "POST",
      "/api/spaces",
      { name: "Platform Team" },
    ]);
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });
});

describe("Landing", () => {
  it("shows no space list, and asks the server for none, while signed out", async () => {
    signedIn = false;
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", protected: true },
    ];

    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[1] === "/api/me")).toBe(true),
    );
    expect(listCalls()).toHaveLength(0);
    expect(screen.queryByRole("list", { name: /your spaces/i })).toBeNull();
  });

  it("falls back to the create-first view when I am in no spaces", async () => {
    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Open a space" });
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(screen.queryByRole("list", { name: /your spaces/i })).toBeNull();
  });

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
    // The list route is 401 for a signed-out visitor, so it must not be asked
    // at all — and asserting it here keeps this test independent of the
    // dedicated listing tests.
    expect(listCalls()).toHaveLength(0);
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
    await waitFor(() => expect(listCalls()).toHaveLength(1));
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
    await waitFor(() => expect(listCalls()).toHaveLength(1));
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
    await waitFor(() => expect(listCalls()).toHaveLength(1));
  });

  // The two halves of the latch contract. A failure has to hand the name back
  // so the person in front of the screen can simply press the button again;
  // a success must not, because the create already happened and no late-waking
  // path may repeat it.
  it("lets a failed create be retried by hand", async () => {
    createFails = true;

    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Name your space/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));
    await screen.findByText("Could not create the space.");
    expect(spaceCalls()).toHaveLength(1);

    createFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(spaceCalls()).toHaveLength(2);
  });

  // Production mounts the app inside StrictMode, which runs every effect twice
  // on mount. The shared test harness does not, so this one test renders the
  // way main.tsx does to keep the resume effect honest under a double mount.
  it("finishes a pending create exactly once under StrictMode", async () => {
    stash("Platform Team");

    renderApp(
      <StrictMode>
        <Landing />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    await act(async () => {});
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team" }],
    ]);
  });

  it("creates one space per visit, however many times the button is pressed", async () => {
    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Name your space/),
      "Platform Team",
    );
    const open = screen.getByRole("button", { name: "Open a space" });
    await userEvent.click(open);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );

    // In the app the navigate above swaps the route and unmounts this screen.
    // The test holds it mounted on purpose, to pin what happens if anything —
    // a second press, a path waking late — reaches doCreate after a success.
    await userEvent.click(open);
    await act(async () => {});

    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team" }],
    ]);
  });
});

// The sign-in round trip and the name gate can each finish a pending create.
// Only the resume-first ordering is a genuine race: the gate hands over the
// name synchronously, so when it goes first the effect finds nothing left to
// do. When the resume effect wins, the gate is still on screen and about to
// call through — and the typed name must still buy exactly one space, because
// a second POST leaves a stray space with its own membership row.
describe("Landing, a pending create raced by both paths", () => {
  beforeEach(() => {
    signedIn = false;
    authMode = "open";
  });

  async function stashViaTheForm() {
    const view = renderApp(<Landing />);
    await userEvent.type(
      await screen.findByPlaceholderText(/Name your space/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));
    await screen.findByRole("heading", { name: /what should we call you/i });
    expect(JSON.parse(sessionStorage.getItem(pendingKey) ?? "{}").name).toBe(
      "Platform Team",
    );
    return view;
  }

  async function finishTheGate() {
    await userEvent.type(screen.getByPlaceholderText("Your name"), "Marcus");
    await userEvent.click(screen.getByRole("button", { name: /take a seat/i }));
  }

  it("creates once when the sign-in resolves before the gate is finished", async () => {
    const { queryClient } = await stashViaTheForm();

    // The resume effect wakes as soon as me.data lands, which can happen while
    // the gate is still on screen.
    await act(async () => {
      queryClient.setQueryData(["me"], me);
    });
    await waitFor(() => expect(spaceCalls()).toHaveLength(1));

    await finishTheGate();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/s/platform-team"),
    );
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team" }],
    ]);
  });
});
