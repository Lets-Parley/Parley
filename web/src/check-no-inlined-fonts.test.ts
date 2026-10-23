import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const webRoot = path.join(here, "..");
const dist = path.join(webRoot, "dist");
const assets = path.join(dist, "assets");
const capitalFixture = path.join(assets, "__inlined-font-fixture.css");
const lowercaseFixture = path.join(assets, "__inlined-font-fixture-lower.css");
const scanner = path.join(webRoot, "scripts", "check-no-inlined-fonts.mjs");

afterEach(() => {
  rmSync(capitalFixture, { force: true });
  rmSync(lowercaseFixture, { force: true });
});

function scanFixture(file: string, css: string) {
  mkdirSync(assets, { recursive: true });
  writeFileSync(file, css);
  return spawnSync(process.execPath, [scanner], {
    cwd: webRoot,
    encoding: "utf8",
  });
}

describe("check-no-inlined-fonts", () => {
  it("is the last step of the production frontend build", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(webRoot, "package.json"), "utf-8"),
    ) as { scripts: { build: string } };
    const steps = pkg.scripts.build.split("&&").map((s) => s.trim());
    expect(steps.at(-1)).toBe("node scripts/check-no-inlined-fonts.mjs");
  });

  it("fails the build when a CSS file inlines a font, even with a capitalised data URL", () => {
    const result = scanFixture(
      capitalFixture,
      "@font-face{font-family:JetBrains Mono;src:url(DATA:FONT/woff2;base64,AA==)}",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("assets/");
    expect(result.stderr).toMatch(
      /check-no-inlined-fonts: .* inlined JetBrains Mono as DATA:FONT\/woff2/,
    );
  });

  it("fails the build when a CSS file inlines a font with a lowercase data URL", () => {
    const result = scanFixture(
      lowercaseFixture,
      "@font-face{font-family:JetBrains Mono;src:url(data:font/woff2;base64,AA==)}",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("assets/");
    expect(result.stderr).toMatch(
      /check-no-inlined-fonts: .* inlined JetBrains Mono as data:font\/woff2/,
    );
  });
});
