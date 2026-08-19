import { describe, expect, it } from "vitest";
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

/** Scopes queries to the seat container holding the given first name. */
function seat(firstName: string) {
  const nameNode = screen.getByText(firstName);
  const container = nameNode.parentElement;
  if (!container) throw new Error(`could not find seat container for "${firstName}"`);
  return within(container);
}

describe("Table", () => {
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
});
