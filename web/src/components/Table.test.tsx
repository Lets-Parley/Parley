import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Table, faceOf } from "./Table";
import { makePerson } from "../test/render";

describe("faceOf", () => {
  it("renders the coffee card as its glyph", () => {
    expect(faceOf("coffee")).toBe("☕");
  });

  it("passes every other card through untouched", () => {
    for (const v of ["0", "1", "5", "13", "?", "XL", "½"]) expect(faceOf(v)).toBe(v);
  });
});

const dana = makePerson({ userId: "dana", name: "Dana Whitfield" });
const marcus = makePerson({ userId: "marcus", name: "Marcus Okonjo" });
const priya = makePerson({ userId: "priya", name: "Priya Raman" });

function renderTable(over: Partial<Parameters<typeof Table>[0]> = {}) {
  return render(
    <Table
      seated={[dana, marcus, priya]}
      spectators={[]}
      online={new Set(["dana", "marcus", "priya"])}
      votedUserIds={[]}
      votes={new Map()}
      revealed={false}
      consensus={false}
      facilitatorId="dana"
      meId="dana"
      {...over}
    />,
  );
}

const field = () => screen.getByTestId("table-field");

/**
 * Scopes queries to the seat container holding the given first name.
 * When two seats share a first name — an impostor wearing a member's name —
 * pass `userId` to pick the seat by its `data-seat-user`, since a
 * document-wide `getByText` can't tell the seats apart on name alone.
 */
function seat(firstName: string, userId?: string) {
  if (userId !== undefined) {
    const container = document.querySelector(`[data-seat-user="${userId}"]`);
    if (!container) throw new Error(`could not find seat container for userId "${userId}"`);
    return within(container as HTMLElement);
  }
  const nameNode = screen.getByText(firstName);
  const container = nameNode.parentElement;
  if (!container) throw new Error(`could not find seat container for "${firstName}"`);
  return within(container);
}

describe("Table", () => {
  // A guest can redeem a link under any name, a member's included, so the seat
  // has to say which one it is. The mark comes from the server.
  it("marks a link guest's seat, even one wearing a member's name", () => {
    const impostor = makePerson({ userId: "guest", name: "Dana Whitfield", guest: true });
    renderTable({
      seated: [dana, impostor],
      online: new Set(["dana", "guest"]),
    });
    // Both seats say "Dana" — the marker has to land on the impostor's seat
    // specifically, and must not also land on the real member's.
    expect(seat("Dana", "guest").queryByText("· guest")).toBeTruthy();
    expect(seat("Dana", "dana").queryByText("· guest")).toBeNull();
  });

  it("counts votes against who could still vote while hidden", () => {
    renderTable({ votedUserIds: ["dana", "marcus"] });
    expect(screen.getByText("2 of 3 voted")).toBeTruthy();
  });

  it("lets the count reach N of N when a silent seat drops", () => {
    renderTable({ votedUserIds: ["dana", "marcus"], online: new Set(["dana", "marcus"]) });
    expect(screen.getByText("2 of 2 voted")).toBeTruthy();
  });

  it("switches to a plain total once the round is revealed", () => {
    renderTable({
      revealed: true,
      votes: new Map([
        ["dana", "5"],
        ["marcus", "8"],
      ]),
    });
    expect(screen.getByText("2 votes on the table")).toBeTruthy();
  });

  it("says vote, singular, for one", () => {
    renderTable({ revealed: true, votes: new Map([["dana", "5"]]) });
    expect(screen.getByText("1 vote on the table")).toBeTruthy();
  });

  it("shows an offline seat as away rather than as not yet voted", () => {
    renderTable({ online: new Set(["dana", "marcus"]) });
    expect(screen.getAllByText("zzz")).toHaveLength(1);
  });

  it("shows no away card for a seat that voted before dropping", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["priya"] });
    expect(screen.queryByText("zzz")).toBeNull();
  });

  it("shows card faces only once revealed", () => {
    const votes = new Map([["dana", "coffee"]]);
    const { rerender } = renderTable({ votes, votedUserIds: ["dana"] });
    expect(screen.queryByText("☕")).toBeNull();

    rerender(
      <Table
        seated={[dana, marcus, priya]}
        spectators={[]}
        online={new Set(["dana", "marcus", "priya"])}
        votedUserIds={["dana"]}
        votes={votes}
        revealed
        consensus={false}
        facilitatorId="dana"
        meId="dana"
      />,
    );
    expect(screen.getByText("☕")).toBeTruthy();
  });

  it("marks which seat is yours by first name", () => {
    renderTable();
    expect(screen.getByText("Dana")).toBeTruthy();
    expect(screen.getByText("· you")).toBeTruthy();
  });

  it("lists spectators separately and keeps them out of the count", () => {
    const nina = makePerson({ userId: "nina", name: "Nina Kowalski", spectator: true });
    renderTable({ spectators: [nina], votedUserIds: ["dana"] });
    expect(screen.getByText("spectators")).toBeTruthy();
    expect(screen.getByText("1 of 3 voted")).toBeTruthy();
  });

  it("hides the spectator rail when there are none", () => {
    renderTable();
    expect(screen.queryByText("spectators")).toBeNull();
  });

  it("gives every seat state a text equivalent on the card, tied to the right seat", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["dana"] });
    // dana: seated + online + voted -> back ("voted")
    // marcus: seated + online + not voted -> empty ("no card yet")
    // priya: seated + offline -> away ("away")
    expect(seat("Dana").getByRole("img", { name: "voted" })).toBeTruthy();
    expect(seat("Marcus").getByRole("img", { name: "no card yet" })).toBeTruthy();
    expect(seat("Priya").getByRole("img", { name: "away" })).toBeTruthy();
  });

  it("puts every revealed value into the seat's accessible name, tied to the right seat", () => {
    renderTable({
      revealed: true,
      votes: new Map([
        ["dana", "5"],
        ["marcus", "coffee"],
      ]),
    });
    expect(seat("Dana").getByRole("img", { name: "voted 5" })).toBeTruthy();
    expect(seat("Marcus").getByRole("img", { name: "voted coffee" })).toBeTruthy();
    expect(seat("Priya").getByRole("img", { name: "no card" })).toBeTruthy();
  });

  it("announces the tally without repeating a person's name per seat", () => {
    renderTable();
    expect(screen.getByRole("status").textContent).toBe("0 of 3 voted");
    expect(screen.getAllByRole("img", { name: "Dana Whitfield" })).toHaveLength(1);
  });

  it("reports 0 of 0 for an empty table rather than crashing", () => {
    renderTable({ seated: [], online: new Set() });
    expect(screen.getByText("0 of 0 voted")).toBeTruthy();
  });

  // Criterion 7. One live region, or two voices talk over each other.
  it("keeps the cue and the count in a single status element", () => {
    renderTable({ votedUserIds: ["dana"], cueState: "first-light" });
    const live = screen.getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("1 of 3 voted · first light");
  });

  it("says nothing about the light when the light is cut", () => {
    renderTable({ votedUserIds: ["dana"], cueState: null });
    expect(screen.getByRole("status").textContent).toBe("1 of 3 voted");
    expect(field().getAttribute("style")).not.toContain("--cue-");
  });

  // Criterion 8. A helper that finds something is not a helper that scopes.
  it("scopes each seat to its own marks and nobody else's", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["dana"] });
    expect(seat("Priya").getByRole("img", { name: "away" })).toBeTruthy();
    expect(seat("Dana").queryByRole("img", { name: "away" })).toBeNull();
    expect(seat("Marcus").queryByRole("img", { name: "away" })).toBeNull();
    expect(seat("Dana").queryByRole("img", { name: "no card yet" })).toBeNull();
  });

  // Criterion 9. Sibling AFTER the ranks, not inline with a divider.
  it("puts the spectator rail below the seat ranks", () => {
    const nina = makePerson({ userId: "nina", name: "Nina Kowalski", spectator: true });
    renderTable({ spectators: [nina] });
    const ranks = screen.getByTestId("seat-ranks");
    const rail = screen.getByTestId("spectator-rail");
    // FOLLOWING, and not CONTAINED_BY: inline-with-a-divider would be inside.
    const rel = ranks.compareDocumentPosition(rail);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rel & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
    expect(rail.parentElement).toBe(ranks.parentElement);
  });

  it("wraps seats into ranks instead of scrolling them sideways", () => {
    // 15 seats need two ranks at every desktop width — 74px + a 12px gap is
    // 86px a seat against a widest row of 884px. jsdom does not lay out, so
    // this asserts the mechanism, not the wrap point.
    const { container } = renderTable();
    expect(screen.getByTestId("seat-ranks").className).toContain("flex-wrap");
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
  });

  // Criterion 3. The animating ground touches exactly one element, and every
  // mark sits on a fixed-luminance token instead.
  it("keeps every mark off the animating field", () => {
    const { container } = renderTable({ votedUserIds: ["dana"], cueState: "daybreak" });
    const cued = container.querySelectorAll('[style*="--cue-"]');
    expect(cued).toHaveLength(1);
    expect(cued[0]).toBe(field());
    expect(seat("Dana").getByRole("img", { name: "voted" }).className).toContain("bg-card-back");
    expect(container.querySelector('[class*="ring-"], [class*="bg-card-back"]')).toBeTruthy();
  });

  // Criterion 4. There is no JS interpolation to stop — the arc is a CSS
  // transition, which tokens.css's reduced-motion rule already kills. What
  // this proves is that nothing schedules frames behind its back.
  it("lands straight on the target state under reduced motion", () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    renderTable({ votedUserIds: ["dana", "marcus"], cueState: "daybreak" });
    expect(field().getAttribute("data-cue")).toBe("daybreak");
    expect(field().getAttribute("style")).toContain("--cue-daybreak");
    expect(raf).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("names the field state for each step of the arc", () => {
    for (const state of ["overcast", "first-light", "daybreak", "day"] as const) {
      const { unmount } = renderTable({ cueState: state });
      expect(field().getAttribute("style")).toContain(`var(--cue-${state})`);
      unmount();
    }
  });

  it("carries the waiting count on the field, and says it only once", () => {
    // It shipped at 11px under the field — unreadable from across the room
    // it is projected into. Big on the field, spoken once by the live region.
    renderTable({ votedUserIds: ["dana"], cueState: "first-light" });
    const big = screen.getByTestId("waiting-count");
    // Pinned exact: votedCount and canVote sit on either side of the slash,
    // so a swap between them would read as plausible if only substrings were
    // checked.
    expect(big.textContent).toBe("1 / 3voted");
    expect(big.className).toContain("text-[1.5rem]");
    expect(big.className).toContain("tabular-nums");
    expect(big.getAttribute("aria-hidden")).toBe("true");
    // One live region, one voice: the count is spoken, not printed twice.
    expect(screen.getByRole("status").textContent).toContain("1 of 3");
    // Before reveal, the live-region span carrying the count must stay
    // sr-only — it duplicates what is already big on the field.
    const liveCountSpan = screen.getByRole("status").querySelector("span:first-child");
    expect(liveCountSpan?.className).toContain("sr-only");
  });

  it("hands the field back to the seats once the votes are up", () => {
    renderTable({ votedUserIds: ["dana"], revealed: true, cueState: "day" });
    expect(screen.queryByTestId("waiting-count")).toBeNull();
    // The seats stay put on reveal — this test's name promises exactly that.
    expect(screen.getByTestId("seat-ranks").children.length).toBe(3);
    // After reveal, the live-region span carrying the count must NOT be
    // sr-only — sighted users need to see it now that the big field number
    // is gone.
    const liveCountSpan = screen.getByRole("status").querySelector("span:first-child");
    expect(liveCountSpan?.className).not.toContain("sr-only");
    expect(screen.getByRole("status").textContent).toContain("1 vote on the table");
  });
});
