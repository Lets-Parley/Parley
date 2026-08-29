import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameGate, useMe } from "./NameGate";
import { renderApp } from "../test/render";
import type { Me } from "../lib/api";
import {
  clearSessionMemory,
  rememberOpenSession,
} from "../lib/sessionMemory";

const minted: Me = { id: "u-new", name: "Ada", avatarHue: 40 };

function mockAuth(mode: "open" | "oidc" = "open") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth") {
      return new Response(JSON.stringify({ mode }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path === "/api/me" && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify(minted), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("NameGate", () => {
  it("asks a first-time open-mode visitor for a name", async () => {
    mockAuth("open");
    renderApp(<NameGate onDone={() => {}} />);

    expect(
      await screen.findByRole("heading", { name: /what should we call you/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /session ended/i })).toBeNull();
    expect(screen.getByText(/no account, no email/i)).toBeTruthy();
  });

  // The silent-stranger bug: a 401 used to reopen the first-visit gate, so
  // posting a name minted a brand-new anonymous user with no memberships and
  // never said why. When this browser already held a seat, the copy has to
  // say the seat is gone and that continuing is a new guest identity.
  it("shows a distinct expired-session state when this browser had a seat", async () => {
    rememberOpenSession("Ada Lovelace");
    mockAuth("open");
    renderApp(<NameGate onDone={() => {}} />);

    expect(await screen.findByRole("heading", { name: /your session ended/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /what should we call you/i })).toBeNull();
    expect(screen.getByText(/makes a/i).textContent).toMatch(/new guest/i);
    expect(screen.getByRole("button", { name: /take a seat as a new guest/i })).toBeTruthy();
    const field = screen.getByLabelText(/your name/i) as HTMLInputElement;
    expect(field.value).toBe("Ada Lovelace");
  });

  it("still mints a new open-mode identity from the expired state", async () => {
    rememberOpenSession("Ada Lovelace");
    const fetchMock = mockAuth("open");
    const onDone = vi.fn();
    renderApp(<NameGate onDone={onDone} />);

    await screen.findByRole("heading", { name: /your session ended/i });
    await userEvent.clear(screen.getByLabelText(/your name/i));
    await userEvent.type(screen.getByLabelText(/your name/i), "Ada");
    await userEvent.click(screen.getByRole("button", { name: /take a seat as a new guest/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(minted));
    const posts = fetchMock.mock.calls.filter(
      ([path, init]) => String(path) === "/api/me" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });

  it("keeps the OIDC sign-in gate when the session has lapsed", async () => {
    rememberOpenSession("Ada Lovelace");
    mockAuth("oidc");
    renderApp(<NameGate onDone={() => {}} />);

    expect(await screen.findByRole("heading", { name: /sign in to take a seat/i })).toBeTruthy();
    const link = screen.getByRole("link", { name: /continue to sign in/i });
    expect(link.getAttribute("href")).toMatch(/^\/auth\/login\?next=/);
    expect(screen.queryByRole("heading", { name: /your session ended/i })).toBeNull();
  });
});


function MeThenGate() {
  const me = useMe();
  if (me.isLoading) return <p>loading</p>;
  if (!me.data) return <NameGate onDone={() => {}} />;
  return <p>signed in as {me.data.name}</p>;
}

describe("useMe session-memory wiring", () => {
  it('notes "session ended" from GET /api/me so NameGate shows the expired copy', async () => {
    // Empty localStorage: only the 401 body can mark the seat as ended.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth") {
        return new Response(JSON.stringify({ mode: "open" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/me" && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ error: "session ended" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not signed in" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(<MeThenGate />);

    expect(await screen.findByRole("heading", { name: /your session ended/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /what should we call you/i })).toBeNull();
  });

  it('keeps the first-visit gate for a plain "not signed in" 401 with empty memory', async () => {
    mockAuth("open");
    renderApp(<MeThenGate />);

    expect(
      await screen.findByRole("heading", { name: /what should we call you/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /your session ended/i })).toBeNull();
  });

  it("does not remember a link-guest seat as an open-mode session", async () => {
    const linkMe: Me = {
      id: "guest-1",
      name: "Priya",
      avatarHue: 200,
      linkSessionId: "sess-1",
      linkExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth") {
        return new Response(JSON.stringify({ mode: "open" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/me") {
        return new Response(JSON.stringify(linkMe), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(<MeThenGate />);

    expect(await screen.findByText(/signed in as Priya/i)).toBeTruthy();
    expect(localStorage.getItem("parley:last-name")).toBeNull();
    expect(localStorage.getItem("parley:session-ended")).toBeNull();
  });
});

describe("clearSessionMemory", () => {
  it("clears the expired-session marker so the next gate is a first visit", async () => {
    rememberOpenSession("Ada Lovelace");
    clearSessionMemory();
    mockAuth("open");
    renderApp(<NameGate onDone={() => {}} />);

    expect(
      await screen.findByRole("heading", { name: /what should we call you/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /your session ended/i })).toBeNull();
  });
});
