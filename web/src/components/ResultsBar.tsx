import type { Results } from "../lib/api";

export function ResultsBar({ results }: { results: Results }) {
  const max = Math.max(...results.histogram.map((r) => r.count), 1);
  const hero =
    results.median !== undefined
      ? String(results.median)
      : (results.mode ?? "—");
  const heroLabel = results.median !== undefined ? "median" : "mode";

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-center">
        <div className="text-sm font-bold uppercase tracking-wide text-ink-soft">
          {results.consensus ? "consensus!" : heroLabel}
        </div>
        <div className="font-display font-semibold" style={{ fontSize: "var(--text-num-result)", lineHeight: 1 }}>
          {hero}
        </div>
        <div className="font-mono text-sm text-ink-soft">
          {results.average !== undefined && <>avg {round(results.average)} · </>}
          {results.range !== undefined && <>range {results.range} · </>}
          {results.histogram.reduce((n, r) => n + r.count, 0)} votes
        </div>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {results.histogram.map((row) => (
          <div key={row.value} className="flex items-center gap-3">
            <span className="w-10 text-right font-display text-lg font-semibold">
              {row.value === "coffee" ? "☕" : row.value}
            </span>
            <div className="h-6 flex-1 overflow-hidden rounded-chip bg-felt-deep shadow-well">
              <div
                className={
                  "h-full rounded-chip transition-all " +
                  (row.count === max ? "bg-brass" : "bg-accent/70")
                }
                style={{
                  width: `${(row.count / max) * 100}%`,
                  transitionDuration: "400ms",
                  transitionTimingFunction: "var(--ease-settle)",
                }}
              />
            </div>
            <span className="w-6 font-mono text-sm text-ink-soft">{row.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
