import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Envelope, type Me, type Story } from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { PresenceStrip } from "../components/PresenceStrip";
import { CardFace, TableCard } from "../components/CardFace";
import { ResultsBar } from "../components/ResultsBar";
import { StoryQueue } from "../components/StoryQueue";
import { Modal, buttonDanger, buttonPrimary, buttonQuiet, inputClass } from "../components/Modal";

export function PokerRoom({
  env,
  me,
  status,
}: {
  env: Envelope;
  me: Me;
  status: ConnectionStatus;
}) {
  const isFacilitator = env.facilitatorId === me.id;
  const st = env.state;
  const current: Story | undefined = st.stories.find((s) => s.id === st.currentStoryId);
  const self = env.participants.find((p) => p.userId === me.id);

  // Optimistic selection: set on tap, rolled back on rejection, cleared when
  // the story changes or a new round starts.
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [estimateDraft, setEstimateDraft] = useState("");
  useEffect(() => {
    setSelected(null);
    setError("");
  }, [st.currentStoryId, env.revealed]);

  async function run(fn: () => Promise<unknown>) {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
    return true;
  }

  async function castVote(value: string) {
    if (!current || env.revealed) return;
    const prev = selected;
    setSelected(value);
    const ok = await run(() => api("POST", `/api/stories/${current.id}/vote`, { value }));
    if (!ok) setSelected(prev);
  }

  const online = new Set(env.presence);
  const seated = env.participants.filter((p) => online.has(p.userId) && !p.spectator);
  const revealedVotes = new Map((current?.votes ?? []).map((v) => [v.userId, v.value]));
  const claimSecondsLeft = env.facilitatorOfflineSince
    ? Math.max(0, 60 - Math.floor((Date.parse(env.serverTime) - Date.parse(env.facilitatorOfflineSince)) / 1000))
    : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <ConnectionBanner status={status} />

      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/s/${env.spaceSlug}`} className="text-sm font-bold text-accent hover:underline">
            ← {env.spaceSlug}
          </Link>
          <h1 className="font-display truncate text-3xl font-semibold">{env.title}</h1>
        </div>
        <PresenceStrip
          participants={env.participants}
          presence={env.presence}
          votedUserIds={current?.votedUserIds ?? []}
          facilitatorId={env.facilitatorId}
        />
      </header>

      {env.endedAt && (
        <p className="rounded-chip bg-felt-deep p-3 text-center font-bold text-ink-soft">
          This session has ended.
          {isFacilitator && (
            <button className="ml-2 text-accent underline" onClick={() => run(() => api("POST", `/api/sessions/${env.id}/reopen`))}>
              Reopen it
            </button>
          )}
        </p>
      )}

      {!env.facilitatorConnected && !isFacilitator && claimSecondsLeft !== null && (
        <p className="rounded-chip bg-felt-deep p-3 text-center text-sm font-bold text-ink-soft">
          The facilitator stepped away.
          {claimSecondsLeft > 0 ? (
            <> Any member can take over in {claimSecondsLeft}s.</>
          ) : (
            <button className="ml-2 text-accent underline" onClick={() => run(() => api("POST", `/api/sessions/${env.id}/facilitator/claim`))}>
              Take over as facilitator
            </button>
          )}
        </p>
      )}

      <main className="flex flex-1 flex-col gap-6 lg:flex-row">
        <section className="flex flex-1 flex-col items-center gap-6">
          {current ? (
            <>
              <div className="text-center">
                <h2 className="font-display text-2xl font-semibold">{current.title}</h2>
                {current.notes && <p className="mt-1 max-w-lg text-sm text-ink-soft">{current.notes}</p>}
              </div>

              {/* The table: one card per seated voter. */}
              <div className="flex min-h-28 w-full flex-wrap items-center justify-center gap-3 rounded-panel bg-felt-deep p-6 shadow-well">
                {seated.map((p, i) =>
                  current.votedUserIds.includes(p.userId) || revealedVotes.has(p.userId) ? (
                    <span key={p.userId} className="flex flex-col items-center gap-1">
                      <TableCard
                        value={revealedVotes.get(p.userId)}
                        revealed={env.revealed}
                        index={i}
                        consensus={current.results?.consensus ?? false}
                      />
                      <span className="max-w-16 truncate text-xs text-ink-soft">{p.name}</span>
                    </span>
                  ) : null,
                )}
                {(current.votedUserIds.length === 0 && revealedVotes.size === 0) && (
                  <span className="text-sm text-ink-faint">Waiting for the first vote…</span>
                )}
              </div>

              {env.revealed && current.results && <ResultsBar results={current.results} />}

              {env.revealed && isFacilitator && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (estimateDraft.trim()) {
                      run(() => api("PATCH", `/api/stories/${current.id}`, { estimate: estimateDraft.trim() }));
                    }
                  }}
                >
                  <input
                    className={inputClass + " w-28"}
                    value={estimateDraft}
                    onChange={(e) => setEstimateDraft(e.target.value)}
                    placeholder={current.results?.mode ?? String(current.results?.median ?? "")}
                    maxLength={16}
                  />
                  <button type="submit" className={buttonPrimary}>Save estimate</button>
                </form>
              )}

              {isFacilitator && !env.endedAt && (
                <div className="flex gap-2">
                  {!env.revealed && (
                    <button
                      className={buttonPrimary}
                      disabled={current.votedUserIds.length === 0}
                      onClick={() => run(() => api("POST", `/api/sessions/${env.id}/reveal`))}
                    >
                      Reveal
                    </button>
                  )}
                  <button className={buttonQuiet} onClick={() => setConfirmReset(true)}>
                    Reset round
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="my-auto text-ink-faint">
              {isFacilitator ? "Pick a story from the queue to start voting." : "Waiting for the facilitator to pick a story."}
            </p>
          )}

          {error && <p role="alert" className="font-bold text-stop">{error}</p>}

          {/* The hand. */}
          {!self?.spectator && current && !env.revealed && !env.endedAt && (
            <div className="flex w-full flex-wrap justify-center gap-2 rounded-panel bg-felt-deep p-4 shadow-well">
              {st.deck.values.map((v) => (
                <CardFace key={v} value={v} selected={selected === v} onClick={() => castVote(v)} />
              ))}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={self?.spectator ?? false}
              onChange={(e) => run(() => api("POST", `/api/sessions/${env.id}/spectator`, { on: e.target.checked }))}
            />
            Just watching (spectator)
          </label>
        </section>

        <aside className="w-full lg:w-72">
          <details className="lg:open:block" open>
            <summary className="mb-2 cursor-pointer font-bold text-ink-soft lg:hidden">Story queue</summary>
            <StoryQueue
              sessionId={env.id}
              stories={st.stories}
              currentStoryId={st.currentStoryId}
              isFacilitator={isFacilitator}
              onError={setError}
            />
          </details>
        </aside>
      </main>

      {confirmReset && (
        <Modal title="Reset this round?" onClose={() => setConfirmReset(false)}>
          <p className="mb-4 text-ink-soft">
            Everyone's votes on this story will be cleared so the table can vote again.
          </p>
          <div className="flex justify-end gap-2">
            <button className={buttonQuiet} onClick={() => setConfirmReset(false)}>Keep votes</button>
            <button
              className={buttonDanger}
              onClick={async () => {
                await run(() => api("POST", `/api/sessions/${env.id}/reset`));
                setConfirmReset(false);
              }}
            >
              Reset round
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
