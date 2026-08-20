import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { KindChip } from "./KindChip";

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
 * command other than the arcs used here — is a failure rather than a skip:
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

/** One `M x y a rx ry rot laf sweep dx dy` arc — the only path shape drawn. */
const ARC =
  /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*a\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([01])[\s,]+([01])[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$/;

function samples(el: Element): Pt[] {
  switch (el.tagName.toLowerCase()) {
    case "rect": {
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
      return Array.from({ length: N + 1 }, (_, i) => [
        x1 + ((x2 - x1) * i) / N,
        y1 + ((y2 - y1) * i) / N,
      ]);
    }
    case "path": {
      const m = ARC.exec(el.getAttribute("d") ?? "");
      if (!m) throw new Error(`path is not a single arc the sampler can measure: ${el.getAttribute("d")}`);
      const n = m.slice(1).map(Number);
      return arc([n[0], n[1]], [n[0] + n[7], n[1] + n[8]], n[2], n[5], n[6]);
    }
    default:
      throw new Error(`unmeasurable element <${el.tagName}> in a glyph`);
  }
}

function shapes(kind: string): { el: Element; pts: Pt[] }[] {
  const svg = chip(kind).querySelector("svg")!;
  return [...svg.querySelectorAll("rect, circle, line, path, polyline, polygon, ellipse")].map((el) => ({
    el,
    pts: samples(el),
  }));
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

const KINDS_WITH_GLYPHS = ["poker", "standup"];

describe("KindChip", () => {
  // Strict equality, not toContain: a chip that still rendered the raw wire
  // id somewhere in its text would satisfy a substring assertion.
  it("names a known kind by its label, not its wire id", () => {
    expect(chip("poker").textContent).toBe("Poker");
    expect(chip("standup").textContent).toBe("Standup");
  });

  // The shape counts still matter — they are what keeps the poker glyph from
  // quietly becoming the standup one — but on their own they are satisfied by
  // any two marks at all, which is what the geometry tests below exist for.
  it("draws poker as a card and the edge behind it", () => {
    const svg = chip("poker").querySelector("svg")!;
    expect(svg.querySelectorAll("rect").length).toBe(1);
    expect(svg.querySelectorAll("line").length).toBe(1);
    expect(svg.querySelectorAll("circle").length).toBe(0);
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
    for (const el of svg.querySelectorAll("*")) {
      for (const attr of ["stroke", "fill", "stroke-width", "color", "style"]) {
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
