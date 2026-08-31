import { safeDisplayName } from "../lib/displayName";
import { avatarIcon } from "./avatarIcons";

const sizes = { xs: 24, sm: 28, md: 38, lg: 46 } as const;

export function initialsOf(name: string): string {
  const parts = safeDisplayName(name).trim().split(/\s+/).filter(Boolean);
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
  // portrait survives. Initials always win there.
  if (size === "xs") return initialsOf(name);
  const portrait = avatarIcon(icon);
  // Unset, or an id this build does not know — a newer client's choice
  // degrades to initials instead of to a blank chip.
  if (!portrait) return initialsOf(name);
  // Filling the disc rather than sitting inside it: at 38px a portrait inset
  // to 62% is mush. Rounded to the disc, because the art is a square.
  return (
    <img
      src={portrait}
      alt=""
      aria-hidden
      width={px}
      height={px}
      draggable={false}
      className="rounded-full"
    />
  );
}

type Props = {
  name: string;
  hue: number;
  /** The chosen portrait id, opaque to the server. Unknown ids fall back to initials. */
  icon?: string;
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
  size = "md",
  facilitator,
  spectator,
  dim,
  decorative,
}: Props) {
  const px = sizes[size];
  // Bidi overrides in a display name can flip surrounding UI chrome; the
  // chip's label and initials both go through the same neutralization.
  const shown = safeDisplayName(name);
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
        background: `oklch(0.52 0.09 ${185 + ((((hue % 360) + 360) % 360) / 360) * 105})`,
        color: "#F4F8FB",
        boxShadow:
          "0 0 0 2px var(--color-surface), 0 0 0 3px var(--color-line)",
        // The initials are not held to 4.5:1 — every avatar carries the name
        // as text, in aria-label and usually beside it, so the glyphs are a
        // redundant mark. 0.7 is a legibility floor, not a compliance one:
        // it measures 2.90:1 light / 3.73:1 dark at the worst hue in the arc,
        // against 2.23 / 3.05 at the old 0.55. See the contrast doc.
        opacity: spectator || dim ? 0.7 : 1,
      }}
      title={decorative ? undefined : shown}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : shown}
    >
      {face(shown, size, px, icon)}
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
