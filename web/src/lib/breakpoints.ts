/**
 * Named viewport tiers for Parley. Values match Tailwind v4 defaults and the
 * `--bp-*` custom properties in tokens.css — change one, change both, and let
 * breakpoints.test.ts catch a drift.
 *
 * Layout contract (participant-first; facilitator-on-phone is supported but not
 * the primary design target):
 *
 * - **phone** (< md / 768px): single column, sidebar as a sheet, poker hand
 *   gridded for thumbs, story queue stacked below the table.
 * - **tablet** (md–lg / 768–1023px): sidebar rail when open, denser header,
 *   story queue still stacked until lg.
 * - **desktop** (≥ lg / 1024px): story queue beside the table, avatar stack in
 *   the header, widest poker table ranks.
 */
export const BREAKPOINTS = {
  sm: { min: 640 },
  md: { min: 768 },
  lg: { min: 1024 },
} as const;

/** WCAG 2.5.5 target size — also Apple HIG minimum for touch. */
export const TOUCH_TARGET_MIN = 44;

/** Tailwind utility class — min 44×44px hit area. */
export const TOUCH_HIT = "touch-hit";

export function minWidthQuery(px: number): string {
  return `(min-width: ${px}px)`;
}

/** Sidebar rail vs sheet threshold (768px / md). */
export const SIDEBAR_RAIL_QUERY = minWidthQuery(BREAKPOINTS.md.min);
