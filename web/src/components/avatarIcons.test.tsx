import { describe, expect, it } from "vitest";
import { avatarDevIconIds, avatarIcon, avatarIconIds, avatarIconLabels } from "./avatarIcons";

describe("the two icon sheets", () => {
  it("keeps the crew list exactly as it shipped", () => {
    expect(avatarIconIds).toEqual([
      "parrot",
      "kraken",
      "anchor",
      "lighthouse",
      "wheel",
      "gull",
      "buoy",
      "crate",
    ]);
  });

  it("holds the dev pack in a sheet of its own, disjoint from the crew", () => {
    expect(avatarDevIconIds).toEqual(["rubber-duck", "coffee", "terminal", "pager"]);
    expect(avatarDevIconIds.filter((id) => avatarIconIds.includes(id))).toEqual([]);
  });

  it("names every id in both sheets", () => {
    for (const id of [...avatarIconIds, ...avatarDevIconIds]) {
      expect(avatarIconLabels[id]).toBeTruthy();
    }
  });

  it("uses ids the server's shape check accepts", () => {
    for (const id of [...avatarIconIds, ...avatarDevIconIds]) {
      expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
    }
  });

  it("resolves a glyph for every shipped id", () => {
    for (const id of [...avatarIconIds, ...avatarDevIconIds]) {
      expect(avatarIcon(id)).toBeTruthy();
    }
  });

  it("returns null rather than an inherited value for a hostile id in either sheet", () => {
    for (const id of ["constructor", "hasOwnProperty", "hasownproperty", "tostring", "toString", "valueof", "valueOf", "__proto__", "prototype", "isprototypeof"]) {
      expect(avatarIcon(id)).toBeNull();
    }
  });

  it("returns null for an unset or unknown id", () => {
    expect(avatarIcon(undefined)).toBeNull();
    expect(avatarIcon("")).toBeNull();
    expect(avatarIcon("unicorn")).toBeNull();
  });
});
