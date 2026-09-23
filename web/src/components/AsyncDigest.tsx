import type { Person } from "../lib/api";
import { safeDisplayName } from "../lib/displayName";
import type { StandupEntry } from "../pages/StandupRoom";

/** One commitment this standup moved, exactly as the session state sends it. */
export type CommitmentChange = {
  id: string;
  userId: string;
  text: string;
  outcome: "landed" | "dropped" | "carried";
};

/** Words, never a tint: a dropped commitment is a decision, not a failure. */
const OUTCOME: Record<CommitmentChange["outcome"], string> = {
  landed: "Landed",
  dropped: "Dropped",
  carried: "Still on it",
};

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
 * The async standup's read view: who needs you, blockers, the commitments this
 * standup moved, then everyone's update collapsed to its first line, then who
 * has answered and who has not yet.
 *
 * "Needs you" is the viewer's own: the ids of the people who asked the viewer
 * for help, read from a per-caller endpoint and never from the shared state,
 * which every socket in the room receives. Once the standup
 * has ended only the entries are kept — the not-yet list, the away list and
 * the changed commitments are live facts about an open room, never a record.
 * Someone away today is listed as away rather than as not yet. No counts beside names and no alarm styling on
 * the people who have not answered.
 */
export function AsyncDigest({
  entries,
  participants,
  ended,
  changes = [],
  needsYou = [],
  away = [],
}: {
  entries: StandupEntry[];
  participants: Person[];
  ended: boolean;
  changes?: CommitmentChange[];
  needsYou?: string[];
  /** Ids of the members who set themselves away today, from the session state. */
  away?: string[];
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
  const awayIds = new Set(away);
  const owing = participants.filter((p) => !p.spectator && !answeredIds.has(p.userId));
  const waiting = owing.filter((p) => !awayIds.has(p.userId));
  const awayNow = owing.filter((p) => awayIds.has(p.userId));
  const panel = "flex flex-col gap-3 rounded-panel border border-line bg-surface px-5 py-5 shadow-rest";
  const head = "text-[17px] font-bold tracking-tight text-ink";

  const blockerOf = (id: string) => entries.find((e) => e.userId === id)?.blockers.trim() ?? "";

  return (
    <>
      {needsYou.length > 0 && (
        <section aria-labelledby="digest-needs-you" className={panel}>
          <h2 id="digest-needs-you" className={head}>Needs you</h2>
          <ul className="flex flex-col gap-2.5 rounded-chip bg-felt-deep p-4">
            {needsYou.map((id) => (
              <li key={id} className="text-sm">
                <span className="font-bold text-ink">{nameOf(id)}</span>
                <span className="whitespace-pre-wrap text-ink-soft">
                  {" — "}
                  {blockerOf(id) || "asked for your help"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {/* Like the not-yet list, what a standup changed is shown only while it
          is open: an ended standup's record is its entries, so no per-person
          landed and dropped history is rebuilt from old rooms. The server
          sends none for an ended session either. */}
      {!ended && changes.length > 0 && (
        <section aria-labelledby="digest-changes" className={panel}>
          <h2 id="digest-changes" className={head}>Changed commitments</h2>
          <ul className="flex flex-col gap-2">
            {changes.map((c) => (
              <li key={c.id} className="text-sm">
                <span className="font-bold text-ink">{nameOf(c.userId)}</span>
                <span className="text-ink-soft"> — {c.text}: </span>
                <span className="font-semibold text-ink">{OUTCOME[c.outcome]}</span>
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
        <div className={`grid gap-4 ${awayNow.length > 0 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <section aria-labelledby="digest-answered" className={panel}>
            <h2 id="digest-answered" className={head}>Answered</h2>
            <NameList names={posted.map((e) => nameOf(e.userId))} empty="Nobody yet." />
          </section>
          <section aria-labelledby="digest-waiting" className={panel}>
            <h2 id="digest-waiting" className={head}>Not yet</h2>
            <NameList names={waiting.map((p) => nameOf(p.userId))} empty="Everyone has answered." />
          </section>
          {awayNow.length > 0 && (
            <section aria-labelledby="digest-away" className={panel}>
              <h2 id="digest-away" className={head}>Away</h2>
              <NameList names={awayNow.map((p) => nameOf(p.userId))} empty="" />
            </section>
          )}
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
