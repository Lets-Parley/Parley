/**
 * One thing you can wear on top of the mark: a hat, a patch, a halo.
 *
 * Same contract as the crew in `avatarIcons`: `currentColor` only, the ids are
 * the wire format and opaque to the server, and an id this build does not hold
 * is not an error — it simply draws nothing.
 *
 * Every silhouette is authored inside a 24x12 box, the top half of the disc.
 * <Avatar> pins the overlay to the top edge at half height, so an accessory
 * cannot reach the bottom-right corner where the facilitator dot sits.
 */
import type { ReactNode } from "react";

/** Path data only — <Avatar> supplies the <svg> wrapper and its sizing. */
const paths: Record<string, ReactNode> = {
  captain: (
    <path d="M7 3.2C7 1.4 8.4 0 10.2 0h3.6C15.6 0 17 1.4 17 3.2V6H7V3.2zM3.5 7.4h17a1.3 1.3 0 0 1 0 2.6h-17a1.3 1.3 0 0 1 0-2.6z" />
  ),
  hardhat: (
    <path d="M12 1a5.6 5.6 0 0 0-5.6 5.6V8h11.2V6.6A5.6 5.6 0 0 0 12 1zM2.6 9.2h18.8a1.3 1.3 0 0 1 0 2.6H2.6a1.3 1.3 0 0 1 0-2.6z" />
  ),
  eyepatch: <path d="M1.6 3.4h20.8v1.8H1.6V3.4zM8 4.6h6v3.6a3 3 0 0 1-6 0V4.6z" />,
  halo: (
    <ellipse cx="12" cy="4.6" rx="6.6" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
  ),
  monocle: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="9" cy="5.4" r="4.2" />
      <path d="M13.4 7.6c1.9 1 2.9 2.3 3 4.2" />
    </g>
  ),
  headset: (
    <path d="M12 0a8.6 8.6 0 0 0-8.6 8.6V12H6V8.6a6 6 0 0 1 12 0V12h2.6V8.6A8.6 8.6 0 0 0 12 0zM2 7.6h2.6a1 1 0 0 1 1 1V12H3a1 1 0 0 1-1-1V7.6zm17.4 0H22V11a1 1 0 0 1-1 1h-2.6V8.6a1 1 0 0 1 1-1z" />
  ),
};

export const avatarAccessoryIds = Object.keys(paths);

/** Human wording for the picker. */
export const avatarAccessoryLabels: Record<string, string> = {
  captain: "Captain's hat",
  hardhat: "Hard hat",
  eyepatch: "Eyepatch",
  halo: "Halo",
  monocle: "Monocle",
  headset: "Headset",
};

/**
 * The overlay for an id, or null for an id this build does not know — the same
 * graceful degradation the crew icons get, so a newer client's choice costs a
 * missing hat rather than a broken chip.
 */
export function avatarAccessory(id: string | undefined): ReactNode | null {
  return (id && paths[id]) ?? null;
}
