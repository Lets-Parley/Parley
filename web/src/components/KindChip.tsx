import { kindLabel } from "../lib/kinds";

/** How a session kind names itself: an icon for flair, the label for meaning. */
const pads = { sm: "gap-1 px-1.5 py-0.5", md: "gap-1.5 px-2.5 py-1" } as const;

type Props = { kind: string; size?: keyof typeof pads };

export function KindChip({ kind, size = "md" }: Props) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded-full border border-line bg-surface-hi " +
        "font-mono text-[10px] tracking-[0.06em] text-ink-soft " +
        pads[size]
      }
    >
      <KindIcon kind={kind} />
      {kindLabel(kind)}
    </span>
  );
}

/*
 * Hand-rolled line art rather than an icon dependency, following `GraceRing`
 * in PokerRoom. It diverges from GraceRing on colour deliberately: that gauge
 * strokes `var(--color-line)` / `var(--color-brass)` because its arcs mean
 * something on their own, whereas a chip glyph only ever decorates the label
 * beside it — so it inherits `currentColor` and the two cannot drift apart.
 * An unregistered kind has no glyph; the chip stays text-only, never icon-only.
 */
function KindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "poker":
      // Two cards, the back one fanned out from behind the front.
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden
        >
          <rect x="1.6" y="3.1" width="5.2" height="8" rx="1.1" transform="rotate(-16 4.2 7.1)" />
          <rect x="6.6" y="2.9" width="5.8" height="8.4" rx="1.2" />
        </svg>
      );
    case "standup":
      // A person, with two arcs for the speaking they stand up to do.
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          className="shrink-0"
          aria-hidden
        >
          <circle cx="5" cy="4.25" r="2.05" />
          <path d="M1.6 11.6a3.4 3.4 0 0 1 6.8 0" />
          <path d="M10.2 5.4a1.6 1.6 0 0 1 0 3.2" />
          <path d="M12 3.9a3.6 3.6 0 0 1 0 6.2" />
        </svg>
      );
    default:
      return null;
  }
}
