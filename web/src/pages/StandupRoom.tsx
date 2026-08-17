import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Envelope, type Me } from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Avatar } from "../components/Avatar";
import { buttonPrimary, buttonQuiet, inputClass } from "../components/Modal";

type StandupEntry = {
  userId: string;
  yesterday: string;
  today: string;
  blockers: string;
  position: number;
  skipped: boolean;
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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!seeded.current && server) {
      seeded.current = true;
      setDraft({ yesterday: server.yesterday, today: server.today, blockers: server.blockers });
    }
  }, [server]);

  function update(field: keyof typeof draft, value: string) {
    const next = { ...draft, [field]: value };
    setDraft(next);
    seeded.current = true;
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        await api("PUT", `/api/sessions/${env.id}/standup`, next);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 800);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  return { draft, update, saveState };
}

function Timer({ startedAt, seconds, serverTime }: { startedAt: string; seconds: number; serverTime: string }) {
  // Server clock offset estimated from the latest frame; the countdown is
  // display-only and identical on every screen.
  const offset = Date.parse(serverTime) - Date.now();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.ceil(seconds - (Date.now() + offset - Date.parse(startedAt)) / 1000);
  const shown = Math.max(0, remaining);
  const tone = remaining <= 0 ? "text-stop" : remaining <= seconds * 0.25 ? "text-brass" : "text-ink-soft";
  return (
    <span className={`font-mono text-3xl font-medium tabular-nums ${tone}`}>
      {Math.floor(shown / 60)}:{String(shown % 60).padStart(2, "0")}
    </span>
  );
}

export function StandupRoom({ env, me, status }: { env: Envelope; me: Me; status: ConnectionStatus }) {
  const st = env.state as unknown as StandupState;
  const isFacilitator = env.facilitatorId === me.id;
  const { draft, update, saveState } = useOwnEntryDraft(env, me.id);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const people = new Map(env.participants.map((p) => [p.userId, p]));
  const speaking = env.phase === "speaking";
  const done = env.phase === "done";
  const current = st.currentSpeakerId ? st.entries.find((e) => e.userId === st.currentSpeakerId) : undefined;

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
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <ConnectionBanner status={status} />
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/s/${env.spaceSlug}`} className="text-sm font-bold text-accent hover:underline">
            ← {env.spaceSlug}
          </Link>
          <h1 className="font-display truncate text-3xl font-semibold">{env.title}</h1>
        </div>
        {speaking && st.speakerStartedAt && (
          <Timer startedAt={st.speakerStartedAt} seconds={st.secondsPerPerson} serverTime={env.serverTime} />
        )}
      </header>

      {/* Speaking order rail. */}
      {(speaking || done) && (
        <ol className="flex flex-wrap items-center gap-2">
          {st.entries.map((e) => {
            const p = people.get(e.userId);
            const isCurrent = e.userId === st.currentSpeakerId;
            return (
              <li
                key={e.userId}
                className={
                  "flex items-center gap-1.5 rounded-pill py-1 pl-1 pr-3 transition " +
                  (isCurrent ? "bg-accent-soft shadow-lift" : e.skipped ? "opacity-40" : "bg-surface shadow-rest")
                }
              >
                {p && <Avatar name={p.name} hue={p.avatarHue} size="sm" />}
                <span className={"text-sm font-bold" + (e.skipped ? " line-through" : "")}>{p?.name}</span>
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
          {isFacilitator && (
            <button className={buttonPrimary + " self-start"} onClick={() => run(() => api("POST", `/api/sessions/${env.id}/start`))}>
              Start the round
            </button>
          )}
        </section>
      )}

      {speaking && current && (
        <section className="flex flex-col gap-4 rounded-panel bg-surface p-6 shadow-rest">
          <div className="flex items-center gap-3">
            {people.get(current.userId) && (
              <Avatar name={people.get(current.userId)!.name} hue={people.get(current.userId)!.avatarHue} size="lg" />
            )}
            <h2 className="font-display text-2xl font-semibold">{people.get(current.userId)?.name}</h2>
          </div>
          {current.userId === me.id ? (
            <EntryForm draft={draft} update={update} saveState={saveState} />
          ) : (
            <dl className="flex flex-col gap-3">
              {(["yesterday", "today", "blockers"] as const).map((f) => (
                <div key={f}>
                  <dt className="text-xs font-bold uppercase tracking-wide text-ink-faint">{f}</dt>
                  <dd className="whitespace-pre-wrap">{current[f] || <span className="text-ink-faint">—</span>}</dd>
                </div>
              ))}
            </dl>
          )}
          {isFacilitator && (
            <div className="flex gap-2">
              <button className={buttonPrimary} onClick={() => run(() => api("POST", `/api/sessions/${env.id}/next`))}>
                Next
              </button>
              <button className={buttonQuiet} onClick={() => run(() => api("POST", `/api/sessions/${env.id}/skip`))}>
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
