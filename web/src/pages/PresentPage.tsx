import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useSession } from "../lib/useSession";
import type { Envelope, Person } from "../lib/api";
import { useFanReflow } from "../lib/fanMotion";
import type { ConnectionStatus } from "../lib/socket";
import { focusedParentId, splitFanOf } from "../lib/splitFan";
import { SplitStrip, StoryTree } from "../components/StoryTree";
import { safeDisplayName } from "../lib/displayName";
import { faceOf } from "../components/Table";
import { heroOf, spreadOf, spreadText } from "../components/ResultsPanel";
import { resultStampsAt } from "../lib/motion";
import { Timer } from "./StandupRoom";

// The same guest tell every other roster shows — PokerRoom, StandupRoom and
// Table all render " · guest" the same way, so this page matches rather than
// inventing its own.
function GuestMark({ person }: { person: Person }) {
  return person.guest ? <span className="font-normal text-ink-faint"> · guest</span> : null;
}

/**
 * A read-only view of a room for a shared screen or a meeting's main stage.
 * It depends on nothing but the session id and the envelope every participant
 * is already sent, so it can never show more than a seat at the table would.
 */
export function PresentPage({ id: given }: { id?: string } = {}) {
  const params = useParams();
  const id = given ?? params.id ?? "";
  const session = useSession(id);
  const env = session.data;
  if (session.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  }
  if (!env) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-8 text-center">
        <h1 className="font-display text-3xl">This room can't be shown</h1>
      </main>
    );
  }
  return (
    <main className="min-h-dvh bg-felt p-6 text-ink sm:p-12">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-lg text-ink-soft wrap-anywhere">{env.title}</p>
        {env.endedAt && <p className="font-semibold text-ink-soft">Session ended</p>}
      </header>
      {session.status !== "live" && (
        <p role="status" className="mt-4 rounded-chip bg-surface px-4 py-3 font-semibold text-stop">
          {session.status === "removed" || session.status === "kicked"
            ? "Access ended — this display is no longer updating."
            : session.status === "stale"
              ? "Connection lost — showing the last received state. It may be out of date."
              : "Reconnecting — showing the last received state until the connection returns."}
        </p>
      )}
      {env.kind === "poker" ? (
        <Poker env={env} status={session.status} />
      ) : env.kind === "standup" ? (
        <Standup env={env} live={session.status === "live"} />
      ) : (
        <h1 className="mt-6 font-display text-4xl">This ceremony has no presenter view</h1>
      )}
    </main>
  );
}

const isNeverHeld = () => false;

function Poker({ env, status }: { env: Envelope; status: ConnectionStatus }) {
  const st = env.state;
  const story = st.stories.find((s) => s.id === st.currentStoryId);
  const fan = splitFanOf(st, focusedParentId(st, null));
  const isParentOnTable = Boolean(fan && !fan.isAdopted && story?.id === fan.parent.id);
  const stage = useRef<HTMLDivElement>(null);
  const reflowFan = useFanReflow(stage, isNeverHeld);
  const voted = new Set(story?.votedUserIds ?? []);
  const votes = env.revealed ? (story?.votes ?? []) : [];
  const valueOf = (userId: string) => votes.find((v) => v.userId === userId)?.value;
  const hero = env.revealed && story?.results ? heroOf(story.results, st.deck.values) : null;
  const spread = hero && story?.results ? spreadOf(story.results, st.deck.values) : undefined;
  // Stamp the answer in only when this mount watched the reveal happen; a view
  // opened, reloaded or reconnected after it renders the number at once.
  const [wasHidden] = useState(!env.revealed);
  const seats = env.participants.filter((p) => !p.spectator);
  return (
    <div ref={stage} data-fan-scope className="relative flex flex-col gap-5">
      {fan && (
        <>
          <div data-fan-item="strip" data-fan-strip="slim" className="fan-strip mt-6 flex flex-wrap items-center gap-x-4 px-5 py-3">
            <span className="fan-plate" data-fan-plate data-fan-origin aria-hidden="true" />
            <SplitStrip fan={fan} />
          </div>
          <StoryTree
            env={env}
            parentId={fan.parent.id}
            canEdit={false}
            status={status}
            onReflow={reflowFan}
            isCollapsed={fan.isAdopted && story?.parentId === fan.parent.id && env.endedAt === null}
          />
        </>
      )}
      {!isParentOnTable && (
        <div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-balance wrap-anywhere sm:text-4xl">
            {story ? story.title || story.ref || "Ad hoc round" : fan ? "Nothing on the table" : "No story on the table"}
          </h1>
          {story?.ref && story.title && <p className="mt-2 font-mono text-2xl text-ink-soft">{story.ref}</p>}
        </div>
      )}
      {hero && !isParentOnTable && (
        <p className="mt-3 text-2xl text-ink-soft">
          <span
            data-present-answer
            className="block font-mono font-bold leading-none text-ink"
            style={{
              fontSize: "clamp(8rem, 22vh, 16rem)",
              animation: wasHidden ? `stamp-in 350ms var(--ease-settle) ${resultStampsAt(seats.length)}ms both` : undefined,
            }}
          >
            {hero.value}
          </span>
          {hero.label} · {hero.sub}
          {spread && (
            <span className="mt-2 block text-3xl font-bold" style={{ color: "var(--color-stop)" }}>
              {spreadText(spread)}
            </span>
          )}
        </p>
      )}
      {story && !env.revealed && !isParentOnTable && (
        <p className="mt-3 text-3xl font-semibold text-ink-soft">
          {voted.size} of {seats.length} voted
        </p>
      )}
      {story && !isParentOnTable && (
        <ul className="mt-5 flex flex-wrap gap-4 [&>li]:min-w-40 [&>li]:text-center">
          {env.participants
            .filter((p) => !p.spectator)
            .map((p) => {
              const value = valueOf(p.userId);
              return (
                <li
                  key={p.userId}
                  className="rounded-panel border border-line bg-surface px-6 py-4 text-2xl shadow-rest"
                >
                  <span className="font-bold">
                    {safeDisplayName(p.name)}
                    <GuestMark person={p} />
                  </span>{" "}
                  <span className="font-mono text-ink-soft">
                    {value !== undefined ? faceOf(value) : voted.has(p.userId) ? "voted" : "not yet"}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

type StandupView = {
  currentSpeakerId: string | null;
  speakerStartedAt: string | null;
  secondsPerPerson: number;
  entries?: { userId: string; ready?: boolean; skipped?: boolean }[];
};

function Standup({ env, live }: { env: Envelope; live: boolean }) {
  // Only the turn and ready flags are read; entry text is never touched here.
  const st = env.state as unknown as StandupView;
  const speaker = env.participants.find((p) => p.userId === st.currentSpeakerId);
  const name = (id: string) => safeDisplayName(env.participants.find((p) => p.userId === id)?.name ?? "Someone");
  const entries = st.entries ?? [];
  const order = entries.filter((e) => env.participants.some((p) => p.userId === e.userId && !p.spectator));
  const at = order.findIndex((e) => e.userId === st.currentSpeakerId);
  const next = order.slice(at + 1).find((e) => !e.skipped);
  const waiting = order.filter((e) => !e.ready);
  const speaking = env.phase === "speaking";
  const done = env.phase === "done";
  return (
    <>
      <h1 className="mt-4 text-3xl font-bold tracking-tight wrap-anywhere sm:text-5xl">
        {speaker ? (
          <>
            {safeDisplayName(speaker.name)}
            <GuestMark person={speaker} /> is speaking
          </>
        ) : done ? (
          "Round complete"
        ) : speaking ? (
          "Nobody is speaking"
        ) : (
          "Gathering updates"
        )}
      </h1>
      {!speaking && !done && order.length > 0 && (
        <p className="mt-4 text-2xl text-ink-soft">
          {order.length - waiting.length} of {order.length} ready
          {waiting.length > 0 && <> · still writing: {waiting.map((e) => name(e.userId)).join(", ")}</>}
        </p>
      )}
      {speaker && st.speakerStartedAt && (
        <p className="mt-8">
          <Timer
            startedAt={st.speakerStartedAt}
            seconds={st.secondsPerPerson}
            serverTime={env.serverTime}
            live={live}
          />
        </p>
      )}
      {speaking && at >= 0 && (
        <p className="mt-6 text-2xl text-ink-soft">
          {next ? `Next: ${name(next.userId)}` : "Last turn"} · {at + 1} of {order.length}
        </p>
      )}
    </>
  );
}
