import { useEffect, useRef, useState } from "react";
import { action, api, type Envelope, type Me } from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { useToast } from "../lib/ui";
import { Avatar } from "../components/Avatar";
import { buttonPrimary, buttonQuiet, inputClass } from "../components/Modal";

export type StandupEntry = {
  userId: string;
  yesterday: string;
  today: string;
  blockers: string;
  position: number;
  skipped: boolean;
  /** Advisory "I've finished writing" signal, shown only while gathering. */
  ready: boolean;
};
type StandupState = {
  entries: StandupEntry[];
  currentSpeakerId: string | null;
  speakerStartedAt: string | null;
  secondsPerPerson: number;
};

// The viewer's own entry is local draft state: it is seeded once from the
// server and never rehydrated from broadcasts, so incoming frames can't eat
// in-flight keystrokes. Saves are debounced; the echo of our own PUT arrives
// as a frame and is ignored by construction.
function useOwnEntryDraft(env: Envelope, meId: string) {
  const st = env.state as unknown as StandupState;
  const server = st.entries.find((e) => e.userId === meId);
  const [draft, setDraft] = useState({ yesterday: "", today: "", blockers: "" });
  const seeded = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // What has been typed but not yet sent. Kept in a ref rather than state so
  // flush() can post the very last keystroke without waiting for a re-render.
  const pending = useRef<{ yesterday: string; today: string; blockers: string } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!seeded.current && server) {
      seeded.current = true;
      setDraft({ yesterday: server.yesterday, today: server.today, blockers: server.blockers });
    }
  }, [server]);

  async function send(next: { yesterday: string; today: string; blockers: string }) {
    pending.current = null;
    try {
      await action(env.id, "standup", next);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function update(field: keyof typeof draft, value: string) {
    const next = { ...draft, [field]: value };
    setDraft(next);
    seeded.current = true;
    setSaveState("saving");
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void send(next), 800);
  }

  // Send anything still sitting in the debounce, right now. Anything that ends
  // the session has to await this first: the backend refuses writes to an ended
  // session, so a late debounce would drop the last thing that was typed.
  async function flush() {
    clearTimeout(timer.current);
    const next = pending.current;
    if (next) await send(next);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  return { draft, update, saveState, flush };
}

export function Timer({ startedAt, seconds, serverTime }: { startedAt: string; seconds: number; serverTime: string }) {
  // Server clock offset estimated from the latest frame; the countdown is
  // display-only and identical on every screen. Captured once per frame
  // (not per render) so Date.now() actually advances against a fixed
  // offset instead of cancelling out on every tick.
  const offset = useRef(Date.parse(serverTime) - Date.now());
  useEffect(() => {
    offset.current = Date.parse(serverTime) - Date.now();
  }, [serverTime]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.ceil(seconds - (Date.now() + offset.current - Date.parse(startedAt)) / 1000);
  const shown = Math.max(0, remaining);
  const tone = remaining <= 0 ? "text-stop" : remaining <= seconds * 0.25 ? "text-brass" : "text-ink-soft";
  return (
    // The digits change twice a second, so they stay out of the accessibility
    // tree entirely; the static label carries the only fact worth speaking.
    <span>
      <span className="sr-only">{`Each turn is ${seconds} seconds. A countdown is shown on screen.`}</span>
      <span aria-hidden="true" className={`font-mono text-3xl font-medium tabular-nums ${tone}`}>
        {Math.floor(shown / 60)}:{String(shown % 60).padStart(2, "0")}
      </span>
    </span>
  );
}

export function StandupRoom({
  env,
  me,
  status = "live",
}: {
  env: Envelope;
  me: Me;
  status?: ConnectionStatus;
}) {
  const st = env.state as unknown as StandupState;
  const say = useToast();
  const isFacilitator = env.facilitatorId === me.id;
  const { draft, update, saveState, flush } = useOwnEntryDraft(env, me.id);
  const [error, setError] = useState("");
  // Which entry is on show. Read-only, and deliberately separate from the
  // viewer's own draft above: reusing that would autosave someone else's words
  // onto your row. Null means "follow the turn"; a pick holds against it, so a
  // turn change never yanks a reader out of the update they opened. Clicking
  // the held seat again lets go and puts the panel back on the live speaker.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const people = new Map(env.participants.map((p) => [p.userId, p]));
  const speaking = env.phase === "speaking";
  const done = env.phase === "done";
  const current = st.currentSpeakerId ? st.entries.find((e) => e.userId === st.currentSpeakerId) : undefined;
  const shownId = pickedId ?? st.currentSpeakerId;
  const shown = shownId ? st.entries.find((e) => e.userId === shownId) : undefined;
  // Readiness is counted over the people who actually speak: a spectator has no
  // entry row and no turn, so counting them would make "3 of 4" unreachable.
  const speakers = env.participants.filter((p) => !p.spectator);
  const readyIds = new Set(st.entries.filter((e) => e.ready).map((e) => e.userId));
  const readyCount = speakers.filter((p) => readyIds.has(p.userId)).length;
  const iAmReady = readyIds.has(me.id);

  // One polite line for the whole room. It never carries the countdown, so it
  // speaks on a turn change rather than on every 500ms tick, and it stays empty
  // while the connection is off — ConnectionBanner and the toasts are already
  // polite regions, and a third would queue serially behind them.
  const announcement =
    status !== "live"
      ? ""
      : done
        ? "The standup has wrapped up."
        : speaking && current
          ? `${people.get(current.userId)?.name ?? "Someone"} is speaking now.`
          : "";

  async function run(fn: () => Promise<unknown>) {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  const blockersText = st.entries
    .filter((e) => e.blockers.trim() && !e.skipped)
    .map((e) => `${people.get(e.userId)?.name ?? "Someone"}: ${e.blockers.trim()}`)
    .join("\n");

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-5 sm:p-7">
      <header className="flex flex-wrap items-center gap-3 rounded-panel border border-line bg-surface px-5 py-4 shadow-rest">
        <h1 className="min-w-0 flex-1 truncate text-lg font-extrabold tracking-tight">{env.title}</h1>
        <a
          href={`/api/sessions/${env.id}/export.csv`}
          download
          className="text-sm font-bold text-ink-soft hover:text-accent"
        >
          Export CSV
        </a>
        {speaking && st.speakerStartedAt && (
          <Timer startedAt={st.speakerStartedAt} seconds={st.secondsPerPerson} serverTime={env.serverTime} />
        )}
        {isFacilitator && !env.endedAt && (
          <button
            className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-stop"
            onClick={() =>
              run(async () => {
                // Ending closes the session to writes, so the pending debounce
                // goes out first or the facilitator's last sentence is lost.
                await flush();
                await api("DELETE", `/api/sessions/${env.id}`);
                say("Session closed — members can still open the results");
              })
            }
          >
            End session
          </button>
        )}
      </header>

      {/* Speaking order rail. */}
      {(speaking || done) && (
        <ol className="flex flex-wrap items-center gap-2">
          {st.entries.map((e) => {
            const p = people.get(e.userId);
            const isCurrent = e.userId === st.currentSpeakerId;
            const isShown = e.userId === shownId;
            return (
              <li
                key={e.userId}
                aria-current={isCurrent ? "true" : undefined}
                className={
                  "flex items-center gap-1.5 rounded-full transition " +
                  (isCurrent ? "bg-accent-soft shadow-lift" : e.skipped ? "" : "bg-surface shadow-rest")
                }
              >
                {/* The button carries only the name, so the sr-only asides
                    below stay out of its accessible name. */}
                <button
                  type="button"
                  aria-pressed={isShown}
                  onClick={() => setPickedId((id) => (id === e.userId ? null : e.userId))}
                  className={
                    "flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 transition " +
                    (isShown ? "ring-2 ring-accent" : "")
                  }
                >
                  {/* The name sits in text beside it, so the chip is
                      decorative here — otherwise it doubles the button's name. */}
                  {p && (
                    <span aria-hidden="true">
                      <Avatar name={p.name} hue={p.avatarHue} size="sm" dim={e.skipped} />
                    </span>
                  )}
                  {/* A group opacity wrapper would multiply through the name and
                      leave it at 2.38:1 on the felt. The dimming rides on the
                      avatar and a faint-but-legible ink instead. */}
                  <span
                    className={
                      "text-sm font-bold" +
                      (e.skipped ? " text-ink-faint line-through" : "") +
                      // Both cues can land on one seat. At small sizes an
                      // offset-4 underline crowds the strike into a single
                      // thick bar, so a struck seat gets the deeper offset and
                      // the two lines stay readable as two different facts.
                      (isShown ? (e.skipped ? " underline underline-offset-8" : " underline underline-offset-4") : "")
                    }
                  >
                    {p?.name}
                  </span>
                </button>
                {(isCurrent || e.skipped) && (
                  <span className="sr-only">{isCurrent ? " — speaking now" : " — skipped or absent"}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {!speaking && !done && (
        <section className="flex flex-col gap-4">
          <p className="text-ink-soft">
            Jot down your update while everyone gathers. Your notes save automatically.
          </p>
          <EntryForm draft={draft} update={update} saveState={saveState} />
          <button
            className={(iAmReady ? buttonPrimary : buttonQuiet) + " self-start"}
            aria-pressed={iAmReady}
            onClick={() => run(() => action(env.id, "ready", { ready: !iAmReady }))}
          >
            {iAmReady ? "Ready — stand back down" : "I'm ready"}
          </button>
          {/* Who has signalled, in words. A dot or a tint alone would leave the
              only copy of this fact in colour. */}
          <ul data-testid="ready-roster" className="flex flex-col gap-1 text-sm">
            {speakers.map((p) => (
              <li key={p.userId} className="flex items-center gap-2">
                <Avatar name={p.name} hue={p.avatarHue} size="sm" />
                <span className="font-bold">{p.name}</span>
                <span className={readyIds.has(p.userId) ? "text-accent" : "text-ink-faint"}>
                  {readyIds.has(p.userId) ? "ready" : "still writing"}
                </span>
              </li>
            ))}
          </ul>
          {isFacilitator && (
            <button className={buttonPrimary + " self-start"} onClick={() => run(() => action(env.id, "start"))}>
              {`Start the round · ${readyCount} of ${speakers.length} ready`}
            </button>
          )}
        </section>
      )}

      {(speaking || done) && shown && (
        <section className="flex flex-col gap-4 rounded-panel bg-surface p-6 shadow-rest">
          <div className="flex items-center gap-3">
            {people.get(shown.userId) && (
              <Avatar name={people.get(shown.userId)!.name} hue={people.get(shown.userId)!.avatarHue} size="lg" />
            )}
            <h2 className="font-display text-2xl font-semibold">{people.get(shown.userId)?.name}</h2>
          </div>
          {speaking && shown.userId === me.id ? (
            <EntryForm draft={draft} update={update} saveState={saveState} />
          ) : (
            <dl className="flex flex-col gap-3">
              {(["yesterday", "today", "blockers"] as const).map((f) => (
                <div key={f}>
                  <dt className="text-xs font-bold uppercase tracking-wide text-ink-faint">{f}</dt>
                  <dd className="whitespace-pre-wrap">{shown[f] || <span className="text-ink-faint">—</span>}</dd>
                </div>
              ))}
            </dl>
          )}
          {speaking && current && isFacilitator && (
            <div className="flex gap-2">
              <button className={buttonPrimary} onClick={() => run(() => action(env.id, "next"))}>
                Next
              </button>
              <button className={buttonQuiet} onClick={() => run(() => action(env.id, "skip"))}>
                Skip / absent
              </button>
            </div>
          )}
        </section>
      )}

      {done && (
        <section className="flex flex-col gap-3 rounded-panel bg-surface p-6 shadow-rest">
          <h2 className="font-display text-2xl font-semibold">Blockers roundup</h2>
          {blockersText ? (
            <>
              <pre className="whitespace-pre-wrap rounded-chip bg-felt-deep p-4 font-mono text-sm shadow-well">{blockersText}</pre>
              <button
                className={buttonPrimary + " self-start"}
                onClick={async () => {
                  await navigator.clipboard.writeText(blockersText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied!" : "Copy blockers"}
              </button>
            </>
          ) : (
            <p className="text-ink-soft">No blockers today. Good round.</p>
          )}
        </section>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error && <p role="alert" className="font-bold text-stop">{error}</p>}
    </div>
  );
}

function EntryForm({
  draft,
  update,
  saveState,
}: {
  draft: { yesterday: string; today: string; blockers: string };
  update: (f: "yesterday" | "today" | "blockers", v: string) => void;
  saveState: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {(["yesterday", "today", "blockers"] as const).map((f) => (
        <label key={f} className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wide text-ink-soft">{f}</span>
          <textarea
            className={inputClass + " min-h-16 resize-y"}
            value={draft[f]}
            maxLength={2000}
            onChange={(e) => update(f, e.target.value)}
            placeholder={f === "blockers" ? "Anything in your way?" : ""}
          />
        </label>
      ))}
      <span className="text-xs text-ink-faint">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved"}
        {saveState === "error" && <span className="font-bold text-stop">Could not save — check your connection</span>}
      </span>
    </div>
  );
}
