import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameGate } from "./NameGate";
import { renderApp } from "../test/render";
import type { Me } from "../lib/api";
import { rememberOpenSession } from "../lib/sessionMemory";

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
    expect(screen.getByText(/new guest/i)).toBeTruthy();
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
