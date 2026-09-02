import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Hand } from "./Hand";

const deck = ["1", "2", "3", "5", "coffee"];

function renderHand(over: Partial<Parameters<typeof Hand>[0]> = {}) {
  const onPick = vi.fn();
  const onToggleSpectate = vi.fn();
  render(
    <Hand
      values={deck}
      deckName="fibonacci"
      selected={null}
      spectating={false}
      canSpectate
      status="live"
      onPick={onPick}
      onToggleSpectate={onToggleSpectate}
      {...over}
    />,
  );
  return { onPick, onToggleSpectate };
}

describe("Hand", () => {
  it("deals one button per card, coffee rendered as its glyph", () => {
    renderHand();
    expect(screen.getAllByRole("button")).toHaveLength(deck.length + 1); // + spectate
    expect(screen.getByRole("button", { name: "☕" })).toBeTruthy();
  });

  it("reports the card you pick", async () => {
    const { onPick } = renderHand();
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onPick).toHaveBeenCalledWith("5");
  });

  it("labels the hand region with its own heading", () => {
    renderHand();
    expect(screen.getByRole("region", { name: /YOUR HAND/ })).toBeTruthy();
  });

  it("keeps the picked-card confirmation visible at every breakpoint", () => {
    renderHand({ selected: "5" });
    const confirmation = screen.getByText("picked 5");
    expect(confirmation.className.includes("sr-only")).toBe(false);
    expect(confirmation.className.includes("sm:hidden")).toBe(false);
  });

  it("marks the picked card as pressed", () => {
    renderHand({ selected: "3" });
    expect(screen.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "5" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the pressed state once the hand is locked, so a revealed round reads as settled", () => {
    renderHand({ selected: "3", disabled: true });
    expect(screen.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a disabled card face readable while it still reads as disabled", () => {
    renderHand({ disabled: true });
    const card = screen.getByRole("button", { name: "5" });
    // opacity-45 composited the face down to 2.77:1 in the light theme.
    expect(card.className).toMatch(/\bopacity-70\b/);
    expect(card.className).toMatch(/cursor-not-allowed/);
  });

  it("refuses picks while disabled", async () => {
    const { onPick } = renderHand({ disabled: true });
    const card = screen.getByRole("button", { name: "5" }) as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    await userEvent.click(card).catch(() => {});
    expect(onPick).not.toHaveBeenCalled();
  });

  it("puts the hand away at the rail and keeps the seat warm", () => {
    renderHand({ spectating: true });
    expect(screen.queryByRole("button", { name: "5" })).toBeNull();
    expect(screen.getByText(/Your seat is kept warm/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "SPECTATING · REJOIN" })).toBeTruthy();
  });

  it("offers no spectate toggle where spectating is not allowed", () => {
    renderHand({ canSpectate: false });
    expect(screen.queryByRole("button", { name: /SPECTAT/ })).toBeNull();
  });

  it("reports a spectate toggle", async () => {
    const { onToggleSpectate } = renderHand();
    await userEvent.click(screen.getByRole("button", { name: "SPECTATE" }));
    expect(onToggleSpectate).toHaveBeenCalledOnce();
  });

  it("names the deck it is dealing", () => {
    renderHand();
    expect(screen.getByText("fibonacci")).toBeTruthy();
  });
});
