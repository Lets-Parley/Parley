import { describe, expect, it } from "vitest";
import { dropBounce } from "./physics";
import {
  DROP_DISTANCE_PX,
  FLIP_MS,
  PILE_ON_EMOJI,
  joinBeats,
  pileOnBeats,
  pileOnOutlier,
  planDropIn,
  planPileOn,
  revealSettledAt,
  resultStampsAt,
  flipEndsAt,
  flipStartsAt,
  hopStartsAt,
  CARD_FLIP_MS,
  CARD_HOP_MS,
  FLIP_STAGGER_MS,
  staggerFor,
  KICK_REFLOW_MS,
  planKick,
} from "./plan";

const ballots = (values: string[]) => values.map((value, i) => ({ userId: `u${i}`, value }));

describe("pileOnOutlier", () => {
  it("names the single dissenter", () => {
    expect(pileOnOutlier(ballots(["5", "5", "5", "8"]))).toBe("u3");
    expect(pileOnOutlier(ballots(["3", "5", "5", "5", "5"]))).toBe("u0");
  });

  it("is null at unanimity", () => {
    expect(pileOnOutlier(ballots(["5", "5", "5", "5"]))).toBeNull();
  });

  it("is null with two or more dissenters", () => {
    expect(pileOnOutlier(ballots(["5", "5", "8", "13"]))).toBeNull();
    expect(pileOnOutlier(ballots(["5", "5", "8", "8"]))).toBeNull();
  });

  it("is null when the majority value is a special card", () => {
    // Mirrors internal/poker/stats.go, which excludes ? and coffee from
    // consensus: a room that shrugged has not agreed on an estimate.
    expect(pileOnOutlier(ballots(["?", "?", "?", "5"]))).toBeNull();
    expect(pileOnOutlier(ballots(["coffee", "coffee", "coffee", "5"]))).toBeNull();
    // A special card as the *dissent* is still a dissent.
    expect(pileOnOutlier(ballots(["5", "5", "5", "?"]))).toBe("u3");
  });

  it("is null below four eligible voters", () => {
    expect(pileOnOutlier(ballots(["5", "5", "8"]))).toBeNull();
    expect(pileOnOutlier(ballots(["5", "8"]))).toBeNull();
    expect(pileOnOutlier([])).toBeNull();
  });
});

describe("beats", () => {
  /* These expectations are LITERALS on purpose, worked out by hand from the
     beat sheet's documented constants (stagger 70, flip 300, hop 420, result
     beat 90, settle beat 60):

       flipStartsAt(i)    = i*70
       flipEndsAt(n)      = (n-1)*70 + 300
       hopStartsAt(i)     = i*70 + 300
       resultStampsAt(n)  = (n-1)*70 + 390
       revealSettledAt(n) = (n-1)*70 + 780

     Deriving them from the same symbols the implementation uses would make
     every assertion here a tautology that passes for any value — including a
     negative hop duration. If you change a constant in plan.ts, these numbers
     are supposed to fail; recompute them deliberately rather than reaching for
     the exported constant to make the red go away. */
  it("puts each card's flip on the stagger", () => {
    expect(flipStartsAt(0)).toBe(0);
    expect(flipStartsAt(1)).toBe(70);
    expect(flipStartsAt(7)).toBe(490);
  });

  it("hops each card exactly as it lands, never on a separate clock", () => {
    expect(hopStartsAt(0)).toBe(300);
    expect(hopStartsAt(1)).toBe(370);
    expect(hopStartsAt(7)).toBe(790);
    // The hop is the landing, so it starts where the flip ends.
    for (const i of [0, 1, 7]) {
      expect(hopStartsAt(i)).toBe(flipStartsAt(i) + CARD_FLIP_MS);
    }
  });

  it("shares one reveal-clearing expression with the high-five", () => {
    expect(revealSettledAt(1)).toBe(780);
    expect(revealSettledAt(6)).toBe(1130);
    expect(revealSettledAt(0)).toBe(revealSettledAt(1));
  });

  it("lands every card face-up before the result stamps in", () => {
    expect(flipEndsAt(6)).toBe(650);
    expect(resultStampsAt(6)).toBe(740);
    expect(resultStampsAt(1)).toBe(390);
    for (const n of [1, 2, 6, 15]) {
      // The number is the closing beat of the reveal: after the last card is
      // face-up, before the table has finished settling.
      expect(resultStampsAt(n)).toBeGreaterThan(flipEndsAt(n));
      expect(resultStampsAt(n)).toBeLessThan(revealSettledAt(n));
    }
  });

  it("keeps the hop long enough to still be running when the result lands", () => {
    // A literal guard on CARD_HOP_MS itself: without one, every relative
    // assertion above survives a nonsense value.
    expect(CARD_HOP_MS).toBe(420);
    expect(CARD_FLIP_MS).toBe(300);
    expect(FLIP_STAGGER_MS).toBe(70);
  });

  it("spends one budgeted stagger, however many throwers", () => {
    expect(staggerFor(1)).toBe(0);
    expect(staggerFor(5)).toBe(105);
    expect(staggerFor(13)).toBe(35);
    expect(pileOnBeats(6, 5)).toEqual({ start: revealSettledAt(6), stagger: 105 });
  });
});

const geom = (throwerCount: number) => ({
  seatCount: throwerCount + 1,
  target: { center: { x: 400, y: 200 }, radius: 23 },
  emojiRadius: 12,
  bounds: {
    box: { width: 24, height: 24 },
    viewport: { width: 900, height: 500 },
    offset: { x: 0, y: 0 },
  },
  throwers: Array.from({ length: throwerCount }, (_, i) => ({
    center: { x: 40 + i * 86, y: 200 },
    radius: 23,
  })),
});

describe("planPileOn", () => {
  it("throws exactly one emoji per other seat", () => {
    const plan = planPileOn(geom(7));
    expect(plan.throws).toHaveLength(7);
    for (const t of plan.throws) expect(PILE_ON_EMOJI).toContain(t.emoji);
  });

  it("is deterministic, so a websocket repaint cannot restart a throw", () => {
    expect(planPileOn(geom(7))).toEqual(planPileOn(geom(7)));
  });

  it("staggers unevenly, so no two impacts land on the same beat", () => {
    const plan = planPileOn(geom(5));
    const delays = plan.throws.map((t) => t.delayMs);
    const gaps = delays.slice(1).map((d, i) => d - delays[i]);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBe(gaps.length);
    // Impacts, not just releases: what the eye reads is when they land.
    const impacts = plan.throws.map((t) => t.delayMs + t.impactMs).sort((a, b) => a - b);
    const between = impacts.slice(1).map((d, i) => d - impacts[i]);
    expect(new Set(between.map((g) => g.toFixed(3))).size).toBe(between.length);
  });

  it("still spends exactly the budgeted stagger and reports the caller's beats", () => {
    const plan = planPileOn(geom(5));
    const { start, stagger } = pileOnBeats(6, 5);
    const delays = plan.throws.map((t) => t.delayMs);
    expect(delays[0]).toBe(start);
    expect(delays[delays.length - 1]).toBeCloseTo(start + stagger * 4, 6);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    expect(plan.impactMs).toBe(Math.min(...plan.throws.map((t) => t.delayMs + t.impactMs)));
    expect(plan.endMs).toBe(Math.max(...plan.throws.map((t) => t.delayMs + t.durationMs)));
  });

  it("releases from the thrower's edge, aimed at the target", () => {
    const plan = planPileOn(geom(1));
    // The one thrower sits 360px to the left at the same height, so the
    // release point is exactly its own radius along that line.
    expect(plan.throws[0].originX).toBeCloseTo(40 + 23, 6);
    expect(plan.throws[0].originY).toBeCloseTo(200, 6);
  });

  it("plans nothing when nobody is left to throw", () => {
    const plan = planPileOn(geom(0));
    expect(plan.throws).toHaveLength(0);
    expect(plan.endMs).toBe(0);
  });
});

describe("joinBeats", () => {
  it("leads with the FLIP so the row is open before the fall starts", () => {
    expect(joinBeats(5, 1, false).start).toBe(FLIP_MS);
  });

  it("waits out a reveal rather than dropping under turning cards", () => {
    expect(joinBeats(5, 1, true).start).toBe(revealSettledAt(5) + FLIP_MS);
  });

  it("spends the same stagger budget as every other group animation", () => {
    expect(joinBeats(5, 12, false).stagger).toBe(staggerFor(12));
  });
});

describe("planDropIn", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `u${i}`);

  it("resolves a dozen joiners inside 420ms plus one drop", () => {
    const plan = planDropIn({ joined: twelve, seatCount: 12, revealed: false });
    expect(plan).toHaveLength(12);
    const first = plan[0].delayMs;
    const longest = Math.max(...plan.map((d) => d.durationMs));
    // A bounded spread, not a fixed per-seat gap: a 110ms stagger would put
    // the twelfth of them on a queue more than a second long.
    expect(Math.max(...plan.map((d) => d.delayMs)) - first).toBeLessThanOrEqual(420);
    expect(Math.max(...plan.map((d) => d.delayMs + d.durationMs)) - first).toBeLessThanOrEqual(
      420 + longest + 0.001,
    );
  });

  it("lands nobody on the same beat, or from the same height", () => {
    const plan = planDropIn({ joined: twelve, seatCount: 12, revealed: false });
    const gaps = plan.slice(1).map((d, i) => d.delayMs - plan[i].delayMs);
    // A fixed gap between every pair reads as a mechanism firing, not as
    // people arriving.
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(gaps.length - 2);
    expect(new Set(plan.map((d) => d.distancePx.toFixed(3))).size).toBe(plan.length);
    // Deterministic, so the same envelope replans identically.
    expect(planDropIn({ joined: twelve, seatCount: 12, revealed: false })).toEqual(plan);
  });

  it("gives a lone joiner no stagger at all", () => {
    const [only] = planDropIn({ joined: ["dana"], seatCount: 3, revealed: false });
    expect(only).toMatchObject({ userId: "dana", delayMs: FLIP_MS });
    expect(only.durationMs).toBeCloseTo(dropBounce(only.distancePx).durationMs, 10);
    expect(only.distancePx).toBeGreaterThan(DROP_DISTANCE_PX * 0.8);
    expect(only.distancePx).toBeLessThan(DROP_DISTANCE_PX * 1.2);
  });

  it("plans nothing for nobody", () => {
    expect(planDropIn({ joined: [], seatCount: 3, revealed: false })).toEqual([]);
  });
});

describe("planKick", () => {
  const geometry = () => ({
    avatar: { center: { x: 400, y: 120 }, radius: 24 },
    seat: { x: 363, y: 96, width: 74, height: 150 },
    bootRadius: 26,
    bounds: {
      box: { width: 74, height: 150 },
      viewport: { width: 1280, height: 800 },
      offset: { x: 100, y: 200 },
    },
  });

  it("swings in from beside the seat and is rising when it lands", () => {
    const plan = planKick(geometry())!;
    expect(plan).not.toBeNull();
    const m = plan.boot.metrics;
    expect(m.closest).toBeLessThanOrEqual(m.hitRadius);
    expect(m.dip).toBeGreaterThan(0);
    expect(m.riseAfterDip).toBeGreaterThan(0);
    expect(m.startOffsetX).toBeGreaterThanOrEqual(150);
    expect(plan.boot.velocity.x).toBeLessThan(0);
    expect(plan.boot.velocity.y).toBeLessThan(0);
  });

  it("sends the seat up and to the left, and off the screen", () => {
    const plan = planKick(geometry())!;
    expect(plan.velocity.x).toBeLessThan(0);
    expect(plan.velocity.y).toBeLessThan(0);
    expect(plan.exitMs).toBeGreaterThan(plan.impactMs);
    // It really leaves rather than running out the cap and dissolving.
    expect(plan.launch.frames.every((f) => f.opacity === 1)).toBe(true);
  });

  it("closes the row only once the seat is gone, and tears down after that", () => {
    const plan = planKick(geometry())!;
    expect(plan.exitMs).toBeGreaterThan(plan.impactMs);
    expect(plan.endMs).toBeGreaterThanOrEqual(plan.exitMs + KICK_REFLOW_MS);
  });

  // Observed in a browser: the boot's own animation ended, and because the
  // overlay was not emptied until the SEAT had cleared the viewport the glyph
  // held its last frame, still visible, for the best part of a second.
  it("takes the boot away under its own motion, on its own schedule", () => {
    const plan = planKick(geometry())!;
    // Its lifetime is its own: it is gone long before the seat has left, and
    // is never stretched to the seat's exit.
    expect(plan.bootEndMs).toBeLessThan(plan.exitMs);
    expect(plan.bootEndMs).toBeGreaterThanOrEqual(plan.boot.durationMs);

    // And what it does last is travel. Every one of the closing frames moves
    // the glyph a real distance, so nothing is ever held still and dissolved.
    const at = (f: { transform: string }) => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(f.transform)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const tail = plan.boot.frames.slice(-6);
    for (let i = 1; i < tail.length; i++) {
      const a = at(tail[i - 1]);
      const b = at(tail[i]);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(6);
    }
    // The fade rides on that travel and finishes with it.
    expect(plan.boot.frames[plan.boot.frames.length - 1].opacity).toBe(0);
  });

  // The other null: every rect is measurable, so the guards above pass, but
  // the arc the geometry implies never reaches the disc inside the swing's
  // window. A caller that cannot swing must draw nothing.
  it("is null for a valid seat the swing cannot reach", () => {
    const g = geometry();
    // A huge avatar puts the boot's rest spot proportionally further out, and
    // the pendulum it hangs off is too long to cross in time.
    const plan = planKick({ ...g, avatar: { center: { x: 400, y: 120 }, radius: 400 } });
    expect(plan).toBeNull();
  });

  it("is null for geometry there is nothing to swing at", () => {
    // What an unmeasurable seat actually looks like: every rect zero, which is
    // also every rect a test environment with no layout returns.
    const g = geometry();
    expect(planKick({ ...g, avatar: { ...g.avatar, radius: 0 } })).toBeNull();
    expect(planKick({ ...g, bootRadius: 0 })).toBeNull();
    expect(planKick({ ...g, seat: { ...g.seat, width: 0, height: 0 } })).toBeNull();
  });
});
