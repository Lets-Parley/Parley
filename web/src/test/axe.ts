import axe from "axe-core";
import { expect } from "vitest";

/**
 * Fails the test with axe's own description of every WCAG 2 A/AA violation it
 * finds in `container`. jsdom has no layout, so the rules that need geometry
 * (colour contrast, target size) sit this out — those belong to a real browser.
 * What this does catch is the bulk of what regresses in review: unlabelled
 * controls, wrong roles, missing alt text, skipped heading levels, broken aria.
 */
export async function expectNoViolations(container: HTMLElement) {
  const { violations } = await axe.run(container, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    // ponytail: needs layout, so it can only ever be a false negative here.
    rules: { "color-contrast": { enabled: false } },
  });
  expect(
    violations.map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.html).join("\n  ")}`),
  ).toEqual([]);
}
