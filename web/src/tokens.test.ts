import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// jsdom does not compute CSS custom properties, so this test reads the
// stylesheet source directly and asserts on its text instead of on
// rendered styles.
const cssPath = path.resolve(__dirname, "./tokens.css");
const css = readFileSync(cssPath, "utf-8");

/** Extract the body of a top-level block by its opening selector line. */
function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start === -1) {
    throw new Error(`selector not found: ${selector}`);
  }
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  let i = openBrace;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(openBrace + 1, i);
}

function declaredColorTokens(blockText: string): string[] {
  const matches = blockText.matchAll(/(--color-[a-z-]+)\s*:/g);
  return [...matches].map((m) => m[1]);
}

const rootBlock = extractBlock(css, ":root {");
const darkMediaOuter = extractBlock(css, "@media (prefers-color-scheme: dark)");
const darkMediaBlock = extractBlock(darkMediaOuter, ':root:not([data-theme="light"])');
const darkAttrBlock = extractBlock(css, ':root[data-theme="dark"]');

const rootTokens = declaredColorTokens(rootBlock);

describe("tokens.css dark-mode coverage", () => {
  it("declares at least one --color-* token on :root", () => {
    expect(rootTokens.length).toBeGreaterThan(0);
  });

  it.each(rootTokens)(
    "%s declared on :root is also declared in the prefers-color-scheme dark block",
    (token) => {
      const count = declaredColorTokens(darkMediaBlock).filter((t) => t === token).length;
      expect(count).toBe(1);
    },
  );

  it.each(rootTokens)(
    "%s declared on :root is also declared in the :root[data-theme=\"dark\"] block",
    (token) => {
      const count = declaredColorTokens(darkAttrBlock).filter((t) => t === token).length;
      expect(count).toBe(1);
    },
  );

  it("has no duplicate --color-* declarations within the prefers-color-scheme dark block", () => {
    const tokens = declaredColorTokens(darkMediaBlock);
    const duplicates = tokens.filter((t, i) => tokens.indexOf(t) !== i);
    expect(duplicates).toEqual([]);
  });

  it("has no duplicate --color-* declarations within the :root[data-theme=\"dark\"] block", () => {
    const tokens = declaredColorTokens(darkAttrBlock);
    const duplicates = tokens.filter((t, i) => tokens.indexOf(t) !== i);
    expect(duplicates).toEqual([]);
  });
});

/*
 * Tailwind v4 stopped giving buttons the browser's cursor:pointer, and the app
 * shipped a screenful of controls that looked inert. The fix is a single base
 * rule, so the regression guard is a single assertion on it: jsdom computes no
 * cascade, and one true `cursor: pointer` in the source is the whole contract.
 */
describe("base cursor", () => {
  const base = extractBlock(css, "@layer base");

  it("gives enabled buttons a pointer", () => {
    expect(base).toContain("button:not(:disabled)");
    expect(base).toMatch(/cursor:\s*pointer/);
  });

  it("leaves disabled buttons alone", () => {
    // A bare `button {}` would hand a pointer to a control that does nothing.
    expect(base).not.toMatch(/(^|,|\s)button\s*[,{]/);
  });
});

describe("responsive tokens", () => {
  it("limits hand-card lift to fine pointers", () => {
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)/);
    expect(css).toMatch(/\.hand-card:hover:not\(:disabled\)/);
  });

  it("defines the touch-hit utility", () => {
    expect(css).toMatch(/@layer utilities[\s\S]*\.touch-hit/);
  });
});

/* --- Contrast, computed rather than asserted in a comment ------------------
 *
 * `line-strong` exists for exactly one reason: WCAG 2.2 AA 1.4.11 wants 3:1 on
 * the boundary that identifies a control, and `line` — a deliberately faint
 * hairline — measures 1.17–1.75 against the grounds those controls sit on. A
 * number that lives only in a commit message is a number nothing defends, and
 * the next person to warm up a surface by a few percent would take the token
 * under the floor with nothing going red.
 */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The value of a token as declared inside one block. */
function tokenValue(blockText: string, token: string): string {
  const m = blockText.match(new RegExp(`${token}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`no value for ${token}`);
  return m[1].toUpperCase();
}

/** Every ground a free-standing control is drawn on. */
const CONTROL_GROUNDS = ["--color-felt", "--color-felt-deep", "--color-surface", "--color-surface-hi"];

describe("control boundary contrast", () => {
  for (const [themeName, block] of [
    ["light", rootBlock],
    ["dark", darkAttrBlock],
  ] as const) {
    it(`line-strong clears 3:1 on every control ground in the ${themeName} theme`, () => {
      const boundary = tokenValue(block, "--color-line-strong");
      for (const ground of CONTROL_GROUNDS) {
        const ratio = contrastRatio(boundary, tokenValue(block, ground));
        expect(
          ratio,
          `${boundary} on ${ground} (${themeName}) is ${ratio.toFixed(3)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("keeps a margin over the floor, so a surface tweak cannot silently break it", () => {
    const worst = Math.min(
      ...([rootBlock, darkAttrBlock].flatMap((block) =>
        CONTROL_GROUNDS.map((ground) =>
          contrastRatio(tokenValue(block, "--color-line-strong"), tokenValue(block, ground)),
        ),
      )),
    );
    expect(worst).toBeGreaterThanOrEqual(3.2);
  });

  it("documents why line itself cannot serve as a control boundary", () => {
    // Not a regression guard — a record of the measurement that justifies the
    // second token existing at all. If someone darkens `line` enough to pass
    // on its own, this fails and the extra token can be reconsidered.
    const worstLine = Math.min(
      ...([rootBlock, darkAttrBlock].flatMap((block) =>
        CONTROL_GROUNDS.map((ground) =>
          contrastRatio(tokenValue(block, "--color-line"), tokenValue(block, ground)),
        ),
      )),
    );
    expect(worstLine).toBeLessThan(3);
  });
});
