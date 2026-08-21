import { avatarAccessory } from "./avatarAccessories";
import { avatarIcon } from "./avatarIcons";

const sizes = { xs: 24, sm: 28, md: 38, lg: 46 } as const;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The mark inside the disc.
 *
 * Written as early returns so the "no avatar chosen" case — still every
 * person on a fresh install — keeps its own branch and renders exactly the
 * initials it always did, rather than falling out of a conditional woven
 * through a restructured tree.
 */
function face(name: string, size: keyof typeof sizes, px: number, icon?: string) {
  // At 24px the facilitator dot leaves roughly 10px of clear area, which no
  // detailed silhouette survives. Initials always win there.
  if (size === "xs") return initialsOf(name);
  const glyph = avatarIcon(icon);
  // Unset, or an id this build does not know — a newer client's choice
  // degrades to initials instead of to a blank chip.
  if (!glyph) return initialsOf(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={Math.round(px * 0.62)}
      height={Math.round(px * 0.62)}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      {glyph}
    </svg>
  );
}

type Props = {
  name: string;
  hue: number;
  /** The chosen icon id, opaque to the server. Unknown ids fall back to initials. */
  icon?: string;
  /** The chosen accessory id, opaque to the server. Unknown ids draw nothing. */
  accessory?: string;
  size?: keyof typeof sizes;
  facilitator?: boolean;
  spectator?: boolean;
  /** Offline — the seat is still theirs, the chip just goes quiet. */
  dim?: boolean;
  /** Beside a label that already names this person. The chip is then
      decoration, and announcing the name again makes a reader stutter. */
  decorative?: boolean;
};

export function Avatar({
  name,
  hue,
  icon,
  accessory,
  size = "md",
  facilitator,
  spectator,
  dim,
  decorative,
}: Props) {
  const px = sizes[size];
  // Suppressed at xs alongside the glyph: 10px of clear area holds neither.
  const worn = size === "xs" ? null : avatarAccessory(accessory);
  return (
    <span
      className="relative inline-flex select-none items-center justify-center rounded-full font-bold"
      style={{
        width: px,
        height: px,
        fontSize: Math.round(px * 0.34),
        // Identity hue folded into the maritime arc, verdigris through harbour
        // blue to indigo — distinguishable chips that still read as one signal
        // set, never a stray warm orange.
        background: `oklch(0.52 0.09 ${185 + (((hue % 360) + 360) % 360) / 360 * 105})`,
        color: "#F4F8FB",
        boxShadow: "0 0 0 2px var(--color-surface), 0 0 0 3px var(--color-line)",
        // The initials are not held to 4.5:1 — every avatar carries the name
        // as text, in aria-label and usually beside it, so the glyphs are a
        // redundant mark. 0.7 is a legibility floor, not a compliance one:
        // it measures 2.90:1 light / 3.73:1 dark at the worst hue in the arc,
        // against 2.23 / 3.05 at the old 0.55. See the contrast doc.
        opacity: spectator || dim ? 0.7 : 1,
      }}
      title={decorative ? undefined : name}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : name}
    >
      {face(name, size, px, icon)}
      {worn && (
        // Pinned to the top edge and never more than half the disc tall. The
        // facilitator dot lives in the bottom-right corner, so confining the
        // overlay to the top band is what keeps the two from ever meeting.
        <span
          className="pointer-events-none absolute"
          style={{
            top: 0,
            left: px * 0.15,
            width: px * 0.7,
            height: px * 0.35,
          }}
          data-accessory={accessory}
        >
          <svg
            viewBox="0 0 24 12"
            width={px * 0.7}
            height={px * 0.35}
            fill="currentColor"
            aria-hidden
            focusable="false"
          >
            {worn}
          </svg>
        </span>
      )}
      {facilitator && (
        <span
          className="absolute -right-px -bottom-px rounded-full bg-brass"
          style={{
            width: Math.max(8, px * 0.26),
            height: Math.max(8, px * 0.26),
            boxShadow: "0 0 0 2px var(--color-surface)",
          }}
          title="Facilitator"
          role="img"
          aria-label="facilitator"
        />
      )}
    </span>
  );
}
