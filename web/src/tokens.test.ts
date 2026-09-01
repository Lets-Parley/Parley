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
