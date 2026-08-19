const sizes = { xs: 24, sm: 28, md: 38, lg: 46 } as const;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type Props = {
  name: string;
  hue: number;
  size?: keyof typeof sizes;
  facilitator?: boolean;
  spectator?: boolean;
  /** Offline — the seat is still theirs, the chip just goes quiet. */
  dim?: boolean;
};

export function Avatar({ name, hue, size = "md", facilitator, spectator, dim }: Props) {
  const px = sizes[size];
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
        opacity: spectator || dim ? 0.55 : 1,
      }}
      title={name}
      role="img"
      aria-label={name}
    >
      {initialsOf(name)}
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
