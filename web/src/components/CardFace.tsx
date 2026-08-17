// A card in the player's hand. Lift-on-hover and stay-lifted-when-selected are
// the tactile core of The Table.
export function CardFace({
  value,
  selected,
  disabled,
  onClick,
}: {
  value: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={
        "flex aspect-[5/7] w-14 min-w-14 items-center justify-center rounded-card border bg-surface " +
        "font-display text-2xl font-semibold transition-all sm:w-16 " +
        (selected
          ? "-translate-y-2 border-2 border-accent bg-accent-soft shadow-lift"
          : "border-line shadow-rest hover:-translate-y-1.5 hover:shadow-lift") +
        (disabled ? " opacity-40" : "")
      }
      style={{ transitionTimingFunction: "var(--ease-spring)", transitionDuration: "var(--dur-lift)" }}
    >
      {value === "coffee" ? "☕" : value}
    </button>
  );
}

// A participant's card on the table: face-down until reveal, then flips.
export function TableCard({
  value,
  revealed,
  index,
  consensus,
}: {
  value?: string;
  revealed: boolean;
  index: number;
  consensus: boolean;
}) {
  return (
    <span className="inline-block aspect-[5/7] w-12 sm:w-14" style={{ perspective: "600px" }}>
      <span
        className="relative block h-full w-full transition-transform"
        style={{
          transformStyle: "preserve-3d",
          transitionDuration: "var(--dur-flip)",
          transitionDelay: revealed ? `calc(${index} * var(--dur-stagger))` : "0ms",
          transform: revealed ? "rotateY(180deg)" : "rotateY(0deg)",
          animation: consensus && revealed ? `card-hop 0.5s var(--ease-spring) calc(0.4s + ${index} * 0ms)` : undefined,
        }}
      >
        <span
          className="absolute inset-0 rounded-card bg-card-back shadow-rest"
          style={{ backfaceVisibility: "hidden" }}
        >
          <span className="absolute inset-2 rounded-chip border border-accent-ink/20" />
        </span>
        <span
          className="absolute inset-0 flex items-center justify-center rounded-card border border-line bg-surface font-display text-xl font-semibold shadow-rest"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          {value === "coffee" ? "☕" : value}
        </span>
      </span>
    </span>
  );
}
