import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api";
import { awayApi } from "../lib/paths";
import { useToast } from "../lib/ui";
import { buttonQuiet, inputClass, labelText } from "./Modal";

export type AwayRange = { id: string; startsOn: string; endsOn: string };

/** A YYYY-MM-DD date as the viewer reads one. The date is a calendar day, not an instant. */
function day(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The viewer's own away days. While away, a person is not listed under "Not
 * yet" in today's async digest, and is not counted in a trend day frozen
 * while the range covered it — a range set after a day is over does not count
 * for that day. Only the viewer's own ranges are ever read or written here:
 * the server has no way to name anyone else. Rendered in an open async room
 * and beside the trend on the space page.
 */
export function AwayDays() {
  const qc = useQueryClient();
  const say = useToast();
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const firstId = useId();
  const lastId = useId();

  const ranges = useQuery({
    queryKey: ["away"],
    queryFn: () => api<{ ranges: AwayRange[] }>("GET", awayApi()),
    retry: false,
  });

  async function change(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["away"] });
      return true;
    } catch (e) {
      say(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!startsOn || !endsOn) return;
    if (await change(() => api("POST", awayApi(), { startsOn, endsOn }))) {
      setStartsOn("");
      setEndsOn("");
    }
  }

  const list = ranges.data?.ranges ?? [];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className={labelText}>Away days</h3>
      <p className="text-sm text-ink-faint">
        Days you are off. You are not listed as owing an answer on them. Set them ahead: a day
        that is already over has been counted as it was.
      </p>
      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <label htmlFor={firstId} className="flex flex-col gap-1 text-sm">
          First day away
          <input
            id={firstId}
            type="date"
            className={inputClass}
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
            required
          />
        </label>
        <label htmlFor={lastId} className="flex flex-col gap-1 text-sm">
          Last day away
          <input
            id={lastId}
            type="date"
            className={inputClass}
            value={endsOn}
            min={startsOn || undefined}
            onChange={(e) => setEndsOn(e.target.value)}
            required
          />
        </label>
        <button type="submit" className={buttonQuiet} disabled={busy || !startsOn || !endsOn}>
          Add away days
        </button>
      </form>
      {list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink">
                {r.startsOn === r.endsOn ? day(r.startsOn) : `${day(r.startsOn)} – ${day(r.endsOn)}`}
              </span>
              <button
                type="button"
                className={buttonQuiet}
                disabled={busy}
                aria-label={`Remove away days ${r.startsOn} to ${r.endsOn}`}
                onClick={() => void change(() => api("DELETE", awayApi(r.id)))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
