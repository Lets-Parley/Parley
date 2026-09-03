import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import beacon from "../themes/beacon.theme.json";
import {
  GATED_PAIRS,
  THEME_TOKENS,
  UNGATED_TOKENS,
  applyThemePack,
  contrastFailures,
  contrastRatio,
  installThemePack,
  installedThemePack,
  parseThemePack,
  uninstallThemePack,
  useThemePack,
  type ThemePack,
} from "./theme";

/** A minimal valid pack, mutated per-test. */
function pack(over: Record<string, unknown> = {}): Record<string, unknown> {
  const mode = Object.fromEntries(THEME_TOKENS.map((t) => [t, "#123456"]));
  return {
    manifest: 1,
    kind: "theme",
    id: "test.pack",
    name: "Test Pack",
    version: "1.0.0",
    modes: { light: mode },
    ...over,
  };
}

function ok(input: unknown): ThemePack {
  const r = parseThemePack(input);
  if (!r.ok) throw new Error(`expected valid, got: ${r.errors.join("; ")}`);
  return r.pack;
}

function errors(input: unknown): string[] {
  const r = parseThemePack(input);
  if (r.ok) throw new Error("expected invalid, but it parsed");
  return r.errors;
}

describe("the frozen token contract", () => {
  it("is the sixteen colour tokens tokens.css declares, and nothing else", () => {
    expect([...THEME_TOKENS]).toEqual([
      "felt",
      "felt-deep",
      "surface",
      "surface-hi",
      "ink",
      "ink-soft",
      "ink-faint",
      "line",
      "line-strong",
      "accent",
      "accent-ink",
      "accent-soft",
      "brass",
      "settled",
      "go",
      "stop",
    ]);
  });

  it("requires every token in every declared mode", () => {
    const short = pack();
    delete (short.modes as Record<string, Record<string, string>>).light.brass;
    expect(errors(short).join(" ")).toContain("brass");
  });

  it("refuses a mode that carries an unknown key", () => {
    const extra = pack();
    (extra.modes as Record<string, Record<string, string>>).light["card-back"] = "#000000";
    expect(errors(extra).join(" ")).toContain("card-back");
  });

  it("refuses motion tokens, so a theme cannot fight reduced-motion", () => {
    const motion = pack();
    (motion.modes as Record<string, Record<string, string>>).light["ease-spring"] = "linear";
    expect(errors(motion).join(" ")).toContain("ease-spring");
  });
});

describe("values must be literals", () => {
  it.each([
    "var(--color-ink)",
    "url(https://example.test/beacon.png)",
    "env(safe-area-inset-top)",
    "attr(data-x)",
    "#123456 !important",
    "red; background: url(https://example.test/b.png)",
    "rgb(1 2 3)",
    "#12345",
    "#12345g",
    "",
  ])("rejects %j", (value) => {
    const bad = pack();
    (bad.modes as Record<string, Record<string, string>>).light.ink = value;
    expect(errors(bad).join(" ")).toContain("ink");
  });

  it("accepts a six-digit hex in either case", () => {
    const p = pack();
    (p.modes as Record<string, Record<string, string>>).light.ink = "#aBcDeF";
    expect(ok(p).modes.light?.ink).toBe("#aBcDeF");
  });
});

describe("manifest shape", () => {
  it.each([
    ["a future manifest version", pack({ manifest: 2 })],
    ["a non-theme kind", pack({ kind: "wasm" })],
    ["an id with punctuation", pack({ id: "test/pack" })],
    ["a non-semver version", pack({ version: "1.0" })],
    ["a missing name", pack({ name: "" })],
    ["no modes at all", pack({ modes: {} })],
    ["an unknown mode", pack({ modes: { sepia: {} } })],
    ["a non-object", "not a pack"],
    ["null", null],
  ])("rejects %s", (_label, input) => {
    expect(errors(input).length).toBeGreaterThan(0);
  });

  it("collects every problem rather than stopping at the first", () => {
    expect(errors(pack({ id: "test/pack", version: "1.0" })).length).toBeGreaterThan(1);
  });
});

describe("the contrast gate", () => {
  it("gates ink on surface-hi", () => {
    expect(GATED_PAIRS).toContainEqual(
      expect.objectContaining({ foreground: "ink", background: "surface-hi" }),
    );
  });

  it("gates the text drawn on brass", () => {
    // `brass` is a ground, never a text colour: the shipped UI draws
    // `accent-ink` on it. Gating ink/brass would gate a pair nothing renders.
    expect(GATED_PAIRS).toContainEqual(
      expect.objectContaining({ foreground: "accent-ink", background: "brass" }),
    );
  });

  it("names what it does not gate rather than implying it is safe", () => {
    expect(UNGATED_TOKENS.length).toBeGreaterThan(0);
    for (const note of UNGATED_TOKENS) expect(note.why.length).toBeGreaterThan(0);
  });

  it("measures WCAG ratios", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#12202F", "#FFFFFF")).toBeCloseTo(16.49, 1);
  });

  it("fails a low-contrast mode, naming the pair and the ratio", () => {
    const flat = ok(pack());
    const failures = contrastFailures(flat);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].mode).toBe("light");
    expect(failures[0].ratio).toBeCloseTo(1, 5);
  });

  it("passes the first-party pack", () => {
    expect(contrastFailures(ok(beacon))).toEqual([]);
  });
});

describe("applying and removing a pack", () => {
  const root = document.documentElement;
  beforeEach(() => root.removeAttribute("style"));

  it("sets every token as a property, never as CSS text", () => {
    applyThemePack(ok(beacon), "light");
    for (const t of THEME_TOKENS) {
      expect(root.style.getPropertyValue(`--color-${t}`)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("returns to the built-in tokens with nothing left behind", () => {
    applyThemePack(ok(beacon), "light");
    applyThemePack(null, "light");
    for (const t of THEME_TOKENS) {
      expect(root.style.getPropertyValue(`--color-${t}`)).toBe("");
    }
  });

  it("falls back to the built-in palette for a mode the pack does not declare", () => {
    const lightOnly = ok(pack({ modes: { light: (pack().modes as Record<string, unknown>).light } }));
    applyThemePack(lightOnly, "light");
    applyThemePack(lightOnly, "dark");
    expect(root.style.getPropertyValue("--color-ink")).toBe("");
  });

  it("never leaves half a palette applied", () => {
    applyThemePack(ok(beacon), "dark");
    applyThemePack(ok(beacon), "light");
    const light = ok(beacon).modes.light!;
    for (const t of THEME_TOKENS) {
      expect(root.style.getPropertyValue(`--color-${t}`)).toBe(light[t]);
    }
  });
});

describe("installing and resetting", () => {
  beforeEach(() => {
    localStorage.clear();
    uninstallThemePack();
    document.documentElement.removeAttribute("style");
  });

  it("refuses a pack that fails the gate without an explicit acknowledgement", () => {
    expect(() => installThemePack(ok(pack()))).toThrow(/contrast/i);
    expect(installedThemePack()).toBeNull();
  });

  it("installs one that fails the gate when the failure is acknowledged", () => {
    installThemePack(ok(pack()), { acknowledgeContrast: true });
    expect(installedThemePack()?.id).toBe("test.pack");
  });

  it("survives a reload, so the reset affordance is always reachable", () => {
    installThemePack(ok(beacon));
    expect(parseThemePack(JSON.parse(localStorage.getItem("parley:theme-pack")!)).ok).toBe(true);
    expect(installedThemePack()?.id).toBe(ok(beacon).id);
  });

  it("ignores a stored pack that no longer validates", () => {
    localStorage.setItem("parley:theme-pack", JSON.stringify(pack({ manifest: 2 })));
    expect(installedThemePack()).toBeNull();
  });

  it("uninstalling clears both the store and the applied palette", () => {
    installThemePack(ok(beacon));
    applyThemePack(installedThemePack(), "light");
    uninstallThemePack();
    expect(installedThemePack()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--color-ink")).toBe("");
  });
});

describe("useThemePack", () => {
  beforeEach(() => {
    localStorage.clear();
    uninstallThemePack();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies the installed pack and resets on uninstall", () => {
    const { result } = renderHook(() => useThemePack());
    act(() => result.current.install(ok(beacon)));
    expect(document.documentElement.style.getPropertyValue("--color-ink")).toBe(
      ok(beacon).modes.light!.ink,
    );
    expect(result.current.pack?.name).toBe(ok(beacon).name);
    act(() => result.current.uninstall());
    expect(document.documentElement.style.getPropertyValue("--color-ink")).toBe("");
    expect(result.current.pack).toBeNull();
  });

  it("follows the document into a pinned dark palette", async () => {
    installThemePack(ok(beacon));
    renderHook(() => useThemePack());
    // The observer fires on a microtask, so the flush has to be awaited.
    await act(async () => document.documentElement.setAttribute("data-theme", "dark"));
    expect(document.documentElement.style.getPropertyValue("--color-ink")).toBe(
      ok(beacon).modes.dark!.ink,
    );
  });
});
