import { describe, expect, it } from "vitest";
import { avatarIcon, avatarIconIds, avatarIconLabels } from "./avatarIcons";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("the portrait sheet", () => {
  it("ships thirty portraits and nothing else", () => {
    expect(avatarIconIds).toHaveLength(30);
    expect(new Set(avatarIconIds).size).toBe(30);
  });

  it("never reuses one of the twelve retired ids", () => {
    const retired = [
      "parrot", "kraken", "anchor", "lighthouse", "wheel", "gull", "buoy", "crate",
      "rubber-duck", "coffee", "terminal", "pager",
    ];
    expect(avatarIconIds.filter((id) => retired.includes(id))).toEqual([]);
  });

  it("names every id", () => {
    for (const id of avatarIconIds) expect(avatarIconLabels[id]).toBeTruthy();
  });

  it("uses ids the server's shape check accepts", () => {
    for (const id of avatarIconIds) expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
  });

  it("resolves a portrait for every shipped id", () => {
    for (const id of avatarIconIds) expect(avatarIcon(id)).toBeTruthy();
  });

  it("returns null rather than an inherited value for a hostile id", () => {
    for (const id of [
      "constructor", "hasOwnProperty", "hasownproperty", "tostring", "toString",
      "valueof", "valueOf", "__proto__", "prototype", "isprototypeof",
    ]) {
      expect(avatarIcon(id)).toBeNull();
    }
  });

  it("returns null for an unset or unknown id", () => {
    expect(avatarIcon(undefined)).toBeNull();
    expect(avatarIcon("")).toBeNull();
    expect(avatarIcon("unicorn")).toBeNull();
  });
});

/**
 * The licence audit. Every committed portrait must be CC0 1.0 DiceBear
 * "voxel-art" output — 14 of DiceBear's 55 styles are CC BY 4.0 and none of
 * them may ever be committed here — and none may reach for api.dicebear.com at
 * render time, which would leak one request per person from a self-hosted app.
 */
describe("the committed assets", () => {
  const dir = "src/assets/avatars";
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));

  it("holds exactly one file per shipped id, and no strays", () => {
    expect(files.sort()).toEqual(avatarIconIds.map((id) => `${id}.svg`).sort());
  });

  it("is static, self-contained art with no network reference and no motion", () => {
    for (const file of files) {
      const svg = readFileSync(join(dir, file), "utf8");
      expect(svg).not.toMatch(/dicebear\.com|href="http|url\(\s*["']?https?:|<image|<script|<animate|<foreignObject/i);
    }
  });
});
