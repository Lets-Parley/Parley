import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KindChip } from "./KindChip";

/** The token is the only element the component renders. */
function token(el: React.ReactElement) {
  const { container } = render(el);
  return container.firstElementChild as HTMLElement;
}

function classes(el: Element | null): string[] {
  expect(el, "expected an element").not.toBe(null);
  return [...el!.classList];
}

/*
 * Each kind is a small object taken from its own room: poker is the face-down
 * card the table deals, standup is the round of speakers with the current one
 * marked. The assertions name the design tokens by hand — a class list derived
 * from the component would agree with any colour it happened to use.
 */
describe("KindChip", () => {
  it("draws poker as the table's face-down card, with its pip", () => {
    const el = token(<KindChip kind="poker" />);
    const card = el.querySelector('[data-token="card"]');
    expect(classes(card)).toContain("bg-card-back");
    // Dealt, not squared up.
    expect(classes(card)).toContain("-rotate-6");
    const pip = card!.firstElementChild;
    expect(classes(pip)).toContain("border-pip");
    expect(classes(pip)).toContain("rotate-45");
    // Not a seat ring, and not the old line glyph.
    expect(el.querySelector('[data-token="round"]')).toBe(null);
    expect(el.querySelector("svg")).toBe(null);
  });

  it("draws standup as a round of four seats with one speaker in accent", () => {
    const el = token(<KindChip kind="standup" />);
    const round = el.querySelector('[data-token="round"]');
    expect(classes(round)).toContain("border-ink-soft");
    expect(classes(round)).toContain("rounded-full");
    expect(round!.querySelectorAll("[data-seat]").length).toBe(4);
    // The speaker is a marker sitting on one seat, so it can step round to
    // the next without a seat going missing behind it.
    const speaking = round!.querySelectorAll("[data-speaker]");
    expect(speaking.length).toBe(1);
    expect(classes(speaking[0])).toContain("bg-accent");
    expect(el.querySelector('[data-token="card"]')).toBe(null);
  });

  // "Poker" is a name, not data: sans, 13px, semibold, and never mono.
  it("labels a known kind in sans at 13px semibold", () => {
    const el = token(<KindChip kind="poker" />);
    expect(el.textContent).toBe("Poker");
    const cls = classes(el);
    expect(cls).toContain("text-[13px]");
    expect(cls).toContain("font-semibold");
    expect(cls).toContain("text-ink-soft");
    expect(cls).not.toContain("font-mono");
  });

  it("names standup by its label, not its wire id", () => {
    expect(token(<KindChip kind="standup" />).textContent).toBe("Standup");
  });

  // Dropping the label drops the words from the screen, never from the
  // accessibility tree: the object alone has to still say what it is.
  it("keeps the kind name for assistive tech when the label is dropped", () => {
    const el = token(<KindChip kind="poker" label={false} />);
    expect(el.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Poker" })).toBe(el);
    expect(el.querySelector('[data-token="card"]')).not.toBe(null);
  });

  it("names a label-less standup token too", () => {
    const el = token(<KindChip kind="standup" label={false} />);
    expect(el.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Standup" })).toBe(el);
  });

  // With a visible label the object is decoration: it must not add a second
  // "Poker" to whatever accessible name the row or radio computes.
  it("hides the object from assistive tech when the label is visible", () => {
    const el = token(<KindChip kind="poker" />);
    expect(el.getAttribute("role")).toBe(null);
    expect(el.querySelector('[data-token="card"]')!.getAttribute("aria-hidden")).toBe("true");
  });

  // An unregistered kind has no object to draw. Never someone else's object,
  // never an object-only token: text alone, and the wire id at that — in a
  // quiet divider-weight chip, sans, at 11px or more.
  it("gives an unknown kind a text-only chip", () => {
    const el = token(<KindChip kind="acme.retro" />);
    expect(el.textContent).toBe("acme.retro");
    expect(el.querySelector("[data-token]")).toBe(null);
    expect(el.querySelector("svg")).toBe(null);
    const cls = classes(el);
    expect(cls).toContain("border-line");
    expect(cls).toContain("text-[11px]");
    expect(cls).not.toContain("font-mono");
    expect(cls).not.toContain("border-line-strong");
  });

  it("keeps an unknown kind's text even when the label is dropped", () => {
    const el = token(<KindChip kind="acme.retro" label={false} />);
    expect(el.textContent).toBe("acme.retro");
  });

  // The picker's size: the same objects, bigger, and wired to answer hover —
  // the card squares up and lifts, the speaker steps round one seat. jsdom has
  // no layout or transitions, so this pins the classes that do it; whether the
  // motion reads well is a browser check, not this one.
  it("scales the objects up for the create dialog and carries the hover classes", () => {
    const poker = token(<KindChip kind="poker" size="lg" />);
    const card = poker.querySelector('[data-token="card"]');
    expect(classes(card)).toContain("w-[34px]");
    expect(classes(card)).toContain("group-hover:rotate-0");
    expect(classes(card)).toContain("group-hover:-translate-y-1");
    const standup = token(<KindChip kind="standup" size="lg" />);
    const speaking = standup.querySelector("[data-speaker]");
    expect(classes(speaking)).toContain("rotate-[270deg]");
    expect(classes(speaking)).toContain("group-hover:rotate-[360deg]");
  });

  // Row size stays still: a session row is a link whose own hover is the lift.
  it("does not animate the row size", () => {
    const card = token(<KindChip kind="poker" />).querySelector('[data-token="card"]');
    expect(classes(card).some((c) => c.startsWith("group-hover:"))).toBe(false);
  });
});
