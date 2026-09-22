import { useParams } from "react-router-dom";
import { useSession } from "../lib/useSession";
import type { Envelope } from "../lib/api";
import { faceOf } from "../components/Table";
import { heroOf } from "../components/ResultsPanel";
import { Timer } from "./StandupRoom";

/**
 * A read-only view of a room for a shared screen or a meeting's main stage.
 * It depends on nothing but the session id and the envelope every participant
 * is already sent, so it can never show more than a seat at the table would.
 */
export function PresentPage() {
  const { id = "" } = useParams();
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
    <main className="min-h-dvh bg-felt p-8 text-ink sm:p-12">
      <p className="font-mono text-lg text-ink-faint">{env.title}</p>
      {env.kind === "poker" ? (
        <Poker env={env} />
      ) : env.kind === "standup" ? (
        <Standup env={env} live={session.status === "live"} />
      ) : (
        <h1 className="mt-6 font-display text-4xl">This ceremony has no presenter view</h1>
      )}
    </main>
  );
}

function Poker({ env }: { env: Envelope }) {
  const st = env.state;
  const story = st.stories.find((s) => s.id === st.currentStoryId);
  const voted = new Set(story?.votedUserIds ?? []);
  // ponytail: values are read only after reveal, so a pre-reveal value has no
  // path into this page even if one ever reached the envelope.
  const votes = env.revealed ? (story?.votes ?? []) : [];
  const valueOf = (userId: string) => votes.find((v) => v.userId === userId)?.value;
  const hero = env.revealed && story?.results ? heroOf(story.results, st.deck.values) : null;
  return (
    <>
      <h1 className="mt-4 text-5xl font-bold tracking-tight text-balance">
        {story ? story.title || story.ref || "Ad hoc round" : "No story on the table"}
      </h1>
      {story?.ref && story.title && <p className="mt-2 font-mono text-2xl text-ink-soft">{story.ref}</p>}
      {hero && (
        <p className="mt-8 text-2xl text-ink-soft">
          <span className="font-mono text-7xl font-bold text-ink">{hero.value}</span>{" "}
          {hero.label} · {hero.sub}
        </p>
      )}
      {story && (
        <ul className="mt-10 flex flex-wrap gap-4">
          {env.participants
            .filter((p) => !p.spectator)
            .map((p) => {
              const value = valueOf(p.userId);
              return (
                <li
                  key={p.userId}
                  className="rounded-panel border border-line bg-surface px-6 py-4 text-2xl shadow-rest"
                >
                  <span className="font-bold">{p.name}</span>{" "}
                  <span className="font-mono text-ink-soft">
                    {value !== undefined ? faceOf(value) : voted.has(p.userId) ? "voted" : "not yet"}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </>
  );
}

type StandupView = {
  currentSpeakerId: string | null;
  speakerStartedAt: string | null;
  secondsPerPerson: number;
};

function Standup({ env, live }: { env: Envelope; live: boolean }) {
  // Only the turn is read; entry text is never touched here.
  const st = env.state as unknown as StandupView;
  const speaker = env.participants.find((p) => p.userId === st.currentSpeakerId);
  return (
    <>
      <h1 className="mt-4 text-5xl font-bold tracking-tight">
        {speaker ? `${speaker.name} is speaking` : "Nobody is speaking"}
      </h1>
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
    </>
  );
}
