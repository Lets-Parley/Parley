import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar, initialsOf } from "./Avatar";

describe("initialsOf", () => {
  it("takes first and last initials from a full name", () => {
    expect(initialsOf("Dana Whitfield")).toBe("DW");
    expect(initialsOf("Marcus Okonjo")).toBe("MO");
  });

  it("skips the middle of a three-part name", () => {
    expect(initialsOf("Nina Marie Kowalski")).toBe("NK");
  });

  it("takes two letters from a single name", () => {
    expect(initialsOf("Tomas")).toBe("TO");
  });

  it("uppercases whatever it is given", () => {
    expect(initialsOf("ben alvarez")).toBe("BA");
  });

  it("handles a one-letter name without running off the end", () => {
    expect(initialsOf("x")).toBe("X");
  });

  it("collapses stray whitespace rather than reading it as a name part", () => {
    expect(initialsOf("  Priya   Raman  ")).toBe("PR");
  });

  it("falls back to a question mark rather than rendering nothing", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });

  it("passes non-ASCII names through", () => {
    expect(initialsOf("Émile Zola")).toBe("ÉZ");
  });
});

describe("Avatar", () => {
  it("labels itself with the name so the chip is not a mystery to a screen reader", () => {
    render(<Avatar name="Dana Whitfield" hue={200} />);
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });

  it("marks the facilitator", () => {
    render(<Avatar name="Dana Whitfield" hue={200} facilitator />);
    expect(screen.getByRole("img", { name: "facilitator" })).toBeTruthy();
  });

  it("does not mark an ordinary seat", () => {
    render(<Avatar name="Dana Whitfield" hue={200} />);
    expect(screen.queryByLabelText("facilitator")).toBeNull();
  });

  it("normalizes a negative hue into the maritime arc rather than emitting a negative angle", () => {
    render(<Avatar name="Dana Whitfield" hue={-30} />);
    const bg = screen.getByLabelText("Dana Whitfield").style.background;
    const angle = Number(/([-\d.]+)\)$/.exec(bg.trim())?.[1]);
    expect(angle).toBeGreaterThanOrEqual(185);
    expect(angle).toBeLessThanOrEqual(290);
  });

  it("dims a spectator and an offline seat", () => {
    const { rerender } = render(<Avatar name="A B" hue={1} spectator />);
    expect(screen.getByLabelText("A B").style.opacity).toBe("0.7");
    rerender(<Avatar name="A B" hue={1} dim />);
    expect(screen.getByLabelText("A B").style.opacity).toBe("0.7");
    rerender(<Avatar name="A B" hue={1} />);
    expect(screen.getByLabelText("A B").style.opacity).toBe("1");
  });
});

describe("Avatar icons", () => {
  it("draws the chosen glyph instead of the initials", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="anchor" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("");
  });

  it("keeps one accessible name — the glyph itself is hidden", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="anchor" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("renders initials for an id it does not know rather than a blank chip", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="unicorn" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });

  it("renders initials at xs, where a silhouette has no clear area to live in", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="anchor" size="xs" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });

  it("renders initials when nothing was ever chosen", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });
});

describe("Avatar accessories", () => {
  it("overlays the chosen accessory from sm up", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const { container, unmount } = render(
        <Avatar name="Dana Whitfield" hue={200} icon="anchor" accessory="captain" size={size} />,
      );
      expect(container.querySelector('[data-accessory="captain"]')).toBeTruthy();
      unmount();
    }
  });

  it("suppresses the accessory at xs, alongside the glyph", () => {
    const { container } = render(
      <Avatar name="Dana Whitfield" hue={200} icon="anchor" accessory="captain" size="xs" />,
    );
    expect(container.querySelector("[data-accessory]")).toBeNull();
    expect(screen.getByRole("img", { name: "Dana Whitfield" }).textContent).toBe("DW");
  });

  it("renders no overlay for an id it does not know, and leaves the chip intact", () => {
    const { container } = render(
      <Avatar name="Dana Whitfield" hue={200} icon="anchor" accessory="sombrero" />,
    );
    expect(container.querySelector("[data-accessory]")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("renders nothing extra when no accessory was chosen", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} icon="anchor" />);
    expect(container.querySelector("[data-accessory]")).toBeNull();
  });

  it("keeps the overlay out of the bottom-right quadrant where the facilitator dot sits", () => {
    const px = 38; // md
    const { container } = render(
      <Avatar name="Dana Whitfield" hue={200} accessory="captain" facilitator size="md" />,
    );
    const el = container.querySelector("[data-accessory]") as HTMLElement;
    // Anchored to the top edge, and no taller than half the disc: the box can
    // never reach the bottom half, which is where the dot lives.
    expect(el.style.top).toBe("0px");
    expect(el.style.bottom).toBe("");
    expect(parseFloat(el.style.top) + parseFloat(el.style.height)).toBeLessThanOrEqual(px / 2);
    // And the dot really is in that bottom-right corner.
    const dot = screen.getByLabelText("facilitator") as HTMLElement;
    expect(dot.className).toContain("-right-px");
    expect(dot.className).toContain("-bottom-px");
  });

  it("adds no opacity of its own, so a dimmed chip dims the overlay with it", () => {
    const { container } = render(
      <Avatar name="Dana Whitfield" hue={200} accessory="captain" spectator />,
    );
    const el = container.querySelector("[data-accessory]") as HTMLElement;
    expect(el.style.opacity).toBe("");
    expect(screen.getByLabelText("Dana Whitfield").style.opacity).toBe("0.7");
  });

  it("hides the overlay from the accessibility tree", () => {
    const { container } = render(<Avatar name="Dana Whitfield" hue={200} accessory="captain" />);
    expect(container.querySelector("[data-accessory] svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });
});
