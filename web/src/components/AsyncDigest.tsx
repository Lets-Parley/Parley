import type { Person } from "../lib/api";
import { safeDisplayName } from "../lib/displayName";
import type { StandupEntry } from "../pages/StandupRoom";

const answered = (e: StandupEntry) => Boolean(e.yesterday.trim() || e.today.trim() || e.blockers.trim());

/** First non-blank line of the update, today first: the collapsed digest row. */
function firstLine(e: StandupEntry) {
  for (const f of [e.today, e.yesterday, e.blockers]) {
    const line = f.split("\n").find((l) => l.trim());
    if (line) return line.trim();
  }
  return "";
}

function Posted({ at }: { at: string }) {
  // The viewer's own zone: an async room spans several.
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <time dateTime={at} className="font-mono text-[11px] text-ink-faint">
      posted {time}
    </time>
  );
}

/**
 * The async standup's read view: blockers, then everyone's update collapsed to
 * its first line, then who has answered and who has not yet. Once the standup
 * has ended only the entries are kept — the not-yet list is a live fact about
 * an open room, never a record. No counts beside names and no alarm styling on
 * the people who have not answered.
 */
export function AsyncDigest({
  entries,
  participants,
  ended,
}: {
  entries: StandupEntry[];
  participants: Person[];
  ended: boolean;
}) {
  const people = new Map(participants.map((p) => [p.userId, p]));
  const nameOf = (id: string) => {
    const p = people.get(id);
    if (!p) return "Someone";
    return p.guest ? `${safeDisplayName(p.name)} (guest)` : safeDisplayName(p.name);
  };
  // A spectator has no turn. An entry they submitted anyway stays out of the
  // digest the room reads as who answered.
  const spectators = new Set(participants.filter((p) => p.spectator).map((p) => p.userId));
  const posted = entries.filter((e) => answered(e) && !spectators.has(e.userId));
  const blockers = posted.filter((e) => e.blockers.trim());
  const answeredIds = new Set(posted.map((e) => e.userId));
  const waiting = participants.filter((p) => !p.spectator && !answeredIds.has(p.userId));
  const panel = "flex flex-col gap-3 rounded-panel border border-line bg-surface px-5 py-5 shadow-rest";
  const head = "text-[17px] font-bold tracking-tight text-ink";

  return (
    <>
      {blockers.length > 0 && (
        <section aria-labelledby="digest-blockers" className={panel}>
          <h2 id="digest-blockers" className={head}>Blockers</h2>
          <ul className="flex flex-col gap-2.5 rounded-chip bg-felt-deep p-4">
            {blockers.map((e) => (
              <li key={e.userId} className="text-sm">
                <span className="font-bold text-ink">{nameOf(e.userId)}</span>
                <span className="whitespace-pre-wrap text-ink-soft"> — {e.blockers.trim()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="digest-updates" className={panel}>
        <h2 id="digest-updates" className={head}>Updates</h2>
        {posted.length === 0 ? (
          <p className="text-ink-soft">No updates yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {posted.map((e) => (
              <li key={e.userId}>
                <details className="rounded-chip border border-line px-3 py-2">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-bold text-ink">{nameOf(e.userId)}</span>{" "}
                    <span className="text-ink-soft">{firstLine(e)}</span>{" "}
                    <Posted at={e.postedAt} />
                  </summary>
                  <dl className="mt-2 flex flex-col gap-2">
                    {(["yesterday", "today", "blockers"] as const).map((f) => (
                      <div key={f}>
                        <dt className="text-xs font-bold uppercase tracking-wide text-ink-faint">{f}</dt>
                        <dd className="whitespace-pre-wrap text-sm">
                          {e[f] || <span className="text-ink-faint">Nothing written</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!ended && (
        <div className="grid gap-4 sm:grid-cols-2">
          <section aria-labelledby="digest-answered" className={panel}>
            <h2 id="digest-answered" className={head}>Answered</h2>
            <NameList names={posted.map((e) => nameOf(e.userId))} empty="Nobody yet." />
          </section>
          <section aria-labelledby="digest-waiting" className={panel}>
            <h2 id="digest-waiting" className={head}>Not yet</h2>
            <NameList names={waiting.map((p) => nameOf(p.userId))} empty="Everyone has answered." />
          </section>
        </div>
      )}
    </>
  );
}

function NameList({ names, empty }: { names: string[]; empty: string }) {
  if (names.length === 0) return <p className="text-sm text-ink-soft">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {names.map((n, i) => (
        <li key={i} className="font-bold text-ink">{n}</li>
      ))}
    </ul>
  );
}
