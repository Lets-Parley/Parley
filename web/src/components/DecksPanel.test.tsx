import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, type Deck } from "../lib/api";
import { DecksPanel } from "./DecksPanel";

const house: Deck = {
  id: "d1",
  name: "House deck",
  cards: ["S", "M", "L"],
  ordinal: true,
  createdAt: "2026-08-18T10:00:00.000Z",
};

const fib: Deck = {
  id: "d2",
  name: "Fibonacci",
  cards: ["1", "2", "3", "5", "8"],
  ordinal: false,
  createdAt: "2026-08-19T10:00:00.000Z",
};

let decks: Deck[] = [];
const calls: Array<[string, string, unknown]> = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET") return decks;
      return undefined;
    }),
  };
});

beforeEach(() => {
  calls.length = 0;
  decks = [house];
  vi.mocked(api).mockClear();
});

function show(canManage = true) {
  return renderApp(<DecksPanel org="acme" slug="platform-team" canManage={canManage} onError={vi.fn()} />);
}

describe("DecksPanel", () => {
  it("lists a space's decks with their cards", async () => {
    show();
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("House deck")).toBeTruthy();
    for (const card of ["S", "M", "L"]) expect(within(row).getByText(card)).toBeTruthy();
  });

  it("creates a deck from the form", async () => {
    show();
    await screen.findByText("House deck");
    await userEvent.click(screen.getByRole("button", { name: "New deck" }));
    await userEvent.type(screen.getByLabelText("Deck name"), "Sizes");
    await userEvent.type(screen.getByLabelText(/Cards/), "1, 2, 3");
    await userEvent.click(screen.getByRole("button", { name: "Save deck" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "POST",
        "/api/orgs/acme/spaces/platform-team/decks",
        { name: "Sizes", cards: ["1", "2", "3"], ordinal: false },
      ]),
    );
  });

  it("renames a deck and rewrites its cards through one edit", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit: House deck" }));
    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Shirt sizes");
    const cards = screen.getByLabelText(/Cards/);
    await userEvent.clear(cards);
    await userEvent.type(cards, "S,M,L,XL");
    await userEvent.click(screen.getByRole("button", { name: "Save deck" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "PATCH",
        "/api/orgs/acme/spaces/platform-team/decks/d1",
        { name: "Shirt sizes", cards: ["S", "M", "L", "XL"], ordinal: true },
      ]),
    );
  });

  it("says existing sessions keep their cards before deleting", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Delete: House deck" }));
    expect(screen.getByText(/sessions already created keep their cards/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete deck" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "DELETE",
        "/api/orgs/acme/spaces/platform-team/decks/d1",
        undefined,
      ]),
    );
  });

  it("shows a member the decks and none of the controls", async () => {
    show(false);
    expect(await screen.findByText("House deck")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New deck" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Edit: House deck" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Delete: House deck" })).toBe(null);
  });

  it("resets the form when switching which deck is being edited", async () => {
    decks = [house, fib];
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit: House deck" }));
    expect((screen.getByLabelText("Deck name") as HTMLInputElement).value).toBe("House deck");
    await userEvent.click(screen.getByRole("button", { name: "Edit: Fibonacci" }));
    expect((screen.getByLabelText("Deck name") as HTMLInputElement).value).toBe("Fibonacci");
    expect((screen.getByLabelText(/Cards/) as HTMLInputElement).value).toBe("1, 2, 3, 5, 8");

    await userEvent.click(screen.getByRole("button", { name: "Save deck" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "PATCH",
        "/api/orgs/acme/spaces/platform-team/decks/d2",
        { name: "Fibonacci", cards: ["1", "2", "3", "5", "8"], ordinal: false },
      ]),
    );
  });

  it("has no axe violations, editing form open", async () => {
    const { container } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit: House deck" }));
    await expectNoViolations(container);
  });
});
