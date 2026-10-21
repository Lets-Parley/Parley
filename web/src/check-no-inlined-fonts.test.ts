import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const webRoot = path.join(here, "..");
const dist = path.join(webRoot, "dist");
const fixture = path.join(dist, "__inlined-font-fixture.css");
const scanner = path.join(webRoot, "scripts", "check-no-inlined-fonts.mjs");

afterEach(() => {
  rmSync(fixture, { force: true });
});

describe("check-no-inlined-fonts", () => {
  it("is the last step of the production frontend build", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(webRoot, "package.json"), "utf-8"),
    ) as { scripts: { build: string } };
    expect(pkg.scripts.build.endsWith("node scripts/check-no-inlined-fonts.mjs")).toBe(
      true,
    );
  });

  it("fails the build when a CSS file inlines a font, even with a capitalised data URL", () => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      fixture,
      "@font-face{font-family:JetBrains Mono;src:url(DATA:FONT/woff2;base64,AA==)}",
    );

    const result = spawnSync(process.execPath, [scanner], {
      cwd: webRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /check-no-inlined-fonts: .* inlined JetBrains Mono as DATA:FONT\/woff2/,
    );
  });
});
