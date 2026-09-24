import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../lib/ui";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { api, type Me } from "../lib/api";
import { Landing } from "./Landing";
import { expectNoViolations } from "../test/axe";

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };
// A link guest: GET /api/me succeeds for them too, but linkSessionId is what
// says "this is not a full account" — the space list and create must not
// treat this the way they treat `me` above.
const guestMe: Me = {
  id: "guest-1",
  name: "Guest",
  avatarHue: 10,
  linkSessionId: "room-session-1",
  linkExpiresAt: "2099-01-01T00:00:00.000Z",
};

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
        if (asGuest) return guestMe;
        return signedIn ? me : null;
      }
      if (path === "/api/auth") return { mode: authMode };
      if (path === "/api/orgs") return myOrgs;
      if (path === "/api/spaces" && method === "GET") {
        if (holdList) await holdList;
        if (listFails) throw new Error("Could not list your spaces.");
        return mySpaces;
      }
      if (path === "/api/spaces") {
        if (holdCreate) await holdCreate;
        if (createFails) throw new Error("Could not create the space.");
        return createResult;
      }
      if (path.includes("/plugins/panels")) return [];
      if (/^\/api\/orgs\/[^/]+\/spaces\/[^/]+$/.test(path) && method === "GET") {
        if (detailFails) throw new Error("Space not found.");
        return spaceDetail;
      }
      throw new Error(`unexpected api call: ${path}`);
    }),
  };
});

let signedIn = true;
let asGuest = false;
let authMode: "open" | "oidc" = "oidc";
let createFails = false;
let listFails = false;
// Makes the return table's read of its room fail.
let detailFails = false;
// Set to a promise a test resolves by hand, to hold the create in flight long
// enough to look at the button while it waits.
let holdCreate: Promise<void> | null = null;
// Holds GET /api/spaces open, to look at the page before the list answers.
let holdList: Promise<void> | null = null;
// What GET /api/orgs/{org}/spaces/{slug} answers: the room the return table
// reads its open rounds and roster from.
let spaceDetail: unknown = { slug: "platform-team", name: "Platform Team", protected: true, members: [], sessions: [] };
let mySpaces: { slug: string; name: string; orgSlug: string; protected: boolean; open?: number; here?: number }[] = [];
// The orgs the caller belongs to. One by default, which is what a single-tenant
// instance looks like: the switcher stays out of the way and the list is flat.
let myOrgs: { slug: string; name: string; role: "admin" | "member" }[] = [
  { slug: "acme", name: "Acme", role: "member" },
];
const createdSpace = {
  slug: "platform-team",
  name: "Platform Team",
  orgSlug: "acme",
  protected: false,
};
// What POST /api/spaces resolves with. Normally the new space; a test sets it
// to undefined to stand in for a 2xx with an empty or unparseable body, which
// lib/api resolves as undefined.
let createResult: unknown = createdSpace;

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
  asGuest = false;
  authMode = "oidc";
  createFails = false;
  listFails = false;
  detailFails = false;
  holdCreate = null;
  holdList = null;
  spaceDetail = { slug: "platform-team", name: "Platform Team", protected: true, members: [], sessions: [] };
  createResult = createdSpace;
  myOrgs = [{ slug: "acme", name: "Acme", role: "member" }];
  mySpaces = [];
  sessionStorage.clear();
  localStorage.clear();
  navigate.mockClear();
  vi.mocked(api).mockClear();
});

describe("Landing, signed in with spaces", () => {
  beforeEach(() => {
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true },
      { slug: "design-guild", name: "Design Guild", orgSlug: "acme", protected: false },
    ];
  });

  it("lists every space I am a member of, most recently active first", async () => {
    renderApp(<Landing />);

    const list = await screen.findByRole("list", { name: /your spaces/i });
    const links = within(list).getAllByRole("link");
    expect(within(links[0]).getByText("Platform Team")).toBeTruthy();
    expect(within(links[1]).getByText("Design Guild")).toBeTruthy();
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/o/acme/s/platform-team",
      "/o/acme/s/design-guild",
    ]);
  });

  // Whether a space wants a code is the difference between pasting the link and
  // having to go and ask for six characters, so the row says which it is.
  it("creates in the org the page is filtered to", async () => {
    myOrgs = [
      { slug: "acme", name: "Acme", role: "member" },
      { slug: "harbour-labs", name: "Harbour Labs", role: "member" },
    ];
    renderApp(<Landing />);

    await userEvent.click(await screen.findByRole("button", { name: "Harbour Labs" }));
    await userEvent.type(screen.getByPlaceholderText(/Platform Team/), "New Crew");
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(spaceCalls()).toContainEqual([
        "POST",
        "/api/spaces",
        { name: "New Crew", org: "harbour-labs" },
      ]),
    );
  });

  // Unfiltered, the form asks; left alone it names the first org rather than
  // leaving the server to guess, so the space lands where the picker says.
  it("names the org the form shows while several are shown unfiltered", async () => {
    myOrgs = [
      { slug: "acme", name: "Acme", role: "member" },
      { slug: "harbour-labs", name: "Harbour Labs", role: "member" },
    ];
    renderApp(<Landing />);

    await screen.findByRole("button", { name: "Harbour Labs" });
    await userEvent.type(screen.getByPlaceholderText(/Platform Team/), "New Crew");
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "New Crew", org: "acme" }]),
    );
  });

  it("marks the spaces that will ask for a passcode", async () => {
    renderApp(<Landing />);

    const list = await screen.findByRole("list", { name: /your spaces/i });
    const links = within(list).getAllByRole("link");
    expect(within(links[0]).queryByText(/passcode/i)).not.toBeNull();
    expect(within(links[1]).queryByText(/passcode/i)).toBeNull();
  });

  it("opts the space-name field out of payment autofill", async () => {
    renderApp(<Landing />);

    const field = await screen.findByPlaceholderText(/Platform Team/);
    expect(field.getAttribute("name")).toBe("space-name");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });

  it("keeps creating a space available alongside the list", async () => {
    renderApp(<Landing />);

    await screen.findByRole("list", { name: /your spaces/i });
    await userEvent.type(
      screen.getByPlaceholderText(/Platform Team/),
      "New Crew",
    );
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "New Crew", org: "acme" }]);
  });

  it("still finishes a create left pending by a sign-in round trip", async () => {
    stash("Platform Team");

    renderApp(<Landing />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toContainEqual([
      "POST",
      "/api/spaces",
      { name: "Platform Team", org: "acme" },
    ]);
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });
});

describe("Landing", () => {
  it("shows no space list, and asks the server for none, while signed out", async () => {
    signedIn = false;
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true },
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
      /Platform Team/,
    );
    expect(input.value).toBe("Platform Team");
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(vi.mocked(api).mock.calls).toContainEqual([
      "POST",
      "/api/spaces",
      { name: "Platform Team", org: "acme" },
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

  // Escape is the reflex on any modal, and this one offered no other way out.
  // Closing the dialog without telling Landing left needName true: the button
  // that raised the gate became inert, and only a reload got the page back.
  it("lets Escape dismiss the name gate and raises it again on the next press", async () => {
    signedIn = false;

    renderApp(<Landing />);

    const field = await screen.findByPlaceholderText(/Platform Team/);
    await userEvent.type(field, "Platform Team");
    const open = screen.getByRole("button", { name: "Open a space" });
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog");

    // Escape on a native <dialog> reaches the page as a cancel event; jsdom
    // does not raise one from the keypress, so it is dispatched directly here.
    // The point under test is what Landing does with it, not who sends it.
    await act(async () => {
      dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Backing out of the gate abandons the create; nothing may be left behind
    // to fire it later from the resume path.
    expect(sessionStorage.getItem("parley:pending-space")).toBeNull();
    expect(spaceCalls()).toHaveLength(0);

    await userEvent.click(open);
    await screen.findByRole("dialog");
  });

  it("creates on submit for someone already signed in", async () => {
    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
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

  // Try again is the visible half of a failed create. It may only be offered
  // while there is something to retry: once the POST has landed the space
  // exists, and the button would be an inert control sitting next to an error.
  it("offers Try again after a failed create, and withdraws it once the space exists", async () => {
    createFails = true;

    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));
    await screen.findByText("Could not create the space.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    // The retry lands the POST, then stumbles on a body with no slug. The space
    // is real from here on, so the retry must go away with it.
    createFails = false;
    createResult = undefined;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText(/couldn't open it/i);
    expect(spaceCalls()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says it is working, and refuses a second press, while the create is in flight", async () => {
    let release!: () => void;
    holdCreate = new Promise<void>((res) => {
      release = res;
    });

    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));

    const waiting = await screen.findByRole("button", { name: "Opening…" });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toHaveLength(1);
  });

  // A list that could not be read is not a list with nothing in it. Rendering
  // the failure as an empty roster tells someone with six spaces they have none.
  it("says so when the space list cannot be read, and reads it again on request", async () => {
    listFails = true;

    renderApp(<Landing />);

    await screen.findByText(/couldn't load your spaces/i);
    expect(screen.queryByRole("list", { name: /your spaces/i })).toBeNull();

    listFails = false;
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: false },
    ];
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    const list = await screen.findByRole("list", { name: /your spaces/i });
    expect(within(list).getByText("Platform Team")).toBeTruthy();
  });

  it("lets a failed create be retried by hand", async () => {
    createFails = true;

    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));
    await screen.findByText("Could not create the space.");
    expect(spaceCalls()).toHaveLength(1);

    createFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Open a space" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toHaveLength(2);
  });

  // Production mounts the app inside StrictMode, which runs every effect twice
  // on mount. Two things are needed for that to reach the resume path at all,
  // and the shared harness supplies neither: StrictMode has to be the root
  // element handed to render (nested under a testing-library wrapper it does
  // not re-invoke), and me has to be answered before the first render, or
  // me.data only lands a tick later — long after the double mount is over.
  // So this one test builds its own tree.
  it("finishes a pending create exactly once under StrictMode", async () => {
    stash("Platform Team");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["me"], me);

    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <ToastProvider>
              <Landing />
            </ToastProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    await act(async () => {});
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team", org: "acme" }],
    ]);
  });

  // The POST landing is the point of no return. Everything after it — reading
  // the body, changing route — is about showing the space, and a stumble there
  // must not offer a button press that buys a second one. The latch stays shut
  // for that case alone: the space already exists on the server.
  it("does not re-run a create whose POST already succeeded", async () => {
    createResult = undefined;

    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    const open = screen.getByRole("button", { name: "Open a space" });
    await userEvent.click(open);

    // The space exists; only the navigate blew up, on a body with no slug.
    // What the reader is told is that the space was made and is in their list —
    // the exception names a field, which is for the console, not for them.
    await screen.findByText(/couldn't open it/i);
    expect(screen.queryByText(/slug/)).toBeNull();
    expect(spaceCalls()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(open);
    await act(async () => {});
    expect(spaceCalls()).toHaveLength(1);

    // The space is real, so it must not be stranded: the list refreshes and
    // offers it as a link rather than leaving an error and an inert button.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
  });

  // The latch is an in-flight guard, not a permanent seal: after a successful
  // create it releases. In the app the navigate unmounts this screen; the test
  // holds it mounted to pin that a later press is allowed to create again.
  it("releases the create latch after a successful create", async () => {
    renderApp(<Landing />);

    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
      "Platform Team",
    );
    const open = screen.getByRole("button", { name: "Open a space" });
    await userEvent.click(open);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team", org: "acme" }],
    ]);

    await userEvent.click(open);
    await waitFor(() =>
      expect(spaceCalls()).toEqual([
        ["POST", "/api/spaces", { name: "Platform Team", org: "acme" }],
        ["POST", "/api/spaces", { name: "Platform Team", org: "acme" }],
      ]),
    );
  });
});

// The sign-in round trip and the name gate can each finish a pending create.
// Only the resume-first ordering is a genuine race: the gate hands over the
// name synchronously, so when it goes first the effect finds nothing left to
// do. When the resume effect wins, the gate is still on screen and about to
// call through — onDone must create only from a pending value it consumed, not
// from the typed name still sitting in React state, or a second POST leaves a
// stray space with its own membership row.
describe("Landing, a pending create raced by both paths", () => {
  beforeEach(() => {
    signedIn = false;
    authMode = "open";
  });

  async function stashViaTheForm() {
    const view = renderApp(<Landing />);
    await userEvent.type(
      await screen.findByPlaceholderText(/Platform Team/),
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

  // The gate's own create path. It is the only path on an open-mode server
  // where nothing has resolved me yet, so if it stops creating, or stops
  // taking the name from the pending slot, nobody notices until a stray space
  // appears on the next mount.
  it("creates the space itself when the gate finishes first", async () => {
    await stashViaTheForm();

    await finishTheGate();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team" }],
    ]);
  });

  it("creates from the pending name, and consumes it, when the gate finishes first", async () => {
    await stashViaTheForm();
    // The name that survived the round trip is the one that counts, not
    // whatever the box happens to hold now.
    stash("Pending Crew");

    await finishTheGate();

    await waitFor(() => expect(spaceCalls()).toHaveLength(1));
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Pending Crew" }],
    ]);
    // Nothing left behind: a leftover key replays as a stray space on the
    // next mount within the window.
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

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
      expect(navigate).toHaveBeenCalledWith("/o/acme/s/platform-team"),
    );
    expect(spaceCalls()).toEqual([
      ["POST", "/api/spaces", { name: "Platform Team", org: "acme" }],
    ]);
  });
});

// GET /api/me now succeeds for a link guest as well as a full account, so
// Landing must tell them apart itself instead of reading "me.data is truthy"
// as "I have an account". Without that, a guest whose localStorage was
// cleared and who wanders here from the logo sees a space list request the
// server refuses ("Couldn't load your spaces") and a create button that
// would fail the same way.
describe("Landing, a link guest", () => {
  beforeEach(() => {
    asGuest = true;
  });

  it("does not ask for the space list as a link guest", async () => {
    renderApp(<Landing />);

    // Let the me query settle and, if the space list is (wrongly) enabled,
    // let its fetch actually fire — that happens a render cycle after
    // me.data lands, not in the same tick as the /api/me call itself.
    await waitFor(() => expect(screen.getByText("Parley")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls()).toHaveLength(0);
    expect(screen.queryByText(/couldn't load your spaces/i)).toBeNull();
  });

  it("points a link guest back to their room instead of the space list", async () => {
    renderApp(<Landing />);

    const back = await screen.findByRole("link", { name: /back to your room/i });
    expect(back.getAttribute("href")).toBe("/session/room-session-1");
    expect(screen.queryByRole("list", { name: /your spaces/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open a space|create a space/i })).toBeNull();
  });

  it("does not attempt to create a space as a link guest", async () => {
    renderApp(<Landing />);

    await waitFor(() => expect(screen.getByText("Parley")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(spaceCalls()).toHaveLength(0);
  });
});

describe("Landing, signed out on an OIDC server", () => {
  beforeEach(() => {
    signedIn = false;
  });

  it("offers a way in without first making up a space name", async () => {
    renderApp(<Landing />);

    const signin = await screen.findByRole("link", { name: /sign in/i });
    expect(signin.getAttribute("href")).toBe("/auth/login?next=%2F");
  });

  it("does not offer it on a server with no identity provider", async () => {
    authMode = "open";
    renderApp(<Landing />);

    await screen.findByPlaceholderText(/Platform Team/);
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });
});

describe("Landing, signed in on an OIDC server", () => {
  it("says who you are and offers the way out", async () => {
    renderApp(<Landing />);

    expect(await screen.findByText("Marcus Okonjo")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some((c) => c[0] === "DELETE" && c[1] === "/api/me"),
      ).toBe(true),
    );
  });

  it("says nothing about accounts on a server with no identity provider", async () => {
    authMode = "open";
    renderApp(<Landing />);

    await screen.findByPlaceholderText(/Platform Team/);
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("leaves a link guest alone", async () => {
    asGuest = true;
    renderApp(<Landing />);

    await screen.findByRole("link", { name: /back to your room/i });
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });
});

/**
 * Everything the org cutover added to this page: the switcher, the grouping a
 * slug's org-scoping makes necessary, and the dead end for an account the
 * identity provider put in no org at all.
 */
describe("Landing across orgs", () => {
  const twoOrgs = () => {
    myOrgs = [
      { slug: "acme", name: "Acme", role: "member" },
      { slug: "globex", name: "Globex", role: "admin" },
    ];
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true },
      { slug: "platform-team", name: "Platform Team", orgSlug: "globex", protected: false },
      { slug: "design-guild", name: "Design Guild", orgSlug: "acme", protected: false },
    ];
  };

  // The plugin surface is only reachable at all if something links to it, and
  // it must not be advertised to somebody the API will refuse.
  it("offers the plugin surface for orgs the account administers, and no others", async () => {
    twoOrgs();
    renderApp(<Landing />);

    const globex = within(await screen.findByRole("region", { name: "Globex" }));
    expect(globex.getByRole("link", { name: /Plugins in Globex/ }).getAttribute("href")).toBe(
      "/o/globex/admin/plugins",
    );
    expect(screen.queryByRole("link", { name: /Plugins in Acme/ })).toBe(null);
  });

  it("offers it to nobody when the account administers no org", async () => {
    myOrgs = [{ slug: "acme", name: "Acme", role: "member" }];
    renderApp(<Landing />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: /Plugins in/ })).toBe(null);
  });

  // Two orgs can each hold a "platform-team", so the slug alone is ambiguous
  // and both links have to name their own org or one of them goes to the
  // wrong space.
  it("groups the list by org and links each space through its own", async () => {
    twoOrgs();
    renderApp(<Landing />);

    const acme = within(await screen.findByRole("list", { name: "Your spaces in Acme" }));
    expect(acme.getByRole("link", { name: /Platform Team/ }).getAttribute("href")).toBe(
      "/o/acme/s/platform-team",
    );
    const globex = within(screen.getByRole("list", { name: "Your spaces in Globex" }));
    expect(globex.getByRole("link", { name: /Platform Team/ }).getAttribute("href")).toBe(
      "/o/globex/s/platform-team",
    );
  });

  it("keeps the switcher out of the way on a single-org instance", async () => {
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: false },
    ];
    renderApp(<Landing />);

    await screen.findByRole("list", { name: /your spaces/i });
    expect(screen.queryByRole("group", { name: "Show spaces from" })).toBeNull();
  });

  it("narrows the list to the org the switcher names", async () => {
    twoOrgs();
    renderApp(<Landing />);

    await userEvent.click(await screen.findByRole("button", { name: "Globex" }));

    expect(screen.getByRole("list", { name: "Your spaces in Globex" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Your spaces in Acme" })).toBeNull();
  });

  // Every new control has to be reachable and operable without a pointer: a
  // switcher only a mouse can work is a switcher some of the team cannot use.
  it("is switched by keyboard alone", async () => {
    twoOrgs();
    renderApp(<Landing />);

    const all = await screen.findByRole("button", { name: "All orgs" });
    all.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Acme" }));
    await userEvent.tab();
    const globex = screen.getByRole("button", { name: "Globex" });
    expect(document.activeElement).toBe(globex);

    await userEvent.keyboard("{Enter}");
    expect(globex.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("list", { name: "Your spaces in Acme" })).toBeNull();
  });

  // A signed-in account whose claims matched no org has nowhere to put a
  // space. Offering the create form would only produce a refusal, and an
  // empty page would read as a bug.
  it("tells an account in no org what to do about it, without crashing", async () => {
    myOrgs = [];
    mySpaces = [];
    renderApp(<Landing />);

    const dead = await screen.findByRole("region", { name: "No org yet" });
    expect(within(dead).getByText(/ask an administrator/i)).toBeTruthy();
    expect(within(dead).getByText("Marcus Okonjo")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Platform Team/)).toBeNull();
  });

  // The resume runs on its own, with no click behind it, so a caller in no org
  // would have a space created for them that every follow-up call then refuses.
  // The dead end is the answer for them, and the name stays theirs to retry.
  it("does not resume a pending create for an account in no org", async () => {
    myOrgs = [];
    mySpaces = [];
    stash("Platform Team");
    renderApp(<Landing />);

    await screen.findByRole("region", { name: "No org yet" });
    expect(spaceCalls()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  // The whole point of the directory is finding a room nobody sent you a link
  // to — which is exactly the position of someone who has joined no space yet.
  // Hanging its only door off the space list put it out of reach of the one
  // person it was built for.
  it("offers the directory to an org member who has no spaces at all", async () => {
    mySpaces = [];
    renderApp(<Landing />);

    const browse = await screen.findByRole("link", { name: /browse acme/i });
    expect(browse.getAttribute("href")).toBe("/o/acme");
  });

  it("offers a directory door for every org, and narrows with the switcher", async () => {
    twoOrgs();
    renderApp(<Landing />);

    const browse = () =>
      screen.getAllByRole("link", { name: /^Browse / }).map((a) => a.getAttribute("href"));
    await screen.findByRole("link", { name: "Browse Acme" });
    expect(browse()).toEqual(["/o/acme", "/o/globex"]);

    await userEvent.click(screen.getByRole("button", { name: "Globex" }));
    await waitFor(() => expect(browse()).toEqual(["/o/globex"]));
  });

  it("puts the directory door in the tab order, no pointer needed", async () => {
    mySpaces = [];
    renderApp(<Landing />);
    const browse = await screen.findByRole("link", { name: /browse acme/i });

    browse.focus();
    expect(document.activeElement).toBe(browse);
  });

  // axe in both render passes. It deliberately skips colour contrast — jsdom
  // has no layout — so contrast on these controls stays a review item.
  for (const theme of ["light", "dark"] as const) {
    it(`has no axe violations in the ${theme} pass, directory door with no spaces`, async () => {
      mySpaces = [];
      localStorage.setItem("parley:theme", theme);
      const { container } = renderApp(<Landing />);
      await screen.findByRole("link", { name: /browse acme/i });
      await expectNoViolations(container);
    });

    it(`has no axe violations in the ${theme} pass, switcher and grouping`, async () => {
      twoOrgs();
      localStorage.setItem("parley:theme", theme);
      const { container } = renderApp(<Landing />);
      await screen.findByRole("group", { name: "Show spaces from" });
      await expectNoViolations(container);
    });

    it(`has no axe violations in the ${theme} pass, no-org dead end`, async () => {
      myOrgs = [];
      mySpaces = [];
      localStorage.setItem("parley:theme", theme);
      const { container } = renderApp(<Landing />);
      await screen.findByRole("region", { name: "No org yet" });
      await expectNoViolations(container);
    });
  }
});

describe("Landing, coming back to the table", () => {
  const twoOrgs = () => {
    myOrgs = [
      { slug: "acme", name: "Acme", role: "member" },
      { slug: "globex", name: "Globex", role: "admin" },
    ];
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true },
      { slug: "research", name: "Research", orgSlug: "globex", protected: false },
    ];
  };

  beforeEach(() => {
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true },
      { slug: "design-guild", name: "Design Guild", orgSlug: "acme", protected: false },
    ];
  });

  // The list is most-recently-active first, so its head is the table this
  // person last sat at — and it is the page's heading, not a row among rows.
  it("leads with the table you sat at last", async () => {
    renderApp(<Landing />);

    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Platform Team");
    expect(
      screen.getByRole("link", { name: "Go to Platform Team" }).getAttribute("href"),
    ).toBe("/o/acme/s/platform-team");
  });

  it("says who is at an open round, and seats you at it in one step", async () => {
    spaceDetail = {
      slug: "platform-team",
      name: "Platform Team",
      protected: true,
      members: [
        { userId: "b", name: "Ben Alvarez", avatarHue: 1, spectator: false, at: { sessionId: "s1", title: "Sprint 34" } },
        { userId: "n", name: "Nina Kowalski", avatarHue: 2, spectator: false, at: { sessionId: "s1", title: "Sprint 34" } },
        { userId: "t", name: "Tomas Herrera", avatarHue: 3, spectator: false },
      ],
      sessions: [
        { id: "s1", kind: "poker", title: "Sprint 34", createdAt: "", endedAt: null, here: 3 },
        { id: "s0", kind: "standup", title: "Monday", createdAt: "", endedAt: "2026-01-01T00:00:00Z", here: 0 },
      ],
    };
    renderApp(<Landing />);

    const open = within(await screen.findByRole("list", { name: "Rounds open now" }));
    const join = open.getByRole("link");
    expect(join.getAttribute("href")).toBe("/session/s1");
    // Two named from the roster; the third socket is a link guest the roster
    // does not carry, counted rather than dropped.
    expect(within(join).getByText("Ben, Nina and 1 other at the table")).toBeTruthy();
    expect(open.queryByText("Monday")).toBeNull();
  });

  it("says the table is quiet when no round is open", async () => {
    renderApp(<Landing />);
    expect(await screen.findByText(/No round open/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Rounds open now" })).toBeNull();
  });

  // `data ?? []` read a list still in flight as "no spaces", so every signed-in
  // load dealt the stranger's hand and printed the pitch before tearing both
  // down. Nothing of the stranger's page may render while the answer is out.
  it("never shows a returning account the stranger's page while the list loads", async () => {
    let release!: () => void;
    holdList = new Promise((r) => (release = r));
    renderApp(<Landing />);

    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(screen.queryByText(/Name a table/)).toBeNull();
    expect(screen.queryByText(/Self-hosted: one binary/)).toBeNull();

    release();
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Platform Team");
    expect(screen.queryByText(/Name a table/)).toBeNull();
  });

  // The switcher is the page saying which org it is showing; a create sent to
  // the instance's default org from under another org's heading lands where
  // the person is not looking.
  it("creates in the org the switcher is showing", async () => {
    twoOrgs();
    renderApp(<Landing />);

    await userEvent.click(await screen.findByRole("button", { name: "Globex" }));
    expect((screen.getByLabelText("Org") as HTMLSelectElement).value).toBe("globex");
    await userEvent.type(screen.getByPlaceholderText(/Platform Team/), "Night Watch");
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "Night Watch", org: "globex" }]),
    );
  });

  // The picker stays on screen under a filter, so the switcher is never a
  // silent second control over where a create lands — and a pick made in it
  // outranks whatever the switcher says afterwards.
  it("keeps the org picker in view under a filter, and lets an explicit pick win", async () => {
    twoOrgs();
    renderApp(<Landing />);

    const picker = (await screen.findByLabelText("Org")) as HTMLSelectElement;
    expect(picker.value).toBe("acme");
    await userEvent.click(screen.getByRole("button", { name: "Globex" }));
    expect((screen.getByLabelText("Org") as HTMLSelectElement).value).toBe("globex");
    await userEvent.selectOptions(screen.getByLabelText("Org"), "acme");
    await userEvent.click(screen.getByRole("button", { name: "Globex" }));
    expect((screen.getByLabelText("Org") as HTMLSelectElement).value).toBe("acme");
    await userEvent.type(screen.getByPlaceholderText(/Platform Team/), "Night Watch");
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "Night Watch", org: "acme" }]),
    );
  });

  // Nobody at an empty round is waiting on you; "Join" with the accent's
  // weight promised company that is not there.
  it("offers to open an empty round and to join an occupied one", async () => {
    spaceDetail = {
      slug: "platform-team",
      name: "Platform Team",
      protected: true,
      members: [],
      sessions: [
        { id: "s1", kind: "poker", title: "Sprint 34", createdAt: "", endedAt: null, here: 2 },
        { id: "s2", kind: "standup", title: "Daily", createdAt: "", endedAt: null, here: 0 },
      ],
    };
    renderApp(<Landing />);

    const open = within(await screen.findByRole("list", { name: "Rounds open now" }));
    const [busy, empty] = open.getAllByRole("link");
    expect(within(busy).getByText("Join")).toBeTruthy();
    expect(within(empty).getByText("Open")).toBeTruthy();
    expect(within(empty).queryByText("Join")).toBeNull();
    expect(empty.getAttribute("href")).toBe("/session/s2");
  });

  it("asks which org when the page is showing all of them", async () => {
    twoOrgs();
    renderApp(<Landing />);

    await userEvent.selectOptions(await screen.findByLabelText("Org"), "globex");
    await userEvent.type(screen.getByPlaceholderText(/Platform Team/), "Night Watch");
    await userEvent.click(screen.getByRole("button", { name: /create a space/i }));

    await waitFor(() =>
      expect(spaceCalls()).toContainEqual(["POST", "/api/spaces", { name: "Night Watch", org: "globex" }]),
    );
  });

  it("finds a space by typing, and opens the only match on Enter", async () => {
    mySpaces = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((n) => ({
      slug: n.toLowerCase(),
      name: n,
      orgSlug: "acme",
      protected: false,
    }));
    renderApp(<Landing />);

    const find = await screen.findByRole("searchbox", { name: "Find a space" });
    await userEvent.type(find, "trot");
    const list = within(screen.getByRole("list", { name: "Your spaces in Acme" }));
    expect(list.getAllByRole("link").map((a) => a.textContent)).toEqual(["Foxtrot"]);

    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/o/acme/s/foxtrot");
  });

  it("opens the first match on Enter when several match", async () => {
    mySpaces = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((n) => ({
      slug: n.toLowerCase(),
      name: n,
      orgSlug: "acme",
      protected: false,
    }));
    renderApp(<Landing />);

    await userEvent.type(await screen.findByRole("searchbox", { name: "Find a space" }), "o{Enter}");
    expect(navigate).toHaveBeenCalledWith("/o/acme/s/bravo");
  });

  // A live region mounted already holding its text is often never announced.
  it("keeps the no-match announcement mounted before it has anything to say", async () => {
    mySpaces = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((n) => ({
      slug: n.toLowerCase(),
      name: n,
      orgSlug: "acme",
      protected: false,
    }));
    const { container } = renderApp(<Landing />);

    const find = await screen.findByRole("searchbox", { name: "Find a space" });
    const main = within(container.querySelector("main")!);
    const status = main.getByRole("status");
    expect(status.textContent).toBe("");
    await userEvent.type(find, "zzz");
    expect(main.getByRole("status")).toBe(status);
    expect(status.textContent).toMatch(/No space of yours matches/);
  });

  it("names each org panel by its heading rather than a second copy of it", async () => {
    renderApp(<Landing />);
    const region = await screen.findByRole("region", { name: "Acme" });
    expect(region.getAttribute("aria-label")).toBeNull();
    expect(document.getElementById(region.getAttribute("aria-labelledby")!)!.tagName).toBe("H2");
  });

  it("runs the form labels a size up from the shared 10px", async () => {
    renderApp(<Landing />);
    await screen.findByRole("list", { name: /your spaces/i });
    const label = screen.getByText("New space");
    expect(label.className).toContain("text-[11px]");
    expect(label.className).not.toContain("text-[10px]");
  });

  // Below sm the chip is hidden; the glyph has to say poker or standup alone.
  it("marks a round's kind with its glyph where the chip does not fit", async () => {
    spaceDetail = {
      slug: "platform-team",
      name: "Platform Team",
      protected: true,
      members: [],
      sessions: [{ id: "s1", kind: "standup", title: "Daily", createdAt: "", endedAt: null, here: 1 }],
    };
    renderApp(<Landing />);

    const row = within(await screen.findByRole("list", { name: "Rounds open now" })).getByRole("link");
    const small = row.querySelector(".sm\\:hidden")!;
    expect(small.querySelector("svg")).not.toBeNull();
    expect(small.textContent).toBe(", Standup");
  });

  // "Two at the table" is a claim about now, so the room is re-read — but a
  // read that failed is not retried every 15s for as long as the tab is open.
  it("stops re-reading the last table once its read fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      detailFails = true;
      renderApp(<Landing />);
      await screen.findByRole("heading", { level: 1 });
      const detailCalls = () =>
        vi.mocked(api).mock.calls.filter((c) => /^\/api\/orgs\/acme\/spaces\//.test(c[1])).length;
      await waitFor(() => expect(detailCalls()).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(46_000);
      });
      expect(detailCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the find box away from a list short enough to read at a glance", async () => {
    renderApp(<Landing />);
    await screen.findByRole("list", { name: /your spaces/i });
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  // A screen reader used to hear "Platform TeamPASSCODE" as one word.
  it("names a locked space and its passcode as two words", async () => {
    renderApp(<Landing />);
    const list = within(await screen.findByRole("list", { name: /your spaces/i }));
    expect(list.getByRole("link", { name: /^Platform Team\W+passcode$/i })).toBeTruthy();
  });

  // The load used to lay out the stranger's narrow centred column and snap to
  // the wide top-aligned one when the list landed — the page's biggest layout
  // shift. A full account gets the signed-in shell, and a skeleton in the same
  // two columns, from the first paint.
  it("holds the signed-in shell, in two columns, while the list loads", async () => {
    let release!: () => void;
    holdList = new Promise((r) => (release = r));
    const { container } = renderApp(<Landing />);

    await waitFor(() => expect(listCalls()).toHaveLength(1));
    const main = container.querySelector("main")!;
    expect(main.className).toContain("max-w-6xl");
    expect(main.querySelector("[aria-hidden].lg\\:col-start-2")).not.toBeNull();

    release();
    await screen.findByRole("heading", { level: 1 });
    expect(main.className).toContain("max-w-6xl");
  });

  // A list that failed is not an empty one: no pitch to someone who already
  // has tables, and no panel claiming there are none.
  it("shows a signed-in account neither the pitch nor an empty list when the list fails", async () => {
    listFails = true;
    renderApp(<Landing />);

    await screen.findByText(/couldn't load your spaces/i);
    await screen.findByRole("region", { name: "Acme" });
    expect(screen.queryByText(/Name a table/)).toBeNull();
    expect(screen.queryByText(/Self-hosted: one binary/)).toBeNull();
    expect(screen.queryByText(/No tables of yours/)).toBeNull();
  });

  // One unbroken name used to widen the grid past a 390px viewport.
  it("lets a long unbroken space name wrap rather than widen the page", async () => {
    const long = "x".repeat(80);
    mySpaces = [{ slug: "long", name: long, orgSlug: "acme", protected: false }];
    const { container } = renderApp(<Landing />);

    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.className).toContain("[overflow-wrap:anywhere]");
    const row = within(screen.getByRole("list", { name: /your spaces/i })).getByText(long);
    expect(row.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByRole("link", { name: `Go to ${long}` }).className).toContain("[overflow-wrap:anywhere]");
    expect(container.querySelector("main .grid")!.className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  // At lg the form sits under the hero, on the left; it has to come before the
  // right-hand list in the tab order too, not after every space row.
  it("puts the create form before the list in the reading order", async () => {
    renderApp(<Landing />);

    const list = await screen.findByRole("list", { name: /your spaces/i });
    const field = screen.getByPlaceholderText(/Platform Team/);
    expect(field.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Every row says whether its table is live, not only the one in the hero.
  it("marks a row whose round is open, and whether anyone is at it", async () => {
    mySpaces = [
      { slug: "platform-team", name: "Platform Team", orgSlug: "acme", protected: true, open: 1, here: 3 },
      { slug: "design-guild", name: "Design Guild", orgSlug: "acme", protected: false, open: 1, here: 0 },
      { slug: "research", name: "Research", orgSlug: "acme", protected: false, open: 0, here: 0 },
    ];
    renderApp(<Landing />);

    const list = within(await screen.findByRole("list", { name: /your spaces/i }));
    const busy = list.getByRole("link", { name: /^Platform Team, round open, 3 at the table\W+passcode$/ });
    expect(busy.querySelector(".bg-card-back")).not.toBeNull();
    const empty = list.getByRole("link", { name: "Design Guild, round open" });
    expect(empty.querySelector(".border-dashed")).not.toBeNull();
    expect(empty.querySelector(".bg-card-back")).toBeNull();
    const quiet = list.getByRole("link", { name: "Research" });
    expect(quiet.querySelector("[aria-hidden]")).toBeNull();
  });

  it("stops explaining invites once there are a few tables", async () => {
    renderApp(<Landing />);
    await screen.findByRole("list", { name: /your spaces/i });
    expect(screen.queryByText(/That link is your invite/)).toBeNull();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`has no axe violations in the ${theme} pass, with a round open`, async () => {
      twoOrgs();
      spaceDetail = {
        slug: "platform-team",
        name: "Platform Team",
        protected: true,
        members: [],
        sessions: [{ id: "s1", kind: "poker", title: "Sprint 34", createdAt: "", endedAt: null, here: 2 }],
      };
      localStorage.setItem("parley:theme", theme);
      const { container } = renderApp(<Landing />);
      await screen.findByRole("list", { name: "Rounds open now" });
      await expectNoViolations(container);
    });
  }
});
