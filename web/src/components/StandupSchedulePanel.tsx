import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api";
import { buttonQuiet, inputClass, labelClass, labelText } from "./Modal";
import { standupScheduleApi } from "../lib/paths";
import { useToast } from "../lib/ui";

/** The schedule as the server stores it. Weekdays count from 0, Sunday. */
export type StandupSchedule = {
  weekdays: number[];
  openTime: string;
  timezone: string;
  windowMinutes: number;
  enabled: boolean;
};

// Shown Monday first, the way a working week reads, but sent as the server
// numbers them.
const DAYS = [
  { n: 1, name: "Mon" },
  { n: 2, name: "Tue" },
  { n: 3, name: "Wed" },
  { n: 4, name: "Thu" },
  { n: 5, name: "Fri" },
  { n: 6, name: "Sat" },
  { n: 0, name: "Sun" },
];

/** The browser's own zone: what a new schedule is most likely meant to be in. */
function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * When the space's scheduled async standups open, and for how long.
 *
 * Members see it and owners change it. Hiding the form is a courtesy: the
 * server answers 403 to a member's PUT whatever this renders. The zone list is
 * the browser's, but the server has the last word — Go and Postgres each carry
 * their own zone database, and a name either one lacks is refused with a 400
 * that is shown here as written.
 */
export function StandupSchedulePanel({
  org,
  slug,
  canManage,
}: {
  org: string;
  slug: string;
  canManage: boolean;
}) {
  const schedule = useQuery({
    queryKey: ["standup-schedule", org, slug],
    queryFn: () => api<{ schedule: StandupSchedule | null }>("GET", standupScheduleApi(org, slug)),
    retry: false,
  });

  const current = schedule.data?.schedule ?? null;

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className={labelText}>Standup schedule</h2>
      <p className="mt-1 text-[13px] text-ink-soft text-pretty">
        Opens an async standup on the days below and closes it when the window
        runs out. A change reaches the next standup, never one already open.
      </p>
      {schedule.isLoading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Checking the calendar…</p>
      ) : schedule.isError ? (
        <p className="mt-3 text-[13px] text-stop">{errorText(schedule.error)}</p>
      ) : canManage ? (
        <ScheduleForm org={org} slug={slug} saved={current} />
      ) : current ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-faint">Days</dt>
          <dd>{DAYS.filter((d) => current.weekdays.includes(d.n)).map((d) => d.name).join(", ")}</dd>
          <dt className="text-ink-faint">Opens</dt>
          <dd>
            {current.openTime} {current.timezone}
          </dd>
          <dt className="text-ink-faint">Window</dt>
          <dd>{current.windowMinutes} minutes</dd>
          <dt className="text-ink-faint">Status</dt>
          <dd>{current.enabled ? "On" : "Paused"}</dd>
        </dl>
      ) : (
        <p className="mt-3 text-[13px] text-ink-faint">No schedule — standups here are started by hand.</p>
      )}
    </section>
  );
}

function ScheduleForm({ org, slug, saved }: { org: string; slug: string; saved: StandupSchedule | null }) {
  const qc = useQueryClient();
  const say = useToast();
  const id = useId();
  const [days, setDays] = useState<number[]>(saved?.weekdays ?? [1, 2, 3, 4, 5]);
  const [openTime, setOpenTime] = useState(saved?.openTime ?? "09:00");
  const [timezone, setTimezone] = useState(saved?.timezone ?? browserZone());
  const [windowMinutes, setWindowMinutes] = useState(String(saved?.windowMinutes ?? 240));
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Suggestions, not a fence: a zone this browser does not list can still be
  // typed, and the server decides whether it knows it.
  const zones = Intl.supportedValuesOf("timeZone");

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const next: StandupSchedule = {
      weekdays: [...days].sort((a, b) => a - b),
      openTime,
      timezone,
      // The server owns the range; a blank or out-of-range number is sent as
      // is so its own message explains the limit.
      windowMinutes: Number(windowMinutes),
      enabled,
    };
    try {
      await api("PUT", standupScheduleApi(org, slug), next);
      qc.setQueryData(["standup-schedule", org, slug], { schedule: next });
      say("Schedule saved — it applies from the next standup");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-1">
      <fieldset className="border-0 p-0">
        <legend className={labelClass}>Days</legend>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((d) => (
            <label
              key={d.n}
              className="flex items-center gap-1.5 rounded-chip border border-line px-2.5 py-1.5 text-[13px] font-semibold"
            >
              <input
                type="checkbox"
                checked={days.includes(d.n)}
                onChange={(e) => setDays(e.target.checked ? [...days, d.n] : days.filter((x) => x !== d.n))}
              />
              {d.name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <div className="min-w-[120px] flex-1">
          <label className={labelClass} htmlFor={`${id}-time`}>
            Opens at
          </label>
          <input
            id={`${id}-time`}
            type="time"
            className={inputClass}
            value={openTime}
            onChange={(e) => setOpenTime(e.target.value)}
          />
        </div>
        <div className="min-w-[200px] flex-[2]">
          <label className={labelClass} htmlFor={`${id}-zone`}>
            Time zone
          </label>
          <input
            id={`${id}-zone`}
            className={inputClass}
            list={`${id}-zones`}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id={`${id}-zones`}>
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <div className="min-w-[120px] flex-1">
          <label className={labelClass} htmlFor={`${id}-window`}>
            Window (minutes)
          </label>
          <input
            id={`${id}-window`}
            type="number"
            inputMode="numeric"
            className={inputClass}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(e.target.value)}
          />
        </div>
      </div>

      <label className="mt-4 flex items-center gap-3 text-sm font-semibold">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Open standups on this schedule
      </label>

      {error && (
        <p role="alert" className="mt-3 text-sm font-bold text-stop text-pretty">
          {error}
        </p>
      )}

      <button type="submit" className={buttonQuiet + " mt-3"} disabled={busy}>
        Save schedule
      </button>
    </form>
  );
}
