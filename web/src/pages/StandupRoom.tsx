import { useEffect, useRef, useState } from "react";
import { action, api, errorText, type Envelope, type Me } from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { useToast } from "../lib/ui";
import { Avatar } from "../components/Avatar";
import { ErrorRow, Modal, buttonDanger, buttonPrimary, buttonQuiet, inputClass } from "../components/Modal";
import type { Fail } from "../components/Modal";
import { cueFor, cueVar } from "../lib/cue";
import { EmptyTable } from "./PokerRoom";

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
/** Which cluster of controls a failure came from, so it reports there. */
type Where = "chrome" | "gathering" | "round";

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
  // Every save is queued behind the previous one. Two overlapping PUTs have no
  // ordering guarantee on the wire, so a slow older body could land last and
  // undo the newer one; chaining also gives flush() something to await when a
  // request is already out and pending.current is therefore empty.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!seeded.current && server) {
      seeded.current = true;
      setDraft({ yesterday: server.yesterday, today: server.today, blockers: server.blockers });
    }
  }, [server]);

  // Rejects when the save failed. Callers that only fire-and-forget swallow it;
  // flush() deliberately does not, so ending the session can refuse to proceed.
  function send(next: { yesterday: string; today: string; blockers: string }) {
    pending.current = null;
    const done = chain.current.catch(() => {}).then(async () => {
      try {
        await action(env.id, "standup", next);
        setSaveState("saved");
      } catch (e) {
        setSaveState("error");
        throw e;
      }
    });
    chain.current = done;
    return done;
  }

  function update(field: keyof typeof draft, value: string) {
    const next = { ...draft, [field]: value };
    setDraft(next);
    seeded.current = true;
    setSaveState("saving");
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void send(next).catch(() => {}), 800);
  }

  // Send anything still sitting in the debounce, right now. Anything that ends
  // the session has to await this first: the backend refuses writes to an ended
  // session, so a late debounce would drop the last thing that was typed.
  async function flush() {
    clearTimeout(timer.current);
    const next = pending.current;
    // Nothing pending still leaves a request possibly in flight: send() clears
    // pending.current before it awaits, so the chain is the only handle on it.
    if (next) await send(next);
    else await chain.current;
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
  // Brass marks the facilitator and nothing else (DESIGN.md, the One Brass
  // Rule), so a turn running short escalates by weight and ink instead of
  // borrowing authority's hue — which also reads further across a room than a
  // hue shift does.
  const tone =
    remaining <= 0
      ? "font-bold text-stop"
      : remaining <= seconds * 0.25
        ? "font-bold text-ink"
        : "font-medium text-ink-soft";
  return (
    // The digits change twice a second, so they stay out of the accessibility
    // tree entirely; the static label carries the only fact worth speaking.
    <span>
      <span className="sr-only">{`Each turn is ${seconds} seconds. A countdown is shown on screen.`}</span>
      {/* The one number six people read from across a projected room. It shipped
          at text-3xl in the corner of the chrome; it is the round's hero now,
          stepped down only where a phone has no width for it. */}
      <span
        aria-hidden="true"
        className={`font-mono text-[2.75rem] leading-none tabular-nums sm:text-[length:var(--text-num-result)] ${tone}`}
      >
        {Math.floor(shown / 60)}:{String(shown % 60).padStart(2, "0")}
      </span>
    </span>
  );
}

export function StandupRoom({
  env,
  me,
  status = "live",
  guest = false,
}: {
  env: Envelope;
  me: Me;
  status?: ConnectionStatus;
  guest?: boolean;
}) {
  const st = env.state as unknown as StandupState;
  const say = useToast();
  const isFacilitator = !guest && env.facilitatorId === me.id;
  const { draft, update, saveState, flush } = useOwnEntryDraft(env, me.id);
  // Where it failed, not just that it did. One string at the foot of the page
  // took failures from ready, start, next, skip and end alike — the same shape
  // the poker room shed in #223.
  const [fail, setFail] = useState<(Fail & { where: Where }) | null>(null);
  // Which entry is on show. Read-only, and deliberately separate from the
  // viewer's own draft above: reusing that would autosave someone else's words
  // onto your row. Null means "follow the turn"; a pick holds against it, so a
  // turn change never yanks a reader out of the update they opened. Clicking
  // the held seat again lets go and puts the panel back on the live speaker.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const people = new Map(env.participants.map((p) => [p.userId, p]));
  // The visual seat marks a guest with " · guest"; the text summaries below
  // (the live announcement, skipped names, blocker lines) are built from
  // plain strings, so they need the same tell spelled out in words or a
  // screen-reader user hears no distinction from a member of the same name.
  const nameOf = (userId: string) => {
    const p = people.get(userId);
    if (!p) return "Someone";
    return p.guest ? `${p.name} (guest)` : p.name;
  };
  const speaking = env.phase === "speaking";
  const done = env.phase === "done";
  const current = st.currentSpeakerId ? st.entries.find((e) => e.userId === st.currentSpeakerId) : undefined;
  const shownId = pickedId ?? st.currentSpeakerId;
  const shown = shownId ? st.entries.find((e) => e.userId === shownId) : undefined;
  // Readiness is counted over the people who actually speak: a spectator has no
  // entry row and no turn, so counting them would make "3 of 4" unreachable.
  // The same is true of a live link guest seated as a non-spectator
  // participant (#304) — the server only ever writes a standup_entries row
  // for a member, so a guest has none either. Deriving speakers from
  // st.entries rather than env.participants keeps both out of the
  // denominator without knowing anything about guests specifically: once a
  // future change gives guests an entry row, they start counting for free.
  const entryIds = new Set(st.entries.map((e) => e.userId));
  const speakers = env.participants.filter((p) => !p.spectator && entryIds.has(p.userId));
  const readyIds = new Set(st.entries.filter((e) => e.ready).map((e) => e.userId));
  const readyCount = speakers.filter((p) => readyIds.has(p.userId)).length;
  const iAmReady = readyIds.has(me.id);
  const waitingOn = speakers.filter((p) => !readyIds.has(p.userId));

  // Where the round is, and who follows. Both were on screen only as a row of
  // wrapped chips you had to count, which is the wrong ask of a room that is
  // half-listening and fully time-boxed.
  const orderIndex = st.entries.findIndex((e) => e.userId === st.currentSpeakerId);
  const position = orderIndex < 0 ? st.entries.length : orderIndex + 1;
  // A skipped seat gets no turn, so it is not the answer to "who is next".
  const nextUp = st.entries.slice(orderIndex + 1).find((e) => !e.skipped);
  // Daybreak, keyed to turns taken rather than votes cast: the same field the
  // poker table lights, carrying the same fact — how far round the round is.
  // `done` plays the part `revealed` plays there, so the last turn still has a
  // step left to make.
  const cue = cueFor(Math.max(0, position - 1), speakers.length, done);
  // Your own row stays writable for as long as the session accepts writes. It
  // used to render only during your own turn, so a blocker remembered while
  // someone else spoke had nowhere to go — and the roundup is built from that
  // field. The server closes writes at end, which is what `done` tracks here.
  const canEditOwn = !done && !env.endedAt;
  const nextLabel = done
    ? "Round complete"
    : nextUp
      ? `Next: ${people.get(nextUp.userId)?.name ?? "Someone"}`
      : "Last turn";

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
          ? `${nameOf(current.userId)} is speaking now, ${position} of ${speakers.length}.`
          : "";

  // Ending is a two-step await, so a second click can land between the flush
  // and the DELETE. The server ignores the duplicate, but nothing should fire a
  // request it already has in flight. The ref is the guard and the state only
  // dims the button: two clicks in the same tick both read stale state, so
  // state alone lets the second one through.
  const endingRef = useRef(false);
  const [ending, setEnding] = useState(false);

  // Ending is a two-step await, so a second click can land between the flush
  // and the DELETE. The server ignores the duplicate, but nothing should fire a
  // request it already has in flight. The ref is the guard and the state only
  // dims the button: two clicks in the same tick both read stale state, so
  // state alone lets the second one through.
  async function endStandup() {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    // Ending closes the session to writes, so the pending debounce goes out
    // first or the facilitator's last sentence is lost. If that save fails the
    // session stays open: ending cannot be undone from here, but retrying can,
    // so the failure is surfaced instead of being closed over — and the button
    // has to come back, or the retry it offers is not reachable.
    try {
      try {
        await flush();
      } catch {
        throw new Error("Your last changes could not be saved, so the session is still open. Try again.");
      }
      await api("DELETE", `/api/sessions/${env.id}`);
    } finally {
      endingRef.current = false;
      setEnding(false);
    }
    say("Session closed — members can still open the results");
  }

  async function run(
    fn: () => Promise<unknown>,
    { where = "round", retry = true }: { where?: Where; retry?: boolean } = {},
  ) {
    try {
      setFail(null);
      await fn();
      return true;
    } catch (e) {
      // Ending is the one action a retry cannot simply repeat — it is offered
      // by the confirm rather than by the row, and its message says so itself.
      setFail({ where, msg: errorText(e), retry: retry ? () => run(fn, { where, retry }) : undefined });
      return false;
    }
  }

  const failRow = (where: Where) =>
    fail?.where === where ? (
      <ErrorRow
        fail={fail}
        onDismiss={() => setFail(null)}
        onRetry={fail.retry ? () => void fail.retry!() : undefined}
      />
    ) : null;

  const skippedNames = st.entries.filter((e) => e.skipped).map((e) => nameOf(e.userId));

  const blockersText = st.entries
    .filter((e) => e.blockers.trim() && !e.skipped)
    .map((e) => `${nameOf(e.userId)}: ${e.blockers.trim()}`)
    .join("\n");

  // The rail is the round, so it is housed in the round bar rather than left
  // loose between the chrome and the speaker card.
  const rail = <ol className="flex flex-wrap items-center gap-2">
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
              {/* The order was semantic only: an <ol> that drew no numbers, so
                  "am I next" meant counting wrapped chips. */}
              <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-faint" aria-hidden="true">
                {e.position}
              </span>
              {/* The name sits in text beside it, so the chip is
                  decorative here — otherwise it doubles the button's name. */}
              {p && (
                <span aria-hidden="true">
                  <Avatar
                    name={p.name}
                    hue={p.avatarHue}
                    icon={p.avatarIcon}
                    size="sm"
                    dim={e.skipped}
                  />
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
                {p?.guest && <span className="font-normal text-ink-faint"> · guest</span>}
              </span>
            </button>
            {(isCurrent || e.skipped) && (
              <span className="sr-only">{isCurrent ? " — speaking now" : " — turn skipped"}</span>
            )}
          </li>
        );
      })}
    </ol>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-5 sm:p-7">
      {/* Not a panel. The session's name lives in the shell header and the
          countdown lives in the round bar, so a bordered, padded surface here
          would be chrome around two tertiary links. */}
      <header className="-mb-2 flex flex-wrap items-center justify-end gap-3">
        <span data-testid="session-actions" className="flex items-center gap-2">
        {/* Refused to a link guest, whose capability is this round, not its
            record. */}
        {!guest && (
        <a
          href={`/api/sessions/${env.id}/export.csv`}
          download
          className="text-sm font-bold text-ink-soft hover:text-accent"
        >
          Export CSV
        </a>
        )}
        {isFacilitator && !env.endedAt && (
          <button
            className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-stop disabled:opacity-50"
            disabled={ending}
            onClick={() => setConfirmEnd(true)}
          >
            End session
          </button>
        )}
        </span>
      </header>
      {failRow("chrome")}

      {/* The round bar: how far in we are, who follows, and how long is left —
          the three facts the room reads, at the scale it reads them from. */}
      {(speaking || done) && (
        <section
          data-testid="round-bar"
          data-cue={cue}
          className="flex flex-col gap-4 rounded-panel border border-line px-5 py-4 shadow-rest"
          style={{
            background: `var(${cueVar(cue)})`,
            transition: "background-color var(--dur-flip) var(--ease-settle)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p
              data-testid="round-progress"
              aria-hidden="true"
              className="font-mono text-[length:var(--text-num-table)] font-semibold tabular-nums text-ink-soft"
            >
              {position}
              <span className="text-ink-faint"> / {speakers.length}</span>
              <span className="ml-2 align-middle text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                {done ? "done" : "speaking"}
              </span>
            </p>
            <p data-testid="next-speaker" className="mt-1 text-[13px] font-semibold text-ink-faint">
              {nextLabel}
            </p>
            {/* The Timer said this to a screen reader and to nobody else. The
                length is a session setting with no UI to change it, so stating
                it is the only way the room learns what it is. */}
            {speaking && (
              <p data-testid="turn-length" className="mt-0.5 font-mono text-[11px] tracking-[0.04em] text-ink-faint">
                {st.secondsPerPerson}s each
              </p>
            )}
          </div>
          {speaking && st.speakerStartedAt && (
            <Timer startedAt={st.speakerStartedAt} seconds={st.secondsPerPerson} serverTime={env.serverTime} />
          )}
          </div>
          {rail}
        </section>
      )}


      {!speaking && !done && (
        <section className="flex flex-col gap-4 rounded-panel border border-line bg-surface px-5 py-5 shadow-rest">
          <p className="text-ink-soft">
            Jot down your update while everyone gathers. Your notes save automatically.
          </p>
          <EntryForm draft={draft} update={update} saveState={saveState} />
          <button
            // Filled navy on both this and Start put two primaries on one
            // screen and left the round's actual action competing with a
            // toggle. The label already says which way it is set.
            className={buttonQuiet + " self-start"}
            aria-pressed={iAmReady}
            onClick={() => run(() => action(env.id, "ready", { ready: !iAmReady }), { where: "gathering" })}
          >
            {iAmReady ? "Ready — stand back down" : "I'm ready"}
          </button>
          {/* Who the room is waiting on, in words — a dot or a tint alone would
              leave the only copy of this fact in colour. Only the people still
              writing are named: the other rows carried one bit each and said
              the thing nobody is waiting to hear. */}
          <div data-testid="ready-roster" className="text-sm">
            {waitingOn.length === 0 ? (
              <p className="font-bold text-accent">Everyone is ready.</p>
            ) : (
              <>
                <p className="text-ink-faint">Still writing</p>
                <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {waitingOn.map((p) => (
                    <li key={p.userId} className="flex items-center gap-1.5">
                      <Avatar
                        name={p.name}
                        hue={p.avatarHue}
                        icon={p.avatarIcon}
                        size="sm"
                      />
                      <span className="font-bold">
                        {p.name}
                        {p.guest && <span className="font-normal text-ink-faint"> · guest</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {failRow("gathering")}
          {isFacilitator && (
            <button className={buttonPrimary + " self-start"} onClick={() => run(() => action(env.id, "start"), { where: "gathering" })}>
              {`Start the round · ${readyCount} of ${speakers.length} ready`}
            </button>
          )}
        </section>
      )}

      {(speaking || done) && shown && (
        <section className="flex flex-col gap-4 rounded-panel bg-surface p-6 shadow-rest">
          <div className="flex items-center gap-3">
            {people.get(shown.userId) && (
              <Avatar
                name={people.get(shown.userId)!.name}
                hue={people.get(shown.userId)!.avatarHue}
                icon={people.get(shown.userId)!.avatarIcon}
                size="lg"
              />
            )}
            <h2 className="font-display text-2xl font-semibold">
              {people.get(shown.userId)?.name}
              {people.get(shown.userId)?.guest && (
                <span className="ml-2 align-middle text-sm font-normal text-ink-faint">guest</span>
              )}
            </h2>
          </div>
          {canEditOwn && shown.userId === me.id ? (
            <EntryForm draft={draft} update={update} saveState={saveState} />
          ) : (
            <div data-testid="entry-body" className="flex flex-col gap-3">
              {/* An em dash per field said "nothing here" for a seat that was
                  never asked. The rail knew the difference; the card did not.
                  It sits above the fields rather than replacing them — a
                  skipped person's written update is still worth reading, which
                  is the whole point of being able to open their seat. */}
              {shown.skipped && (
                <p className="rounded-chip bg-felt-deep px-3 py-2 text-sm font-semibold text-ink-soft">
                  Turn skipped.
                </p>
              )}
              {(
                <dl className="flex flex-col gap-3">
                  {(["yesterday", "today", "blockers"] as const).map((f) => (
                    <div key={f}>
                      <dt className="text-xs font-bold uppercase tracking-wide text-ink-faint">{f}</dt>
                      <dd className="whitespace-pre-wrap">
                        {shown[f] || <span className="text-ink-faint">Nothing written</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
          {canEditOwn && shown.userId !== me.id && speakers.some((p) => p.userId === me.id) && (
            <button
              className={buttonQuiet + " self-start"}
              onClick={() => setPickedId(me.id)}
            >
              Edit your update
            </button>
          )}
          {speaking && current && isFacilitator && (
            // Pinned, because the card above it is as tall as whatever the
            // speaker typed — so this moved between speakers, six times a
            // meeting, with a room watching.
            <div
              data-testid="facilitator-bar"
              className="sticky bottom-0 -mx-6 -mb-6 flex gap-2 rounded-b-panel bg-surface px-6 py-4"
            >
              <button className={buttonPrimary} onClick={() => run(() => action(env.id, "next"))}>
                Next
              </button>
              <button className={buttonQuiet} onClick={() => run(() => action(env.id, "skip"))}>
                Skip turn
              </button>
            </div>
          )}
          {failRow("round")}
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
                  // Undefined on an insecure origin, and rejectable on a denied
                  // permission — which is exactly where a self-hoster on plain
                  // HTTP lives. It used to reject unhandled and just look broken.
                  try {
                    await navigator.clipboard.writeText(blockersText);
                    setCopyFailed(false);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    setCopyFailed(true);
                  }
                }}
              >
                {copied ? "Copied!" : "Copy blockers"}
              </button>
              {copyFailed && (
                <p role="alert" className="text-sm font-bold text-stop">
                  Could not copy — select the text above and copy it yourself.
                </p>
              )}
            </>
          ) : (
            <EmptyTable
              art={<DaybreakArt />}
              heading="No blockers today"
              body="Nothing is in anyone's way. Good round."
            />
          )}
          {skippedNames.length > 0 && (
            // The panel is the round's outcome and this is one of them. It sat
            // outside on bare felt, which made it read as a stray line rather
            // than part of the summary.
            <p
              data-testid="skipped-recap"
              className="border-t border-line pt-3 text-sm text-ink-soft"
            >
              <span className="font-bold">No turn taken:</span> {skippedNames.join(", ")}
            </p>
          )}
        </section>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>



      {confirmEnd && (
        <Modal title="End this standup?" onClose={() => setConfirmEnd(false)}>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            This ends the round for everyone in the room right now. The updates stay in the
            space and anyone can still open the results afterwards.
          </p>
          <div className="mt-5 flex justify-end gap-2.5">
            <button className={buttonQuiet} onClick={() => setConfirmEnd(false)}>
              Keep going
            </button>
            <button
              className={buttonDanger}
              disabled={ending}
              onClick={() => {
                setConfirmEnd(false);
                void run(endStandup, { where: "chrome", retry: false });
              }}
            >
              End standup
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** One prompt per field. Two of the three used to sit there unlabelled. */
const PROMPTS = {
  yesterday: "What did you get done?",
  today: "What are you picking up?",
  blockers: "Anything in your way?",
} as const;

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
            placeholder={PROMPTS[f]}
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

/**
 * Daybreak, drawn: a sun clearing the horizon. The poker empty state stacks
 * cards because a poker round has a deck in it; a standup has never had one.
 * What it has is the same morning the round bar lights.
 */
function DaybreakArt() {
  return (
    <div data-testid="daybreak-art" className="relative h-24 w-[120px]">
      {/* The sky clips the disc at the horizon, so the sun rises through the
          line rather than sitting on top of it. Filled, not outlined — an
          unfilled disc on a surface-coloured panel is just an arc. */}
      <span className="absolute inset-x-0 top-4 bottom-10 overflow-hidden">
        <span className="absolute top-0 left-1/2 h-20 w-20 -translate-x-1/2 rounded-full border-2 border-pip bg-pip/25" />
      </span>
      <span className="absolute inset-x-0 bottom-10 h-px bg-line" />
      <span className="absolute inset-x-6 bottom-6 h-px bg-line opacity-70" />
      <span className="absolute inset-x-12 bottom-3 h-px bg-line opacity-50" />
    </div>
  );
}
