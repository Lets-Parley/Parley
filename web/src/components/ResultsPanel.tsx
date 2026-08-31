import type { Results } from "../lib/api";
import { faceOf } from "./Table";

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

const specials = new Set(["?", "coffee"]);

/**
 * The one number the room agreed on, and the shape of how it got there.
 *
 * `value` is for reading and `save` is for keeping, and they are not always the
 * same string: the coffee card reads "☕" and a room that only played specials
 * has a hero to show but nothing worth writing onto the story. A median can
 * land between two cards (3 and 5 give 4), and the server only accepts a card
 * from `deck`, so that median is shown and not offered for saving.
 */
export function heroOf(
  results: Results,
  deck: string[],
): { value: string; save?: string; label: string; sub: string } {
  const total = results.histogram.reduce((n, r) => n + r.count, 0);
  const votes = `${total} ${total === 1 ? "vote" : "votes"}`;
  const saveable = (v?: string) => (v && !specials.has(v) ? v : undefined);

  if (results.consensus) {
    const only = results.histogram[0]?.value;
    return {
      value: only ? faceOf(only) : "—",
      save: saveable(only),
      label: "consensus",
      sub: `${total} of ${total} picked ${only ? faceOf(only) : "—"}`,
    };
  }
  // All-specials with no consensus (everyone played ? or coffee) is not an
  // ordinal deck — naming it one was the fallback before this branch existed.
  if (results.histogram.length > 0 && results.histogram.every((r) => specials.has(r.value))) {
    const face = faceOf(results.histogram[0].value);
    return {
      value: face,
      save: undefined,
      label: "no estimate",
      sub: `${total} of ${total} picked ${face}`,
    };
  }
  if (results.median !== undefined) {
    const parts = [
      results.average !== undefined ? `average ${round(results.average)}` : null,
      results.mode ? `mode ${faceOf(results.mode)}` : null,
      votes,
    ].filter(Boolean);
    const median = String(results.median);
    return {
      value: median,
      save: deck.includes(median) ? median : undefined,
      label: "median",
      sub: parts.join(" · "),
    };
  }
  // Ordinal decks (t-shirt) have no meaningful average — say so rather than
  // inventing one.
  const parts = [
    results.range ? `range ${results.range}` : null,
    votes,
    "ordinal deck, no average",
  ].filter(Boolean);
  return {
    value: results.mode ? faceOf(results.mode) : "—",
    save: saveable(results.mode),
    label: "mode",
    sub: parts.join(" · "),
  };
}

export function ResultsPanel({ results }: { results: Results }) {
  const hero = heroOf(results, []);
  const max = Math.max(...results.histogram.map((r) => r.count), 1);

  return (
    // The ground follows the field to DAY so a bright table is not immediately
    // followed by a dark well. --shadow-well was tuned against a darker ground,
    // so the border does the "pressed" work now rather than a heavier shadow.
    // The stacks keep --color-surface, a token independent of this ground:
    // against DAY-white they would compute 1.08:1 and vanish. They are
    // aria-hidden decoration — the value and count are in the label below —
    // but decoration you cannot see is not decoration, it is a gap.
    <section
      className="flex flex-wrap items-center justify-center gap-8 rounded-panel border border-line px-6 py-7 shadow-well sm:gap-10 sm:px-8"
      style={{ background: "var(--cue-day)" }}
    >
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          {hero.label}
        </div>
        <div
          className="font-mono leading-none text-ink"
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

      {/* One stack per distinct vote; the tallest stack wears the settled tone. */}
      <div className="flex items-end gap-6 overflow-x-auto">
        {results.histogram.map((row) => {
          const isMode = row.count === max;
          return (
            <div key={row.value} className="flex shrink-0 flex-col items-center gap-2">
              {/* The stack is the text label drawn as cards; one voice is enough. */}
              <div className="flex flex-col-reverse" aria-hidden="true">
                {Array.from({ length: row.count }, (_, j) => (
                  <span
                    key={j}
                    className="flex h-[62px] w-[46px] items-center justify-center rounded-chip border font-mono text-lg text-ink shadow-rest"
                    style={{
                      marginBottom: j ? -46 : 0,
                      background: isMode
                        ? "color-mix(in oklab, var(--color-settled) 14%, var(--color-surface))"
                        : "var(--color-surface)",
                      borderColor: isMode ? "var(--color-settled)" : "var(--color-line)",
                    }}
                  >
                    {faceOf(row.value)}
                  </span>
                ))}
              </div>
              <div
                className="font-mono text-[11px] font-semibold"
                style={{ color: isMode ? "var(--color-settled)" : "var(--color-ink-faint)" }}
              >
                {faceOf(row.value)} ×{row.count}
                {isMode && " · most picked"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
