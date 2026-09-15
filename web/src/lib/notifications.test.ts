import { describe, expect, it } from "vitest";
import type { Envelope } from "./api";
import { notificationCue } from "./notifications";

const frame = (over: Record<string, unknown>): Envelope =>
  ({
    id: "s1",
    kind: "poker",
    phase: "gathering",
    revealed: false,
    version: 1,
    endedAt: null,
    state: { currentStoryId: null, roundVersion: 0 },
    ...over,
  }) as unknown as Envelope;

describe("notificationCue", () => {
  it("classifies poker starts, resets, and reveals", () => {
    const idle = frame({});
    const started = frame({ version: 2, state: { currentStoryId: "a", roundVersion: 1 } });
    const reset = frame({ version: 3, state: { currentStoryId: "a", roundVersion: 2 } });
    const revealed = frame({ version: 4, revealed: true, state: { currentStoryId: "a", roundVersion: 2 } });
    expect(notificationCue(idle, started, "u1")).toBe("poker-start");
    expect(notificationCue(started, reset, "u1")).toBe("poker-start");
    expect(notificationCue(reset, revealed, "u1")).toBe("poker-reveal");
  });

  it("chooses reveal when one snapshot crosses both poker boundaries", () => {
    const before = frame({ state: { currentStoryId: "a", roundVersion: 1 } });
    const after = frame({ version: 3, revealed: true, state: { currentStoryId: "b", roundVersion: 2 } });
    expect(notificationCue(before, after, "u1")).toBe("poker-reveal");
  });

  it("classifies standup start, own turn, and finish with own turn first", () => {
    const gathering = frame({ kind: "standup", state: { currentSpeakerId: null } });
    const firstMine = frame({ kind: "standup", version: 2, phase: "speaking", state: { currentSpeakerId: "u1" } });
    const firstOther = frame({ kind: "standup", version: 2, phase: "speaking", state: { currentSpeakerId: "u2" } });
    const mine = frame({ kind: "standup", version: 3, phase: "speaking", state: { currentSpeakerId: "u1" } });
    const done = frame({ kind: "standup", version: 4, phase: "done", state: { currentSpeakerId: null } });
    expect(notificationCue(gathering, firstMine, "u1")).toBe("standup-turn");
    expect(notificationCue(gathering, firstOther, "u1")).toBe("standup-start");
    expect(notificationCue(firstOther, mine, "u1")).toBe("standup-turn");
    expect(notificationCue(mine, done, "u1")).toBe("standup-finish");
  });

  it("finishes on an early close and does not repeat after done", () => {
    const speaking = frame({ kind: "standup", phase: "speaking", state: { currentSpeakerId: "u2" } });
    const closed = frame({ kind: "standup", version: 2, phase: "speaking", endedAt: "now", state: { currentSpeakerId: "u2" } });
    const done = frame({ kind: "standup", phase: "done", state: { currentSpeakerId: null } });
    const doneClosed = frame({ kind: "standup", version: 2, phase: "done", endedAt: "now", state: { currentSpeakerId: null } });
    expect(notificationCue(speaking, closed, "u1")).toBe("standup-finish");
    expect(notificationCue(done, doneClosed, "u1")).toBeNull();
  });

  it("keeps votes, unrelated edits, and unknown kinds silent", () => {
    const poker = frame({ state: { currentStoryId: "a", roundVersion: 1 } });
    expect(notificationCue(poker, frame({ version: 2, state: { currentStoryId: "a", roundVersion: 1 } }), "u1")).toBeNull();
    expect(notificationCue(frame({ kind: "retro" }), frame({ kind: "retro", version: 2 }), "u1")).toBeNull();
  });
});
