import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { standupTrendApi } from "../lib/paths";
import { TOUCH_HIT } from "../lib/breakpoints";
import { AwayDays } from "./AwayDays";
import { RailError, railHeading } from "./Kudos";

type TrendWeek = { weekStart: string; ratio?: number; suppressed?: boolean };

function weekOf(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * How much of the team answered its scheduled async standups, week by week.
 * A team ratio to one decimal and nothing else: the server sends no names,
 * ids or counts, each day is counted once when it is over, and a day with
 * fewer than four eligible people is left out. Nothing here is coloured as
 * good or bad. The viewer's own away days sit here too, so they can be set
 * without waiting for a standup to open.
 */
export function StandupTrend({ org, slug }: { org: string; slug: string }) {
  const headingId = useId();
  const trend = useQuery({
    queryKey: ["standup-trend", org, slug],
    queryFn: () => api<{ weeks: TrendWeek[] }>("GET", standupTrendApi(org, slug)),
    retry: false,
  });
  const weeks = trend.data?.weeks ?? [];
  const shown = weeks.some((w) => !w.suppressed && w.ratio !== undefined);

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-panel border border-line bg-surface px-5 py-5"
    >
      <h2 id={headingId} className={railHeading}>
        Standup participation
      </h2>
      <p className="mt-1 text-[13px] text-ink-faint text-pretty">
        The share of the team who answered each week, to the nearest 10%.
      </p>
      {/* The full rule is a click away rather than always on screen: it is
          read once, and the column beside the sessions is narrow. */}
      <details className="group text-[13px] text-ink-faint">
        <summary
          className={`${TOUCH_HIT} inline-flex cursor-pointer list-none items-center gap-1.5 font-semibold text-ink-soft hover:text-ink [&::-webkit-details-marker]:hidden`}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          >
            <path d="M4.5 2.5 8 6l-3.5 3.5" />
          </svg>
          How it is counted
        </summary>
        <p className="mb-1 text-pretty">
          Only scheduled standups count. Spectators and people who were away are not counted,
          and each day is counted once, when it is over. There is no per-person figure.
        </p>
      </details>
      {trend.isLoading ? null : trend.isError && !trend.data ? (
        <RailError
          what="the participation trend"
          onRetry={() => void trend.refetch()}
          busy={trend.isFetching}
        />
      ) : !shown ? (
        <p className="mt-2 text-[13px] text-ink-soft text-pretty">
          Nothing to show yet. A week appears once it has a scheduled standup day on which at least
          four people could answer.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {weeks.map((w) => (
            <li key={w.weekStart} className="flex items-center gap-3 text-[13px]">
              <span className="w-24 shrink-0 text-ink-soft">Week of {weekOf(w.weekStart)}</span>
              {w.suppressed || w.ratio === undefined ? (
                <span className="text-ink-faint">Not shown — fewer than four people</span>
              ) : (
                <>
                  <span aria-hidden="true" className="h-2 flex-1 rounded-full bg-felt-deep">
                    <span
                      className="block h-2 rounded-full bg-ink-soft"
                      style={{ width: `${Math.round(w.ratio * 100)}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono tabular-nums text-ink">
                    {Math.round(w.ratio * 100)}%
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 border-t border-line pt-4">
        <AwayDays />
      </div>
    </section>
  );
}
