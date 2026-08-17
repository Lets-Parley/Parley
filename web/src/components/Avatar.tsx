const sizes = { sm: 24, md: 32, lg: 40 } as const;

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
};

export function Avatar({ name, hue, size = "md", facilitator, spectator }: Props) {
  const px = sizes[size];
  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full font-bold select-none ring-1 ring-line"
      style={{
        width: px,
        height: px,
        fontSize: px * 0.38,
        background: `oklch(0.82 0.06 ${hue})`,
        color: `oklch(0.32 0.05 ${hue})`,
        opacity: spectator ? 0.7 : 1,
      }}
      title={name}
      aria-label={name}
    >
      {initialsOf(name)}
      {facilitator && (
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full bg-brass ring-2 ring-surface"
          style={{ width: px * 0.28, height: px * 0.28 }}
          aria-label="facilitator"
        />
      )}
    </span>
  );
}
