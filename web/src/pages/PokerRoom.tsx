import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Envelope, type Me, type Person, type Story } from "../lib/api";
import { useCountdown, useToast } from "../lib/ui";
import { Avatar } from "../components/Avatar";
import { Hand } from "../components/Hand";
import { Modal, buttonDanger, buttonPrimary, buttonQuiet } from "../components/Modal";
import { ResultsPanel, heroOf } from "../components/ResultsPanel";
import { StoryQueue } from "../components/StoryQueue";
import { Table } from "../components/Table";

const GRACE_SECONDS = 60;

export function PokerRoom({ env, me }: { env: Envelope; me: Me }) {
  const say = useToast();
  const st = env.state;
  const isFacilitator = env.facilitatorId === me.id;
  const current: Story | undefined = st.stories.find((s) => s.id === st.currentStoryId);
  const self = env.participants.find((p) => p.userId === me.id);
  const ended = env.endedAt !== null;

  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  // A new story or a fresh round means a fresh hand — never carry a stale pick.
  useEffect(() => {
    setSelected(null);
    setError("");
  }, [st.currentStoryId, env.revealed]);

  async function run(fn: () => Promise<unknown>) {
    try {
      setError("");
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
  }

  async function castVote(value: string) {
    if (!current || env.revealed || ended) return;
    const prev = selected;
    setSelected(value); // Optimistic: the card lifts before the round-trip.
    if (!(await run(() => api("POST", `/api/stories/${current.id}/vote`, { value })))) {
      setSelected(prev);
    }
  }

  const online = new Set(env.presence);
  const seated: Person[] = env.participants.filter((p) => !p.spectator);
  const spectators: Person[] = env.participants.filter((p) => p.spectator && online.has(p.userId));
  const votes = new Map((current?.votes ?? []).map((v) => [v.userId, v.value]));
  const results = env.revealed ? current?.results : undefined;

  const offlineFor = env.facilitatorOfflineSince
    ? Math.floor((Date.parse(env.serverTime) - Date.parse(env.facilitatorOfflineSince)) / 1000)
    : null;
  const showClaim = !env.facilitatorConnected && !isFacilitator && offlineFor !== null && !ended;
  const claimLeft = useCountdown(showClaim ? Math.max(0, GRACE_SECONDS - offlineFor) : null);
  const facilitator = env.participants.find((p) => p.userId === env.facilitatorId);

  return (
    <div className="flex flex-wrap items-start gap-6 p-5 sm:p-7">
      <div className="flex min-w-0 flex-1 basis-[560px] flex-col gap-5">
        {/* Story on the table, plus whoever is running the round. */}
        <header className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-5 py-4 shadow-rest">
          {current ? (
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-ink-faint">
                  #{st.stories.findIndex((s) => s.id === current.id) + 1}
                </span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent">
                  current
                </span>
              </div>
              <h1 className="mt-0.5 line-clamp-2 text-lg font-extrabold tracking-tight">{current.title}</h1>
              {current.notes && (
                <p className="mt-0.5 text-xs text-ink-faint">{current.notes}</p>
              )}
            </div>
          ) : (
            <p className="flex-1 text-[15px] font-semibold text-ink-faint">No story on the table</p>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {isFacilitator && !ended && (
              <>
              {!env.revealed ? (
                <button
                  className={buttonPrimary}
                  disabled={!current || (current.votedUserIds.length === 0)}
                  onClick={() => run(() => api("POST", `/api/sessions/${env.id}/reveal`))}
                >
                  Reveal
                </button>
              ) : (
                results && (
                  <button
                    className="rounded-full bg-go px-4 py-2.5 text-sm font-bold text-accent-ink shadow-rest transition hover:shadow-lift"
                    onClick={async () => {
                      const value = heroOf(results).value;
                      if (await run(() => api("PATCH", `/api/stories/${current!.id}`, { estimate: value }))) {
                        say(`Estimate ${value} saved to the story`);
                      }
                    }}
                  >
                    Save {heroOf(results).value} to story
                  </button>
                )
              )}
              <button className={buttonQuiet} onClick={() => (env.revealed ? setConfirmReset(true) : reset())}>
                Reset
              </button>
              <button
                className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-stop"
                onClick={async () => {
                  if (await run(() => api("DELETE", `/api/sessions/${env.id}`))) {
                    say("Session closed — members can still open the results");
                  }
                }}
              >
                End session
              </button>
              </>
            )}

            <a
              href={`/api/sessions/${env.id}/export.csv`}
              download
              className="px-2 text-[13px] font-semibold text-ink-faint hover:text-accent"
            >
              Export CSV
            </a>
          </div>
        </header>

        {ended && (
          <div className="rounded-panel border border-line bg-surface px-8 py-6 text-center shadow-rest">
            <p className="font-display text-2xl">This session has ended</p>
            <p className="mt-1.5 text-[13px] text-ink-soft">
              {env.title} wrapped up. Its results are saved in the space.
            </p>
            <div className="mt-3.5 flex justify-center gap-2.5">
              <Link to={`/s/${env.spaceSlug}`} className={buttonPrimary}>
                Back to the space
              </Link>
              {isFacilitator && (
                <button
                  className={buttonQuiet}
                  onClick={() => run(() => api("POST", `/api/sessions/${env.id}/reopen`))}
                >
                  Reopen it
                </button>
              )}
            </div>
          </div>
        )}

        {showClaim && facilitator && (
          <div
            className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-5 py-4 shadow-lift"
            style={{ animation: "modal-drop 300ms var(--ease-settle)" }}
          >
            <span className="relative opacity-60">
              <Avatar name={facilitator.name} hue={facilitator.avatarHue} size="md" />
              <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-brass ring-2 ring-surface" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold">
                {facilitator.name} — the facilitator — lost connection
              </p>
              <p className="mt-0.5 text-[13px] text-ink-soft">
                {claimLeft && claimLeft > 0
                  ? `If they aren't back in ${claimLeft}s, anyone at the table can take over.`
                  : "The grace period is over — anyone can take over now."}
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              {claimLeft !== null && claimLeft > 0 && <GraceRing left={claimLeft} total={GRACE_SECONDS} />}
              <button
                disabled={!claimLeft || claimLeft > 0}
                onClick={async () => {
                  if (await run(() => api("POST", `/api/sessions/${env.id}/facilitator/claim`))) {
                    say("You're the facilitator now");
                  }
                }}
                className={
                  "rounded-full px-4 py-2.5 text-sm font-bold shadow-rest " +
                  (claimLeft === 0
                    ? "bg-brass text-accent-ink"
                    : "cursor-default bg-felt-deep text-ink-faint")
                }
              >
                {claimLeft === 0
                  ? "Claim facilitator"
                  : `Claim in 0:${String(claimLeft ?? 0).padStart(2, "0")}`}
              </button>
            </div>
          </div>
        )}

        {current ? (
          <Table
            seated={seated}
            spectators={spectators}
            online={online}
            votedUserIds={current.votedUserIds}
            votes={votes}
            revealed={env.revealed}
            consensus={results?.consensus ?? false}
            facilitatorId={env.facilitatorId}
            meId={me.id}
          />
        ) : (
          <EmptyTable
            canAdd={isFacilitator && !ended}
            heading={st.stories.length === 0 ? "Deal the first story" : "Nothing on the table"}
            body={
              st.stories.length === 0
                ? "Add a story to the queue and the table opens for votes. Paste a link and Parley keeps it attached."
                : "Pick a story from the queue and the table opens for votes."
            }
          />
        )}

        {results && <ResultsPanel results={results} />}

        {error && (
          <p role="alert" className="text-center text-sm font-bold text-stop">
            {error}
          </p>
        )}

        {current && !ended && (
          <Hand
            values={st.deck.values}
            deckName={st.deck.name}
            selected={selected}
            disabled={env.revealed}
            spectating={self?.spectator ?? false}
            canSpectate={!env.revealed}
            onPick={(v) => (selected === v ? undefined : castVote(v))}
            onToggleSpectate={() =>
              run(() =>
                api("POST", `/api/sessions/${env.id}/spectator`, { on: !(self?.spectator ?? false) }),
              )
            }
          />
        )}
      </div>

      <StoryQueue
        sessionId={env.id}
        stories={st.stories}
        currentStoryId={st.currentStoryId}
        isFacilitator={isFacilitator && !ended}
        onError={setError}
      />

      {confirmReset && (
        <Modal title="Reset this round?" onClose={() => setConfirmReset(false)}>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Votes are already on the table. Resetting clears all{" "}
            {current?.votes?.length ?? 0} revealed votes for this story and deals a fresh
            round — it can't be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2.5">
            <button className={buttonQuiet} onClick={() => setConfirmReset(false)}>
              Keep votes
            </button>
            <button
              className={buttonDanger}
              onClick={async () => {
                setConfirmReset(false);
                await reset();
              }}
            >
              Reset votes
            </button>
          </div>
        </Modal>
      )}
    </div>
  );

  async function reset() {
    if (await run(() => api("POST", `/api/sessions/${env.id}/reset`))) {
      setSelected(null);
      say("Votes cleared — same story, fresh round");
    }
  }
}

/** The facilitator grace period, draining. */
function GraceRing({ left, total }: { left: number; total: number }) {
  const circumference = 88;
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <circle cx="17" cy="17" r="14" fill="none" stroke="var(--color-line)" strokeWidth="3" />
      <circle
        cx="17"
        cy="17"
        r="14"
        fill="none"
        stroke="var(--color-brass)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={Math.round(circumference - (left / total) * circumference)}
        transform="rotate(-90 17 17)"
      />
    </svg>
  );
}

/** Felt, a couple of cards, and one thing to do. */
export function EmptyTable({
  heading,
  body,
  canAdd,
}: {
  heading: string;
  body: string;
  canAdd?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-8 py-16">
      <div className="relative h-24 w-[120px]">
        <span className="absolute inset-x-2.5 bottom-0 top-6 rounded-[10px] border border-line bg-felt-deep shadow-well" />
        <span className="absolute left-8 top-0.5 h-[54px] w-[38px] -rotate-[7deg] rounded-chip border border-line bg-surface shadow-rest" />
        <span className="absolute left-[52px] top-1.5 flex h-[54px] w-[38px] rotate-[6deg] items-center justify-center rounded-chip bg-card-back shadow-rest">
          <span className="h-2.5 w-2.5 rotate-45 border-2 border-pip opacity-50" />
        </span>
        <span className="absolute inset-x-1 bottom-0 top-11 rounded-[10px] border border-line bg-felt-deep" />
      </div>
      <p className="font-display text-[1.75rem]">{heading}</p>
      <p className="max-w-[380px] text-center text-sm text-ink-soft text-pretty">{body}</p>
      {canAdd && (
        <p className="font-mono text-[11px] text-ink-faint">Use “+ Add” in the story queue.</p>
      )}
    </div>
  );
}
