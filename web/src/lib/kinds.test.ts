import { describe, expect, it } from "vitest";
import { KINDS, getKind, defaultConfig, fieldOptions } from "./kinds";

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

describe("space-scoped field options", () => {
  const deck = {
    id: "d1",
    name: "House deck",
    cards: ["1", "2", "3"],
    ordinal: false,
    createdAt: "2026-08-18T10:00:00.000Z",
  };

  it("appends a space's own decks after the built-ins", () => {
    const field = getKind("poker")!.fields![0];
    const opts = fieldOptions(field, [deck]);
    expect(opts.slice(0, field.options.length)).toEqual(field.options);
    expect(opts.at(-1)).toEqual({
      id: "d1",
      name: "House deck",
      sample: ["1", "2", "3"],
      // A session stores the cards it was created with, so the option carries
      // the whole deck rather than a row id to join back to.
      value: { name: "House deck", values: ["1", "2", "3"], ordinal: false },
    });
  });

  it("leaves a field with no space source alone", () => {
    const field = { key: "x", label: "X", options: [{ id: "a", name: "A", sample: [], value: "a" }] };
    expect(fieldOptions(field, [deck])).toEqual(field.options);
  });

  it("still defaults to the first built-in deck", () => {
    expect(defaultConfig(getKind("poker")!)).toEqual({ deck: "fibonacci", autoReveal: false });
  });
});
