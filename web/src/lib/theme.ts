import { useEffect, useSyncExternalStore } from "react";
import { useMediaQuery } from "./ui";

/**
 * Theme packs — the plugin tier that executes nothing.
 *
 * A pack is a value map, not a stylesheet: the host iterates the sixteen known
 * tokens and calls `setProperty` for each one. Author text is never
 * concatenated into CSS, so a selector, an `@import` or a `url()` beacon has
 * nowhere to land, and a token the pack does not name simply cannot be set —
 * which is how motion stays unthemeable and reduced-motion stays honoured.
 */

/** The frozen contract: the sixteen colour tokens declared in tokens.css. */
export const THEME_TOKENS = [
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
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeMode = "light" | "dark";
const MODES: ThemeMode[] = ["light", "dark"];

export type ThemePalette = Record<ThemeToken, string>;

export type ThemePack = {
  /** Bumped only by a breaking change to this shape. */
  manifest: 1;
  /** `theme` is the no-code-execution tier; later tiers get their own kind. */
  kind: "theme";
  id: string;
  name: string;
  version: string;
  modes: Partial<Record<ThemeMode, ThemePalette>>;
};

export type ParseResult = { ok: true; pack: ThemePack } | { ok: false; errors: string[] };

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** A literal, and only a literal. Everything CSS can be talked into doing —
 *  `var()`, `url()`, `env()`, `attr()`, `!important`, a stray `;` — is punctuation
 *  this cannot contain. */
const HEX = /^#[0-9A-Fa-f]{6}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate an untrusted value into a pack, collecting every problem. */
export function parseThemePack(input: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["not a theme manifest object"] };

  if (input.manifest !== 1) errors.push(`manifest must be 1, got ${JSON.stringify(input.manifest)}`);
  if (input.kind !== "theme") errors.push(`kind must be "theme", got ${JSON.stringify(input.kind)}`);
  if (typeof input.id !== "string" || !ID.test(input.id) || input.id.length > 64)
    errors.push("id must be lowercase dot- or hyphen-separated, 64 characters or fewer");
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 60)
    errors.push("name must be a non-empty string of 60 characters or fewer");
  if (typeof input.version !== "string" || !SEMVER.test(input.version))
    errors.push("version must be major.minor.patch");

  const modes: Partial<Record<ThemeMode, ThemePalette>> = {};
  if (!isRecord(input.modes)) {
    errors.push("modes must be an object");
  } else {
    const names = Object.keys(input.modes);
    if (names.length === 0) errors.push("modes must declare at least one of light, dark");
    for (const name of names) {
      if (!MODES.includes(name as ThemeMode)) {
        errors.push(`unknown mode ${JSON.stringify(name)}`);
        continue;
      }
      const palette = input.modes[name];
      if (!isRecord(palette)) {
        errors.push(`mode ${name} must be an object of token values`);
        continue;
      }
      for (const key of Object.keys(palette)) {
        if (!(THEME_TOKENS as readonly string[]).includes(key))
          errors.push(`${name}: ${key} is not a themeable token`);
      }
      for (const token of THEME_TOKENS) {
        const value = palette[token];
        if (typeof value !== "string" || !HEX.test(value))
          errors.push(`${name}: ${token} must be a #rrggbb literal, got ${JSON.stringify(value)}`);
      }
      modes[name as ThemeMode] = palette as ThemePalette;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const { manifest, kind, id, name, version } = input as unknown as ThemePack;
  return { ok: true, pack: { manifest, kind, id, name, version, modes } };
}

/* --------------------------------------------------------------- contrast -- */

function relativeLuminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG 2.2 contrast ratio between two #rrggbb literals. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type GatedPair = {
  foreground: ThemeToken;
  background: ThemeToken;
  /** 4.5 for body text (AA 1.4.3), 3 for non-text and boundaries (AA 1.4.11). */
  required: number;
};

const GROUNDS: ThemeToken[] = ["felt", "felt-deep", "surface", "surface-hi"];

/**
 * The pairs a pack is held to. Not every combination of sixteen tokens — only
 * the ones the shipped UI actually renders, each measured against the WCAG
 * level its role requires. `UNGATED_TOKENS` names what this list leaves out.
 */
export const GATED_PAIRS: GatedPair[] = [
  ...(["ink", "ink-soft", "ink-faint"] as ThemeToken[]).flatMap((foreground) =>
    GROUNDS.map((background) => ({ foreground, background, required: 4.5 })),
  ),
  // `accent-soft` and `brass` are grounds too: chips and the facilitator badge.
  { foreground: "ink", background: "accent-soft", required: 4.5 },
  { foreground: "accent-ink", background: "accent", required: 4.5 },
  { foreground: "accent-ink", background: "brass", required: 4.5 },
  // Boundaries, dots and chips: non-text, so the 1.4.11 floor of 3:1.
  ...(["line-strong", "accent", "go", "stop", "settled"] as ThemeToken[]).flatMap((foreground) =>
    GROUNDS.map((background) => ({ foreground, background, required: 3 })),
  ),
];

/**
 * What the gate does not measure. Written down rather than left implied: an
 * unlisted pair is unchecked, not proven safe.
 */
export const UNGATED_TOKENS: { token: string; why: string }[] = [
  {
    token: "line",
    why: "a hairline divider, deliberately faint. `line-strong` is the boundary that identifies a control, and that one is gated at 3:1.",
  },
  {
    token: "ink on brass",
    why: "brass is a ground for `accent-ink`, never for `ink`. The pair the UI draws is gated; this one is not rendered anywhere.",
  },
  {
    token: "card-back, pip",
    why: "not themeable at all — the playing-card faces are artwork, not palette.",
  },
  {
    token: "colour-blind separability",
    why: "a ratio check cannot see hue. A pack can pass every pair and still make go and stop the same colour to a viewer with deuteranopia.",
  },
];

export type ContrastFailure = GatedPair & { mode: ThemeMode; ratio: number };

/** Every gated pair a pack fails, across every mode it declares. */
export function contrastFailures(pack: ThemePack): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const mode of MODES) {
    const palette = pack.modes[mode];
    if (!palette) continue;
    for (const pair of GATED_PAIRS) {
      const ratio = contrastRatio(palette[pair.foreground], palette[pair.background]);
      if (ratio < pair.required) failures.push({ ...pair, mode, ratio });
    }
  }
  return failures;
}

/* ------------------------------------------------------------ application -- */

/**
 * Apply a pack's palette for one mode, or hand the page back to the built-in
 * tokens when the pack is null or does not declare that mode. Every token is
 * written or cleared in the same pass, so there is no half-applied palette.
 */
export function applyThemePack(pack: ThemePack | null, mode: ThemeMode): void {
  const style = document.documentElement.style;
  const palette = pack?.modes[mode];
  for (const token of THEME_TOKENS) {
    if (palette) style.setProperty(`--color-${token}`, palette[token]);
    else style.removeProperty(`--color-${token}`);
  }
}

/* ------------------------------------------------------------------ store -- */

const PACK_KEY = "parley:theme-pack";
const listeners = new Set<() => void>();
let cached: { raw: string | null; pack: ThemePack | null } = { raw: null, pack: null };

function readRaw(): string | null {
  try {
    return localStorage.getItem(PACK_KEY);
  } catch {
    return null;
  }
}

/** The installed pack, or null — including when the stored one no longer validates. */
export function installedThemePack(): ThemePack | null {
  const raw = readRaw();
  if (raw === cached.raw) return cached.pack;
  let pack: ThemePack | null = null;
  try {
    const parsed = raw === null ? null : parseThemePack(JSON.parse(raw));
    if (parsed?.ok) pack = parsed.pack;
  } catch {
    pack = null;
  }
  cached = { raw, pack };
  return pack;
}

function announce() {
  for (const l of listeners) l();
}

/**
 * Install a pack. A pack that fails the contrast gate is refused unless the
 * caller passes an acknowledgement — the operator has to say the words.
 */
export function installThemePack(pack: ThemePack, opts?: { acknowledgeContrast?: boolean }): void {
  const failures = contrastFailures(pack);
  if (failures.length > 0 && !opts?.acknowledgeContrast) {
    const worst = failures[0];
    throw new Error(
      `contrast gate: ${worst.mode} ${worst.foreground} on ${worst.background} is ${worst.ratio.toFixed(2)}:1, below ${worst.required}:1 (${failures.length} failing pairs)`,
    );
  }
  try {
    localStorage.setItem(PACK_KEY, JSON.stringify(pack));
  } catch {
    // Private mode: the theme applies for this session and does not persist.
  }
  cached = { raw: readRaw(), pack };
  announce();
}

/** Back to the built-in tokens, with nothing left applied. */
export function uninstallThemePack(): void {
  try {
    localStorage.removeItem(PACK_KEY);
  } catch {
    // Nothing stored to remove.
  }
  cached = { raw: null, pack: null };
  applyThemePack(null, "light");
  announce();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    removeEventListener("storage", listener);
  };
}

/**
 * The palette the document is actually on. Read from `data-theme` rather than
 * from whichever component owns the theme state, so a pack cannot drift out of
 * step with the built-in tokens it is overriding.
 */
function subscribePinned(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

const pinnedTheme = () => document.documentElement.getAttribute("data-theme");

/**
 * Keeps the document's palette in step with the installed pack and the
 * resolved mode. Unpinned resolves through the media query, live, so a pack
 * follows the OS flipping to dark.
 */
export function useThemePack() {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const pinned = useSyncExternalStore(subscribePinned, pinnedTheme, () => null);
  const mode: ThemeMode =
    pinned === "dark" || pinned === "light" ? pinned : prefersDark ? "dark" : "light";
  const pack = useSyncExternalStore(subscribe, installedThemePack, () => null);

  useEffect(() => {
    applyThemePack(pack, mode);
  }, [pack, mode]);

  return { pack, mode, install: installThemePack, uninstall: uninstallThemePack };
}
