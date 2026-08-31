import { describe, expect, it } from "vitest";
import { safeDisplayName } from "./displayName";

describe("safeDisplayName", () => {
  it("strips U+202E so a name cannot reorder the text around it", () => {
    // Classic spoof: RLO flips the visual order of what follows, so a
    // surrounding label like "Next: " can appear after the forged name.
    const spoofed = `Alice\u202Ekkad`;
    const label = `Next: ${safeDisplayName(spoofed)}`;
    expect(safeDisplayName(spoofed)).toBe("Alicekkad");
    expect(label).toBe("Next: Alicekkad");
    expect(label.startsWith("Next: ")).toBe(true);
    expect(label).not.toContain("\u202E");
  });

  it("strips the other bidi embedding, override, and isolate controls", () => {
    const raw =
      "A\u202A" + // LRE
      "B\u202B" + // RLE
      "C\u202C" + // PDF
      "D\u202D" + // LRO
      "E\u202E" + // RLO
      "F\u2066" + // LRI
      "G\u2067" + // RLI
      "H\u2068" + // FSI
      "I\u2069"; // PDI
    expect(safeDisplayName(raw)).toBe("ABCDEFGHI");
  });

  it("keeps legitimate Arabic and Hebrew names", () => {
    expect(safeDisplayName("محمد علي")).toBe("محمد علي");
    expect(safeDisplayName("שלום כהן")).toBe("שלום כהן");
  });

  it("leaves ordinary Latin names alone", () => {
    expect(safeDisplayName("Dana Whitfield")).toBe("Dana Whitfield");
  });
});
