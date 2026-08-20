import { kindLabel } from "../lib/kinds";

/*
 * How a session kind names itself: an icon for flair, the label for meaning.
 * `pads` is indexed by a `keyof typeof pads` union, so only "sm" and "md" can
 * reach it — a stray "__proto__" would need an untyped caller, and there is
 * no untyped call site.
 */
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
      // One card face-on, with the edge of the card behind it showing. At 14px
      // a second full outline would fuse with the first: every stroke here is
      // at least 1.9 units of centreline from its neighbour, comfortably clear
      // of the 1.25 it is drawn with.
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden
        >
          <rect x="2.6" y="3.2" width="6.2" height="7.6" rx="1.1" />
          <line x1="10.8" y1="4.6" x2="10.8" y2="9.4" />
        </svg>
      );
    case "standup":
      // A person with one arc of speech coming off them. One arc, not two:
      // two nested arcs small enough to fit beside the head merge into a
      // smudge at 14px. Same 1.9-unit floor between neighbouring strokes.
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden
        >
          <circle cx="4.6" cy="4" r="1.9" />
          <path d="M1.3 11.4a3.3 3.3 0 0 1 6.6 0" />
          <path d="M10.19 4.4a3.4 3.4 0 0 1 0 5.2" />
        </svg>
      );
    default:
      return null;
  }
}
