import { describe, expect, it } from "vitest";
import { KINDS, getKind, defaultConfig } from "./kinds";

describe("kind registry", () => {
  it("registers the built-in kinds under their wire ids", () => {
    expect(KINDS.map((k) => k.id)).toEqual(["poker", "standup"]);
  });

  it("looks a kind up by exact id, never loosely", () => {
    expect(getKind("poker")?.label).toBe("Poker");
    // A near-miss id is a different kind, not this one: a lookup that matched
    // by prefix or substring would hand a "pokerful" session the poker room.
    expect(getKind("pokerful")).toBeUndefined();
    // A namespaced plugin id is unknown here, and unknown means unknown —
    // not a silent fallback to the last registered kind.
    expect(getKind("acme.retro")).toBeUndefined();
    expect(getKind("")).toBeUndefined();
  });

  it("gives every kind a room component", () => {
    for (const k of KINDS) expect(typeof k.Room).toBe("function");
  });

  it("describes poker's deck as a field spec, and standup as fieldless", () => {
    const poker = getKind("poker")!;
    expect(poker.fields?.[0]?.key).toBe("deck");
    expect(poker.fields?.[0]?.options.map((o) => o.id)).toContain("fibonacci");
    expect(poker.toggles?.[0]?.key).toBe("autoReveal");
    expect(poker.toggles?.[0]?.default).toBe(false);
    expect(getKind("standup")!.fields ?? []).toEqual([]);
  });

  it("builds a create-time config from the field defaults", () => {
    expect(defaultConfig(getKind("poker")!)).toEqual({ deck: "fibonacci", autoReveal: false });
    expect(defaultConfig(getKind("standup")!)).toEqual({});
  });
});