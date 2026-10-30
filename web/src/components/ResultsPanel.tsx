import type { Results } from "../lib/api";
import { faceOf } from "./Table";
import { resultStampsAt } from "../lib/motion";

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

const specials = new Set(["?", "coffee"]);

/** Numeric value of a card face, matching the server's cardValue. */
function cardNumeric(v: string): number | undefined {
  if (v === "\u00bd") return 0.5;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Deck face whose numeric equals the median, if any. */
function faceForMedian(median: number, deck: string[]): string | undefined {
  for (const face of deck) {
    const n = cardNumeric(face);
    if (n !== undefined && n === median) return face;
  }
  return undefined;
}

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
  // Homogeneous all-? / all-coffee keeps the "N of N picked …" copy; a mix of
  // both must not pick histogram[0] and claim unanimity.
  if (results.histogram.length > 0 && results.histogram.every((r) => specials.has(r.value))) {
    if (results.histogram.length === 1) {
      const face = faceOf(results.histogram[0].value);
      return {
        value: face,
        save: undefined,
        label: "no estimate",
        sub: `${total} of ${total} picked ${face}`,
      };
    }
    const listed = results.histogram.map((r) => faceOf(r.value)).join(" and ");
    return {
      value: "—",
      save: undefined,
      label: "no estimate",
      sub: `${total} votes · ${listed}`,
    };
  }
  if (results.median !== undefined) {
    const parts = [
      results.average !== undefined ? `average ${round(results.average)}` : null,
      results.mode ? `mode ${faceOf(results.mode)}` : null,
      votes,
    ].filter(Boolean);
    const face = faceForMedian(results.median, deck);
    return {
      value: face ? faceOf(face) : String(results.median),
      save: face,
      label: "median",
      sub: parts.join(" · "),
    };
  }
  // Ordinal decks (t-shirt) have no meaningful average — say so rather than
  // inventing one.
  // "M–M" is one size, not a range. Say what the sizes are, not what the deck is.
  const [lo, hi] = results.range?.split("–") ?? [];
  const parts = [lo && hi && lo !== hi ? `${lo} to ${hi}` : null, votes, "sizes have no average"].filter(
    Boolean,
  );
  return {
    value: results.mode ? faceOf(results.mode) : "—",
    save: saveable(results.mode),
    label: "mode",
    sub: parts.join(" · "),
  };
}

/** Low and high cards of a split round and how many deck steps apart they sit. */
export function spreadText(spread: { low: string; high: string; steps?: number }): string {
  const steps = spread.steps ? ` (${spread.steps} ${spread.steps === 1 ? "step" : "steps"})` : "";
  return `Spread ${faceOf(spread.low)} to ${faceOf(spread.high)}${steps}`;
}

export function spreadOf(results: Results, deck: string[]) {
  if (results.consensus) return undefined;
  const ranked = results.histogram
    .map((r) => ({ face: r.value, n: cardNumeric(r.value) }))
    .filter((r): r is { face: string; n: number } => r.n !== undefined);
  if (ranked.length < 2) return undefined;
  ranked.sort((a, b) => a.n - b.n);
  const low = ranked[0].face;
  const high = ranked[ranked.length - 1].face;
  const steps = deck.indexOf(high) - deck.indexOf(low);
  return { low, high, steps: steps > 0 ? steps : undefined };
}

export function ResultsPanel({ results, deck, still = false }: { results: Results; deck: string[]; still?: boolean }) {
  const hero = heroOf(results, deck);
  const spread = spreadOf(results, deck);
  const max = Math.max(...results.histogram.map((r) => r.count), 1);
  // The closing beat of the reveal, not a fifth effect racing the other four:
  // the number lands once every card is face-up. The cards that turn over are
  // exactly the ones counted here, so the histogram total is the seat count
  // the beat sheet needs.
  const stampAt = resultStampsAt(results.histogram.reduce((n, r) => n + r.count, 0));

  return (
    // The ground follows the field to DAY so a bright table is not immediately
    // followed by a dark panel. A well is the page ground pressed inward and
    // belongs to the hand tray alone; this panel arrives on top of the table,
    // so it rests. The border does the edge work.
    // The stacks keep --color-surface, a token independent of this ground:
    // against DAY-white they would compute 1.08:1 and vanish. They are
    // aria-hidden decoration — the value and count are in the label below —
    // but decoration you cannot see is not decoration, it is a gap.
    <section
      className="flex flex-wrap items-center justify-center gap-8 rounded-panel border border-line px-6 py-7 shadow-rest sm:gap-10 sm:px-8"
      style={{ background: "var(--cue-day)" }}
    >
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          {hero.label}
        </div>
        <div
          className="font-mono leading-none text-ink"
          style={{
            fontSize: "var(--text-num-result)",
            animation: still ? undefined : `stamp-in 350ms var(--ease-settle) ${stampAt}ms both`,
          }}
        >
          {hero.value}
        </div>
        {spread && (
          <div className="mt-1 text-xl font-bold" style={{ color: "var(--color-brass)" }}>
            {spreadText(spread)}
          </div>
        )}
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

      {/* One stack per distinct vote. Three roles and no more: agreement (go) on
          consensus, tension (brass) on the two ends of a spread, neutral for the rest. */}
      <div className="flex items-end gap-6 overflow-x-auto">
        {results.histogram.map((row) => {
          // "Most picked" only means something when one card beat the rest.
          const isMode = results.histogram.length > 1 && max > 1 && row.count === max && results.histogram.filter((r) => r.count === max).length === 1;
          const tone = results.consensus
            ? "var(--color-go)"
            : spread && (row.value === spread.low || row.value === spread.high)
              ? "var(--color-brass)"
              : null;
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
                      background: tone
                        ? `color-mix(in oklab, ${tone} 14%, var(--color-surface))`
                        : "var(--color-surface)",
                      borderColor: tone ?? "var(--color-line)",
                    }}
                  >
                    {faceOf(row.value)}
                  </span>
                ))}
              </div>
              <div
                className="font-mono text-[11px] font-semibold"
                style={{ color: tone ?? (isMode ? "var(--color-ink-soft)" : "var(--color-ink-faint)") }}
              >
                {faceOf(row.value)} ×{row.count}
                {isMode && " · most picked"}
                {spread && row.value === spread.low && " · low"}
                {spread && row.value === spread.high && " · high"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
