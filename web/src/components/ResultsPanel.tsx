import type { Results } from "../lib/api";
import { faceOf } from "./Table";

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** The one number the room agreed on, and the shape of how it got there. */
export function heroOf(results: Results): { value: string; label: string; sub: string } {
  const total = results.histogram.reduce((n, r) => n + r.count, 0);
  const votes = `${total} ${total === 1 ? "vote" : "votes"}`;

  if (results.consensus) {
    const only = results.histogram[0]?.value ?? "—";
    return { value: faceOf(only), label: "consensus", sub: `${total} of ${total} picked ${faceOf(only)}` };
  }
  if (results.median !== undefined) {
    const parts = [
      results.average !== undefined ? `average ${round(results.average)}` : null,
      results.mode ? `mode ${faceOf(results.mode)}` : null,
      votes,
    ].filter(Boolean);
    return { value: String(results.median), label: "median", sub: parts.join(" · ") };
  }
  // Ordinal decks (t-shirt) have no meaningful average — say so rather than
  // inventing one.
  const parts = [
    results.range ? `range ${results.range}` : null,
    votes,
    "ordinal deck, no average",
  ].filter(Boolean);
  return { value: faceOf(results.mode ?? "—"), label: "mode", sub: parts.join(" · ") };
}

export function ResultsPanel({ results }: { results: Results }) {
  const hero = heroOf(results);
  const max = Math.max(...results.histogram.map((r) => r.count), 1);

  return (
    <section className="flex flex-wrap items-center justify-center gap-8 rounded-panel bg-felt-deep px-6 py-7 shadow-well sm:gap-10 sm:px-8">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          {hero.label}
        </div>
        <div
          className="font-display leading-none text-ink"
          style={{ fontSize: "var(--text-num-result)", animation: "stamp-in 350ms var(--ease-settle) 560ms both" }}
        >
          {hero.value}
        </div>
        <div className="mt-1 text-[13px] font-semibold text-ink-soft">{hero.sub}</div>
        {results.consensus && (
          <div
            className="mt-2.5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-bold text-go"
            style={{ background: "color-mix(in oklab, var(--color-go) 14%, var(--color-surface))" }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-go" />
            Consensus — nice.
          </div>
        )}
      </div>

      {/* One stack per distinct vote; the tallest stack wears brass. */}
      <div className="flex items-end gap-6 overflow-x-auto">
        {results.histogram.map((row) => {
          const isMode = row.count === max;
          return (
            <div key={row.value} className="flex shrink-0 flex-col items-center gap-2">
              <div className="flex flex-col-reverse">
                {Array.from({ length: row.count }, (_, j) => (
                  <span
                    key={j}
                    className="flex h-[62px] w-[46px] items-center justify-center rounded-chip border font-display text-lg text-ink shadow-rest"
                    style={{
                      marginBottom: j ? -46 : 0,
                      background: isMode
                        ? "color-mix(in oklab, var(--color-brass) 14%, var(--color-surface))"
                        : "var(--color-surface)",
                      borderColor: isMode ? "var(--color-brass)" : "var(--color-line)",
                    }}
                  >
                    {faceOf(row.value)}
                  </span>
                ))}
              </div>
              <div
                className="font-mono text-[11px] font-semibold"
                style={{ color: isMode ? "var(--color-brass)" : "var(--color-ink-faint)" }}
              >
                {faceOf(row.value)} ×{row.count}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
