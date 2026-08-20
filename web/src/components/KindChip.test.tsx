import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { KindChip } from "./KindChip";

/** The chip is the only element the component renders. */
function chip(kind: string, size?: "sm" | "md") {
  const { container } = render(<KindChip kind={kind} size={size} />);
  return container.firstElementChild as HTMLElement;
}

describe("KindChip", () => {
  // Strict equality, not toContain: a chip that still rendered the raw wire
  // id somewhere in its text would satisfy a substring assertion.
  it("names a known kind by its label, not its wire id", () => {
    expect(chip("poker").textContent).toBe("Poker");
    expect(chip("standup").textContent).toBe("Standup");
  });

  // The two cards are the poker glyph. Dropping one, or swapping the standup
  // icon in, leaves a different shape count here.
  it("draws poker as two cards", () => {
    const svg = chip("poker").querySelector("svg")!;
    expect(svg.querySelectorAll("rect").length).toBe(2);
    expect(svg.querySelectorAll("circle").length).toBe(0);
  });

  // A head and three strokes: the body arc plus two speech arcs.
  it("draws standup as a person speaking", () => {
    const svg = chip("standup").querySelector("svg")!;
    expect(svg.querySelectorAll("circle").length).toBe(1);
    expect(svg.querySelectorAll("path").length).toBe(3);
  });

  // An unregistered kind has no glyph to draw. Never an icon-only chip, and
  // never someone else's icon: text alone, and the wire id at that.
  it("gives an unknown kind the wire id and no glyph", () => {
    const el = chip("acme.retro");
    expect(el.textContent).toBe("acme.retro");
    expect(el.querySelector("svg")).toBe(null);
  });

  // The glyph inherits the label's colour, so the two can never disagree —
  // a hardcoded hex or a var(--color-*) would let them drift apart.
  it("strokes every glyph in currentColor", () => {
    for (const kind of ["poker", "standup"]) {
      const svg = chip(kind).querySelector("svg")!;
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
    }
  });

  // Two real sizes: the sidebar's tight chip and the space page's roomier one.
  it("pads the small size tighter than the default", () => {
    const sm = chip("poker", "sm").className;
    expect(sm).toContain("px-1.5");
    expect(sm).not.toContain("px-2.5");
    expect(chip("poker").className).toContain("px-2.5");
  });
});
