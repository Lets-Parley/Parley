import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultsPanel, heroOf } from "./ResultsPanel";
import type { Results } from "../lib/api";

const results = (over: Partial<Results> = {}): Results => ({
  histogram: [],
  consensus: false,
  ...over,
});

const fib = ["1", "2", "3", "5", "8", "13", "21", "34", "?", "coffee"];
const modifiedFib = ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "coffee"];

describe("heroOf", () => {
  it("leads with the agreed number on consensus", () => {
    const h = heroOf(results({ consensus: true, histogram: [{ value: "5", count: 4 }] }), fib);
    expect(h).toMatchObject({ value: "5", save: "5", label: "consensus" });
    expect(h.sub).toBe("4 of 4 picked 5");
  });

  it("shows the coffee glyph but saves nothing from it", () => {
    // A room that only played specials has a hero to show and no estimate
    // worth writing onto the story.
    const h = heroOf(results({ consensus: true, histogram: [{ value: "coffee", count: 3 }] }), fib);
    expect(h.value).toBe("☕");
    expect(h.save).toBeUndefined();
  });

  it("saves nothing from a unanimous question mark either", () => {
    const h = heroOf(results({ consensus: true, histogram: [{ value: "?", count: 2 }] }), fib);
    expect(h.value).toBe("?");
    expect(h.save).toBeUndefined();
  });

  it("leads with the median on a split numeric round", () => {
    const h = heroOf(
      results({
        histogram: [
          { value: "3", count: 1 },
          { value: "5", count: 2 },
        ],
        median: 5,
        average: 4.333,
        mode: "5",
      }),
      fib,
    );
    expect(h).toMatchObject({ value: "5", save: "5", label: "median" });
    expect(h.sub).toBe("average 4.3 · mode 5 · 3 votes");
  });

  it("offers no save when the median falls between two cards", () => {
    // Votes of 3 and 5 on a Fibonacci deck put the median at 4, which is not a
    // card — the backend rejects it, so the room must not be offered the save.
    const h = heroOf(
      results({
        histogram: [
          { value: "3", count: 1 },
          { value: "5", count: 1 },
        ],
        median: 4,
        average: 4,
      }),
      fib,
    );
    expect(h).toMatchObject({ value: "4", label: "median" });
    expect(h.save).toBeUndefined();
  });

  it("resolves a half-point median to the ½ card on modified-fibonacci", () => {
    // Votes of 0 and 1 put the median at 0.5. String(0.5) is "0.5", which is
    // not a card — the deck face is "½", and that is what the server accepts.
    const h = heroOf(
      results({
        histogram: [
          { value: "0", count: 1 },
          { value: "1", count: 1 },
        ],
        median: 0.5,
        average: 0.5,
      }),
      modifiedFib,
    );
    expect(h).toMatchObject({ value: "½", save: "½", label: "median" });
  });

  it("never invents an average for an ordinal deck", () => {
    // "average 4.5" over S/M/L is a correctness bug visible to the whole room.
    const h = heroOf(
      results({
        histogram: [
          { value: "S", count: 1 },
          { value: "M", count: 3 },
        ],
        mode: "M",
        range: "S–M",
      }),
      ["S", "M", "L"],
    );
    expect(h).toMatchObject({ value: "M", save: "M", label: "mode" });
    expect(h.sub).toContain("ordinal deck, no average");
    expect(h.sub).not.toContain("average 4");
    expect(h.sub).toMatch(/^range S–M · 4 votes/);
  });

  it("calls an all-? round on a numeric deck 'no estimate', never 'ordinal'", () => {
    // After #363, all-specials no longer report consensus; without a dedicated
    // branch the hero falls through to the ordinal-deck copy on Fibonacci.
    const h = heroOf(results({ histogram: [{ value: "?", count: 3 }], consensus: false }), fib);
    expect(h).toMatchObject({ value: "?", label: "no estimate", save: undefined });
    expect(h.sub).toBe("3 of 3 picked ?");
    expect(h.sub).not.toContain("ordinal deck");
  });

  it("calls an all-coffee round on a numeric deck 'no estimate', never 'ordinal'", () => {
    const h = heroOf(
      results({ histogram: [{ value: "coffee", count: 2 }], consensus: false }),
      fib,
    );
    expect(h).toMatchObject({ value: "☕", label: "no estimate", save: undefined });
    expect(h.sub).toBe("2 of 2 picked ☕");
    expect(h.sub).not.toContain("ordinal deck");
  });

  it("does not claim unanimity when the room mixed ? and coffee", () => {
    // histogram[0] alone is not what everyone picked — the sub must not say
    // "N of N picked ?" (or coffee) for a mixed specials reveal.
    const h = heroOf(
      results({
        histogram: [
          { value: "?", count: 2 },
          { value: "coffee", count: 1 },
        ],
        consensus: false,
      }),
      fib,
    );
    expect(h).toMatchObject({ value: "—", label: "no estimate", save: undefined });
    expect(h.sub).toBe("3 votes · ? and ☕");
    expect(h.sub).not.toContain("ordinal deck");
  });

  it("says vote, singular, for a single voter", () => {
    const h = heroOf(results({ histogram: [{ value: "M", count: 1 }], mode: "M" }), ["M"]);
    expect(h.sub).toContain("1 vote ");
  });

  it("rounds the average to one place instead of printing float noise", () => {
    const h = heroOf(results({ histogram: [{ value: "1", count: 3 }], median: 2, average: 2.6666 }), ["1", "2", "3"]);
    expect(h.sub).toContain("average 2.7");
  });

  it("degrades to an em dash rather than undefined when there is nothing to show", () => {
    expect(heroOf(results({ consensus: true }), fib).value).toBe("—");
    expect(heroOf(results(), fib).value).toBe("—");
  });
});

describe("ResultsPanel", () => {
  it("celebrates a consensus round", () => {
    render(<ResultsPanel results={results({ consensus: true, histogram: [{ value: "8", count: 3 }] })} deck={fib} />);
    expect(screen.getByText("Consensus — nice.")).toBeTruthy();
    expect(screen.getByText("consensus")).toBeTruthy();
  });

  it("stays quiet on a split round", () => {
    render(
      <ResultsPanel
        results={results({
          histogram: [
            { value: "3", count: 1 },
            { value: "8", count: 1 },
          ],
          median: 5.5,
        })}
        deck={fib}
      />,
    );
    expect(screen.queryByText("Consensus — nice.")).toBeNull();
  });

  it("draws one labelled stack per distinct card", () => {
    render(
      <ResultsPanel
        results={results({
          histogram: [
            { value: "3", count: 1 },
            { value: "coffee", count: 2 },
          ],
          median: 3,
        })}
        deck={fib}
      />,
    );
    expect(screen.getByText("3 ×1")).toBeTruthy();
    expect(screen.getByText("☕ ×2 · most picked")).toBeTruthy();
  });

  it("marks the mode with text, not brass alone", () => {
    render(
      <ResultsPanel
        results={results({
          histogram: [
            { value: "3", count: 1 },
            { value: "8", count: 2 },
          ],
          median: 8,
        })}
        deck={fib}
      />,
    );
    expect(screen.getByText("8 ×2 · most picked")).toBeTruthy();
    expect(screen.queryByText("3 ×1 · most picked")).toBeNull();
  });

  it("shows ½ for a half-point median when given the modified-fibonacci deck", () => {
    // Without the deck, heroOf would String(0.5) and the panel would print "0.5"
    // while Save (which already passes the deck) offered "½".
    render(
      <ResultsPanel
        results={results({
          histogram: [
            { value: "0", count: 1 },
            { value: "1", count: 1 },
          ],
          median: 0.5,
          average: 0.5,
        })}
        deck={modifiedFib}
      />,
    );
    expect(screen.getByText("½")).toBeTruthy();
    expect(screen.queryByText("0.5")).toBeNull();
    expect(screen.getByText("median")).toBeTruthy();
  });
});
