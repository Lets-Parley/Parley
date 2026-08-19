import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultsPanel, heroOf } from "./ResultsPanel";
import type { Results } from "../lib/api";

const results = (over: Partial<Results> = {}): Results => ({
  histogram: [],
  consensus: false,
  ...over,
});

describe("heroOf", () => {
  it("leads with the agreed number on consensus", () => {
    const h = heroOf(results({ consensus: true, histogram: [{ value: "5", count: 4 }] }));
    expect(h).toMatchObject({ value: "5", save: "5", label: "consensus" });
    expect(h.sub).toBe("4 of 4 picked 5");
  });

  it("shows the coffee glyph but saves nothing from it", () => {
    // A room that only played specials has a hero to show and no estimate
    // worth writing onto the story.
    const h = heroOf(results({ consensus: true, histogram: [{ value: "coffee", count: 3 }] }));
    expect(h.value).toBe("☕");
    expect(h.save).toBeUndefined();
  });

  it("saves nothing from a unanimous question mark either", () => {
    const h = heroOf(results({ consensus: true, histogram: [{ value: "?", count: 2 }] }));
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
    );
    expect(h).toMatchObject({ value: "5", save: "5", label: "median" });
    expect(h.sub).toBe("average 4.3 · mode 5 · 3 votes");
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
    );
    expect(h).toMatchObject({ value: "M", save: "M", label: "mode" });
    expect(h.sub).toContain("ordinal deck, no average");
    expect(h.sub).not.toContain("average 4");
    expect(h.sub).toMatch(/^range S–M · 4 votes/);
  });

  it("says vote, singular, for a single voter", () => {
    const h = heroOf(results({ histogram: [{ value: "M", count: 1 }], mode: "M" }));
    expect(h.sub).toContain("1 vote ");
  });

  it("rounds the average to one place instead of printing float noise", () => {
    const h = heroOf(results({ histogram: [{ value: "1", count: 3 }], median: 2, average: 2.6666 }));
    expect(h.sub).toContain("average 2.7");
  });

  it("degrades to an em dash rather than undefined when there is nothing to show", () => {
    expect(heroOf(results({ consensus: true })).value).toBe("—");
    expect(heroOf(results()).value).toBe("—");
  });
});

describe("ResultsPanel", () => {
  it("celebrates a consensus round", () => {
    render(<ResultsPanel results={results({ consensus: true, histogram: [{ value: "8", count: 3 }] })} />);
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
      />,
    );
    expect(screen.getByText("8 ×2 · most picked")).toBeTruthy();
    expect(screen.queryByText("3 ×1 · most picked")).toBeNull();
  });
});
