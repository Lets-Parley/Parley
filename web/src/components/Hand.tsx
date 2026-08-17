import type { CSSProperties } from "react";
import { faceOf } from "./Table";

// Your hand sits in a felt well at the bottom of the table. On a phone it
// becomes the bottom sheet: same cards, gridded so every one is thumb-reachable.
export function Hand({
  values,
  deckName,
  selected,
  disabled,
  spectating,
  canSpectate,
  onPick,
  onToggleSpectate,
}: {
  values: string[];
  deckName: string;
  selected: string | null;
  disabled?: boolean;
  spectating: boolean;
  canSpectate: boolean;
  onPick: (value: string) => void;
  onToggleSpectate: () => void;
}) {
  const mid = (values.length - 1) / 2;

  return (
    <section className="mx-auto w-full max-w-[780px] rounded-panel bg-felt-deep px-4 pb-6 pt-4 shadow-well sm:px-6">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[11px] tracking-[0.06em] text-ink-faint">
          YOUR HAND · {deckName}
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] sm:hidden" style={{ color: selected ? "var(--color-go)" : "var(--color-ink-faint)" }}>
            {selected ? `picked ${faceOf(selected)}` : "pick a card"}
          </span>
          {canSpectate && (
            <button
              onClick={onToggleSpectate}
              className={
                "rounded-full border border-line px-3 py-1 font-mono text-[10px] text-ink-soft " +
                (spectating ? "bg-accent-soft" : "hover:bg-surface")
              }
            >
              {spectating ? "SPECTATING · REJOIN" : "SPECTATE"}
            </button>
          )}
        </div>
      </div>

      {spectating ? (
        <p className="py-5 text-center text-sm text-ink-faint">
          You're at the rail — watching this round, no hand. Your seat is kept warm.
        </p>
      ) : (
        <div className="grid grid-cols-5 justify-center gap-2 sm:flex sm:flex-wrap sm:gap-2.5">
          {values.map((v, i) => {
            const isSel = selected === v && !disabled;
            return (
              <button
                key={v}
                onClick={() => onPick(v)}
                disabled={disabled}
                aria-pressed={isSel}
                className={
                  "hand-card flex h-16 items-center justify-center rounded-card border bg-surface font-display text-ink shadow-rest " +
                  "sm:h-[90px] sm:w-16 " +
                  (isSel
                    ? "border-2 border-accent bg-accent-soft shadow-lift"
                    : "border-line hover:shadow-lift") +
                  (disabled ? " cursor-not-allowed opacity-45" : "")
                }
                style={
                  {
                    fontSize: v.length > 2 ? "1.35rem" : v.length > 1 ? "1.7rem" : "2.2rem",
                    "--rot": `${((i - mid) * 1.6).toFixed(1)}deg`,
                  } as CSSProperties
                }
              >
                {faceOf(v)}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
