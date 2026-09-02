import { describe, expect, it } from "vitest";
import { GRACE_SECONDS, claimState, voteTally } from "./derive";
import type { Envelope, Person } from "./api";

const person = (userId: string, over: Partial<Person> = {}): Person => ({
  userId,
  name: userId,
  avatarHue: 0,
  spectator: false,
  ...over,
});

describe("voteTally", () => {
  const dana = person("dana");
  const marcus = person("marcus");
  const priya = person("priya");
  const seated = [dana, marcus, priya];

  it("returns the one voted set the seat cards must also use", () => {
    // The footer count and each seat's card have to agree; a second copy of
    // this rule in the component let them diverge.
    const t = voteTally(seated, new Set(["dana"]), ["dana"], new Map([["priya", "8"]]));
    expect([...t.voted].sort()).toEqual(["dana", "priya"]);
  });

  it("excludes an offline non-voter from the denominator", () => {
    // Priya dropped without voting: "2 of 2" must be reachable, otherwise the
    // room can never see a complete round while anyone is disconnected.
    const t = voteTally(seated, new Set(["dana", "marcus"]), ["dana", "marcus"], new Map());
    expect(t).toMatchObject({ votedCount: 2, canVote: 2 });
  });

  it("counts an offline voter in both halves", () => {
    const t = voteTally(seated, new Set(["dana"]), ["dana", "marcus"], new Map());
    expect(t).toMatchObject({ votedCount: 2, canVote: 2 });
  });

  it("unions votedUserIds and the revealed votes map without double counting", () => {
    const votes = new Map([["dana", "5"]]);
    const t = voteTally(seated, new Set(["dana", "marcus", "priya"]), ["dana"], votes);
    expect(t.votedCount).toBe(1);
    expect(t.canVote).toBe(3);
  });

  it("counts someone present only in the votes map", () => {
    const votes = new Map([["priya", "8"]]);
    const t = voteTally(seated, new Set(["dana"]), [], votes);
    expect(t).toMatchObject({ votedCount: 1, canVote: 2 });
  });

  it("reports 0 of 0 for an empty table rather than dividing by nothing", () => {
    expect(voteTally([], new Set(), [], new Map())).toMatchObject({ votedCount: 0, canVote: 0 });
  });

  it("ignores presence for people who are not seated", () => {
    const t = voteTally([dana], new Set(["dana", "marcus", "priya"]), [], new Map());
    expect(t.canVote).toBe(1);
  });

  // The denominator and the "waiting on" line have to come out of the same
  // rule. Naming an away seat under a "0 of 1 voted" tally makes the footer
  // contradict the table it sits under, and the seat's own card already says
  // that person is asleep.
  it("leaves an away non-voter out of the waiting set, as the denominator does", () => {
    const t = voteTally(seated, new Set(["marcus"]), [], new Map());
    expect(t.canVote).toBe(1);
    expect(t.waiting.map((p) => p.userId)).toEqual(["marcus"]);
  });

  it("does not wait on someone who voted and then dropped", () => {
    const t = voteTally(seated, new Set(["dana"]), ["marcus"], new Map());
    // Marcus is counted (he voted) but is not still being waited for.
    expect(t.canVote).toBe(2);
    expect(t.waiting.map((p) => p.userId)).toEqual(["dana"]);
  });

  it("waits on nobody once everyone who could vote has", () => {
    const t = voteTally(seated, new Set(["dana", "marcus"]), ["dana", "marcus"], new Map());
    expect(t.waiting).toEqual([]);
  });
});

describe("claimState", () => {
  const base = {
    facilitatorConnected: false,
    facilitatorOfflineSince: "2026-08-18T10:00:00Z",
    serverTime: "2026-08-18T10:00:30Z",
    endedAt: null,
  } satisfies Pick<
    Envelope,
    "facilitatorConnected" | "facilitatorOfflineSince" | "serverTime" | "endedAt"
  >;

  it("offers the chair with the remaining grace while the facilitator is away", () => {
    expect(claimState(base, false)).toEqual({
      showClaim: true,
      offlineFor: 30,
      graceLeft: 30,
    });
  });

  it("returns graceLeft 0 — not null — at the exact moment it becomes claimable", () => {
    // This is the boundary the shipped `!claimLeft` bug sat on: 0 is the
    // claimable moment and must stay distinguishable from "no claim offered".
    const at60 = { ...base, serverTime: "2026-08-18T10:01:00Z" };
    const s = claimState(at60, false);
    expect(s.offlineFor).toBe(GRACE_SECONDS);
    expect(s.graceLeft).toBe(0);
    expect(s.graceLeft).not.toBeNull();
    expect(s.showClaim).toBe(true);
  });

  it("floors graceLeft at 0 once the grace period is long past", () => {
    const late = { ...base, serverTime: "2026-08-18T10:05:00Z" };
    expect(claimState(late, false).graceLeft).toBe(0);
  });

  it("offers nothing while the facilitator is connected", () => {
    const s = claimState({ ...base, facilitatorConnected: true }, false);
    expect(s.showClaim).toBe(false);
    expect(s.graceLeft).toBeNull();
  });

  it("offers nothing to the facilitator themselves", () => {
    expect(claimState(base, true).showClaim).toBe(false);
  });

  it("offers nothing once the session has ended", () => {
    const s = claimState({ ...base, endedAt: "2026-08-18T10:00:10Z" }, false);
    expect(s.showClaim).toBe(false);
  });

  it("offers nothing when no offline timestamp has been recorded yet", () => {
    const s = claimState({ ...base, facilitatorOfflineSince: undefined }, false);
    expect(s.offlineFor).toBeNull();
    expect(s.showClaim).toBe(false);
  });
});
