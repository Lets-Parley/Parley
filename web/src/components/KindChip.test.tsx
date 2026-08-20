import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KindChip } from "./KindChip";
import { KINDS } from "../lib/kinds";

/** The chip is the only element the component renders. */
function chip(kind: string, size?: "sm" | "md") {
  const { container } = render(<KindChip kind={kind} size={size} />);
  return container.firstElementChild as HTMLElement;
}

/*
 * The glyphs are line art at 14px, where the failure mode is geometric, not
 * structural: two strokes drawn closer together than the 1.25 they are stroked
 * with fuse into one smudge, and a tag count cannot see that. So the tests
 * below sample each drawn element into points in viewBox space and assert
 * about the distances between them. Anything the sampler cannot read — a path
 * command other than the arcs used here, or a `transform` that would move a
 * shape out from under its own coordinates — is a failure rather than a skip:
 * a glyph the tests cannot measure is a glyph they cannot defend.
 */
type Pt = [number, number];
const STROKE = 1.25;
/** Neighbouring centrelines must clear the stroke width plus a visible gap. */
const MIN_GAP = 1.9;
const N = 96;

function num(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  if (raw === null) throw new Error(`<${el.tagName}> is missing ${name}`);
  return Number(raw);
}

function arc(p0: Pt, p1: Pt, r: number, laf: number, sweep: number): Pt[] {
  const [dx, dy] = [p1[0] - p0[0], p1[1] - p0[1]];
  const d = Math.hypot(dx, dy);
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0));
  const sign = laf !== sweep ? 1 : -1;
  const cx = (p0[0] + p1[0]) / 2 + (sign * h * -dy) / d;
  const cy = (p0[1] + p1[1]) / 2 + (sign * h * dx) / d;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  let a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  if (sweep === 1 && a1 < a0) a1 += 2 * Math.PI;
  if (sweep === 0 && a1 > a0) a1 -= 2 * Math.PI;
  return Array.from({ length: N + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / N;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** One `M x y a rx ry rot laf sweep dx dy` arc — the speech arc's shape. */
const ARC =
  /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*a\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([01])[\s,]+([01])[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$/;

/*
 * `M x y V vy A r r rot laf sweep ax ay H hx` — a vertical leg, a rounded
 * corner, a horizontal leg: the top-right corner of the card behind the poker
 * card. Kept as narrow as ARC on purpose. The sampler measures the corner's
 * real curve rather than the sharp corner it sits inside, so the diagonal
 * clearance from the front card is measured where it is actually tightest.
 */
const CORNER =
  /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*V\s*(-?[\d.]+)\s*A\s*([\d.]+)[\s,]+([\d.]+)[\s,]+(-?[\d.]+)[\s,]+([01])[\s,]+([01])[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*H\s*(-?[\d.]+)\s*$/;

function line(p0: Pt, p1: Pt): Pt[] {
  return Array.from({ length: N + 1 }, (_, i) => [
    p0[0] + ((p1[0] - p0[0]) * i) / N,
    p0[1] + ((p1[1] - p0[1]) * i) / N,
  ]);
}

/*
 * A `transform` on a shape — or on any <g> between it and the <svg> — moves
 * the drawn stroke away from the coordinates the sampler reads, so every
 * distance below would be measured against a picture that is not on screen.
 * The glyphs use none, and should not start: refuse to measure rather than
 * pass a glyph blind.
 */
function assertUntransformed(el: Element, svg: Element): void {
  for (let node: Element | null = el; node && node !== svg; node = node.parentElement) {
    if (node.hasAttribute("transform"))
      throw new Error(`<${node.tagName}> carries a transform the sampler cannot resolve`);
  }
}

function samples(el: Element): Pt[] {
  switch (el.tagName.toLowerCase()) {
    case "rect": {
      // `rx` is ignored: the sampler traces the sharp corner the rounded one
      // sits inside. That understates a corner's clearance from a neighbour
      // and overstates the shape's extent, so both the gap floor and the
      // in-box bound stay conservative — never falsely green.
      const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => num(el, a));
      return Array.from({ length: N + 1 }, (_, i) => {
        const t = ((i / N) * 2 * (w + h)) % (2 * (w + h));
        if (t < w) return [x + t, y] as Pt;
        if (t < w + h) return [x + w, y + t - w] as Pt;
        if (t < 2 * w + h) return [x + 2 * w + h - t, y + h] as Pt;
        return [x, y + 2 * (w + h) - t] as Pt;
      });
    }
    case "circle": {
      const [cx, cy, r] = ["cx", "cy", "r"].map((a) => num(el, a));
      return Array.from({ length: N + 1 }, (_, i) => {
        const a = (2 * Math.PI * i) / N;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
      });
    }
    case "line": {
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((a) => num(el, a));
      return line([x1, y1], [x2, y2]);
    }
    case "path": {
      const d = el.getAttribute("d") ?? "";
      const a = ARC.exec(d);
      if (a) {
        const n = a.slice(1).map(Number);
        return arc([n[0], n[1]], [n[0] + n[7], n[1] + n[8]], n[2], n[5], n[6]);
      }
      const c = CORNER.exec(d);
      if (c) {
        const n = c.slice(1).map(Number);
        const [x, y, vy, r, ry, rot, laf, sweep, ax, ay, hx] = n;
        // The sampler draws a circular corner. An ellipse or a rotated arc
        // would be measured against a curve that is not the one on screen.
        if (ry !== r || rot !== 0)
          throw new Error(`corner arc is not circular and unrotated: rx=${r} ry=${ry} rot=${rot}`);
        return [
          ...line([x, y], [x, vy]),
          ...arc([x, vy], [ax, ay], r, laf, sweep),
          ...line([ax, ay], [hx, ay]),
        ];
      }
      throw new Error(`path is not a shape the sampler can measure: ${d}`);
    }
    default:
      throw new Error(`unmeasurable element <${el.tagName}> in a glyph`);
  }
}

/*
 * The only class the shipped glyphs put on the root. Anything beyond it — a
 * `scale-[0.3] rotate-45`, or a `style` transform — displaces or resizes the
 * whole picture without touching a single coordinate the sampler reads, so
 * every distance below would again be measured against a picture that is not
 * on screen. `assertUntransformed` stops one element short of catching that:
 * `querySelectorAll("*")` is descendants only, and the bare `transform`
 * attribute is not how Tailwind moves anything.
 */
const ROOT_CLASS = "shrink-0";

function assertRootUndisplaced(svg: Element): void {
  if (svg.hasAttribute("transform")) throw new Error("<svg> carries a transform the sampler cannot resolve");
  // The sampler works in viewBox units. A root box that disagrees with the
  // viewBox scales every measurement it takes, so a glyph shrunk to a speck
  // would clear a gap floor it never really clears.
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
  if (box.length !== 4 || box[0] !== "0" || box[1] !== "0")
    throw new Error(`<svg> viewBox is not measurable from the origin: ${svg.getAttribute("viewBox")}`);
  if (svg.getAttribute("width") !== box[2] || svg.getAttribute("height") !== box[3])
    throw new Error(
      `<svg> is drawn at ${svg.getAttribute("width")}x${svg.getAttribute("height")} but measured at ${box[2]}x${box[3]}`,
    );
  if (svg.hasAttribute("style")) throw new Error("<svg> carries a style attribute the sampler cannot resolve");
  const cls = (svg.getAttribute("class") ?? "").trim();
  if (cls !== ROOT_CLASS)
    throw new Error(`<svg> carries classes beyond "${ROOT_CLASS}" the sampler cannot resolve: ${cls}`);
}

function shapes(kind: string): { el: Element; pts: Pt[] }[] {
  const svg = chip(kind).querySelector("svg")!;
  assertRootUndisplaced(svg);
  return [...svg.querySelectorAll("rect, circle, line, path, polyline, polygon, ellipse")].map((el) => {
    assertUntransformed(el, svg);
    return { el, pts: samples(el) };
  });
}

function minDistance(a: Pt[], b: Pt[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return best;
}

function extent(pts: Pt[]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/*
 * Derived, never restated: every registered kind is rendered once and kept if
 * it actually draws a glyph. A kind added to `KINDS` with an icon is covered
 * by the geometry and colour tests below from the moment it exists — which is
 * the step `contributing.mdx` tells a contributor to take.
 */
const KINDS_WITH_GLYPHS = KINDS.filter((k) => {
  const has = chip(k.id).querySelector("svg") !== null;
  cleanup();
  return has;
}).map((k) => k.id);

describe("KindChip", () => {
  // `it.each([])` reports a clean pass with the cases silently missing. If the
  // derivation above ever finds nothing to measure, that is a failure.
  it("finds at least one kind that draws a glyph", () => {
    expect(KINDS_WITH_GLYPHS.length).toBeGreaterThan(0);
  });

  // Strict equality, not toContain: a chip that still rendered the raw wire
  // id somewhere in its text would satisfy a substring assertion.
  it("names a known kind by its label, not its wire id", () => {
    expect(chip("poker").textContent).toBe("Poker");
    expect(chip("standup").textContent).toBe("Standup");
  });

  // The shape counts still matter — they are what keeps the poker glyph from
  // quietly becoming the standup one — but on their own they are satisfied by
  // any two marks at all, which is what the geometry tests below exist for.
  it("draws poker as a card and the corner of the one behind it", () => {
    const svg = chip("poker").querySelector("svg")!;
    expect(svg.querySelectorAll("rect").length).toBe(1);
    expect(svg.querySelectorAll("path").length).toBe(1);
    expect(svg.querySelectorAll("line").length).toBe(0);
    expect(svg.querySelectorAll("circle").length).toBe(0);
    // A bar is what shipped first and what read as a sidebar. The corner is the
    // whole point of the redraw, so measure it rather than naming it: a bar with
    // a token 0.1-unit hook satisfies /A/ and still reads as a sidebar. Both
    // legs have to be long enough to see.
    const d = svg.querySelector("path")!.getAttribute("d")!;
    const c = CORNER.exec(d);
    expect(c).toBeTruthy();
    const [x, y, vy, , , , , , ax, ay, hx] = c!.slice(1).map(Number);
    expect(Math.abs(vy - y)).toBeGreaterThanOrEqual(1.5);
    expect(Math.abs(hx - ax)).toBeGreaterThanOrEqual(1.5);
    // …and the corner has to sit above and right of the front card, or it is
    // not the card behind: it is a bracket stuck on the side.
    const front = svg.querySelector("rect")!;
    expect(x).toBeGreaterThan(Number(front.getAttribute("x")) + Number(front.getAttribute("width")) - 1);
    expect(Math.min(y, vy)).toBeLessThan(Number(front.getAttribute("y")));
  });

  it("draws standup as a person speaking", () => {
    const svg = chip("standup").querySelector("svg")!;
    expect(svg.querySelectorAll("circle").length).toBe(1);
    expect(svg.querySelectorAll("path").length).toBe(2);
  });

  // The whole point of the glyphs. Two strokes closer together than the width
  // they are stroked with do not read as two strokes at 14px, they read as one
  // blob — which is exactly what shipped the first time these were drawn.
  it.each(KINDS_WITH_GLYPHS)("keeps every stroke in the %s glyph clear of its neighbours", (kind) => {
    const drawn = shapes(kind);
    expect(drawn.length).toBeGreaterThan(1);
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const gap = minDistance(drawn[i].pts, drawn[j].pts);
        expect(
          gap,
          `<${drawn[i].el.tagName}> and <${drawn[j].el.tagName}> are ${gap.toFixed(2)} apart, under the ${STROKE} they are stroked with`,
        ).toBeGreaterThanOrEqual(MIN_GAP);
      }
    }
  });

  // A stroke that leaves the viewBox is clipped; a mark a couple of units
  // across is a speck rather than a shape. Either one passes a tag count.
  it.each(KINDS_WITH_GLYPHS)("draws the %s glyph at a legible size inside the box", (kind) => {
    const drawn = shapes(kind);
    for (const { el, pts } of drawn) {
      const b = extent(pts);
      expect(Math.min(b.x0, b.y0), `<${el.tagName}> is stroked off the edge of the box`).toBeGreaterThanOrEqual(STROKE / 2);
      expect(Math.max(b.x1, b.y1), `<${el.tagName}> is stroked off the edge of the box`).toBeLessThanOrEqual(14 - STROKE / 2);
      expect(
        Math.max(b.x1 - b.x0, b.y1 - b.y0),
        `<${el.tagName}> spans under 3 units — a speck, not a shape`,
      ).toBeGreaterThanOrEqual(3);
    }
    const all = extent(drawn.flatMap((s) => s.pts));
    expect(all.x1 - all.x0).toBeGreaterThanOrEqual(7);
    expect(all.y1 - all.y0).toBeGreaterThanOrEqual(7);
  });

  // An unregistered kind has no glyph to draw. Never an icon-only chip, and
  // never someone else's icon: text alone, and the wire id at that.
  it("gives an unknown kind the wire id and no glyph", () => {
    const el = chip("acme.retro");
    expect(el.textContent).toBe("acme.retro");
    expect(el.querySelector("svg")).toBe(null);
  });

  // The glyph inherits the label's colour, so the two can never disagree — a
  // hardcoded hex or a var(--color-*) would let them drift apart. Checked on
  // every drawn element, not just the root: an override on one shape inside
  // the svg is exactly the drift this is here to catch.
  it.each(KINDS_WITH_GLYPHS)("strokes every part of the %s glyph in currentColor", (kind) => {
    const svg = chip(kind).querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke-width")).toBe(String(STROKE));
    // The root is inside the guard too: a `style` or an extra utility class on
    // it restyles or displaces every stroke at once.
    expect(svg.getAttribute("style")).toBe(null);
    expect(svg.getAttribute("class")).toBe(ROOT_CLASS);
    for (const el of svg.querySelectorAll("*")) {
      for (const attr of ["stroke", "fill", "stroke-width", "color", "style", "class"]) {
        expect(el.getAttribute(attr), `<${el.tagName}> overrides ${attr} instead of inheriting it`).toBe(null);
      }
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
