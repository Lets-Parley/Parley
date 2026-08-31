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
  staggerFor,
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
  it("shares one reveal-clearing expression with the high-five", () => {
    expect(revealSettledAt(1)).toBe(620 + 450 + 60);
    expect(revealSettledAt(6)).toBe(620 + 5 * 40 + 450 + 60);
    expect(revealSettledAt(0)).toBe(revealSettledAt(1));
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

  it("staggers on the shared budget and reports the beats the caller schedules", () => {
    const plan = planPileOn(geom(5));
    const { start, stagger } = pileOnBeats(6, 5);
    expect(plan.throws.map((t) => t.delayMs)).toEqual([0, 1, 2, 3, 4].map((i) => start + i * stagger));
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
