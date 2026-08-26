import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { action, api, errorText, type Envelope, type Me, type Person, type Story } from "../lib/api";
import { cueFor, useCueAccumulator, useRoundEpoch } from "../lib/cue";
import { GRACE_SECONDS, claimState, voteTally } from "../lib/derive";
import { useCountdown, useToast } from "../lib/ui";
import { Avatar } from "../components/Avatar";
import { Hand } from "../components/Hand";
import { ErrorRow, Modal, buttonDanger, buttonGo, buttonPrimary, buttonQuiet, type Fail } from "../components/Modal";
import { ResultsPanel, heroOf } from "../components/ResultsPanel";
import { StoryQueue } from "../components/StoryQueue";
import { Table, faceOf } from "../components/Table";

export function PokerRoom({ env, me, guest = false }: { env: Envelope; me: Me; guest?: boolean }) {
  const say = useToast();
  const st = env.state;
  const isFacilitator = !guest && env.facilitatorId === me.id;
  const current: Story | undefined = st.stories.find((s) => s.id === st.currentStoryId);
  const self = env.participants.find((p) => p.userId === me.id);
  const ended = env.endedAt !== null;

  const [selected, setSelected] = useState<string | null>(null);
  // Tagged with where it happened: an error belongs beside the control that
  // raised it, not in one shared line in the middle of the page.
  const [fail, setFail] = useState<(Fail & { where: "room" | "queue" }) | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const online = new Set(env.presence);
  const seated: Person[] = env.participants.filter((p) => !p.spectator);
  const spectators: Person[] = env.participants.filter((p) => p.spectator && online.has(p.userId));
  const votes = new Map((current?.votes ?? []).map((v) => [v.userId, v.value]));
  const results = env.revealed ? current?.results : undefined;
  // Computed once so the render guard, the click handler and the label can
  // never disagree about which value is offered — three separate calls used
  // to drift out of sync and post an estimate the deck would reject.
  const hero = results ? heroOf(results, st.deck.values) : undefined;
  const tally = voteTally(seated, online, current?.votedUserIds ?? [], votes);

  // The round boundary, found client-side. NOT env.version — the server bumps
  // that on every vote too. See useRoundEpoch.
  const epoch = useRoundEpoch(st.currentStoryId, env.revealed, tally.votedCount);
  const cueState = useCueAccumulator(epoch, cueFor(tally.votedCount, tally.canVote, env.revealed));

  // A new story or a fresh round means a fresh hand — never carry a stale pick.
  // Keyed on the epoch, not on [currentStoryId, revealed]: a pre-reveal Reset
  // moves neither of those and left the stale pick sitting on the table.
  useEffect(() => {
    setSelected(null);
    setFail(null);
  }, [epoch]);

  async function run(
    fn: () => Promise<unknown>,
    opts: { where?: "room" | "queue"; retry?: boolean } = {},
  ) {
    try {
      setFail(null);
      await fn();
      return true;
    } catch (e) {
      setFail({
        where: opts.where ?? "room",
        msg: errorText(e),
        // Only offer a retry where re-running the call is harmless.
        retry: opts.retry ? fn : undefined,
      });
      return false;
    }
  }

  async function castVote(value: string) {
    if (!current || env.revealed || ended) return;
    const prev = selected;
    setSelected(value); // Optimistic: the card lifts before the round-trip.
    if (!(await run(() => action(env.id, "vote", { storyId: current.id, value })))) {
      setSelected(prev);
    }
  }

  // The next thing worth pointing at, in queue order — skipping what is done.
  const nextUnestimated = st.stories.find((s) => s.id !== current?.id && !s.estimate);

  // A guest may never take the chair, so it is never offered.
  const { showClaim, graceLeft } = claimState(env, isFacilitator || guest);
  const claimLeft = useCountdown(graceLeft);
  const facilitator = env.participants.find((p) => p.userId === env.facilitatorId);

  return (
    <div className="flex flex-wrap items-start gap-6 p-5 sm:p-7">
      <div className="flex min-w-0 flex-1 basis-[560px] flex-col gap-5">
        {/* Story on the table, plus whoever is running the round. */}
        <header className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-5 py-4 shadow-rest">
          {current ? (
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="flex items-center gap-2">
                <span
                  className={"font-mono text-[11px] text-ink-faint" + (current.ref ? "" : " italic")}
                >
                  {current.ref || "ad hoc · no ticket"}
                </span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent">
                  current
                </span>
              </div>
              <h2 className="mt-0.5 line-clamp-2 text-lg font-extrabold tracking-tight">
                {current.title || current.ref || "ad hoc round"}
              </h2>
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
                  onClick={() => run(() => action(env.id, "reveal"), { retry: true })}
                >
                  Reveal
                </button>
              ) : (
                (current?.estimate ? (
                  // The round is written down. The button used to stay put and
                  // still say "Save", so the only evidence of the save expired
                  // with the toast and a second click looked like the first.
                  <>
                    <span className="rounded-full border border-settled px-4 py-2 font-mono text-sm font-bold text-settled">
                      Saved {faceOf(current.estimate)} to {current.ref || "the ad-hoc round"}
                    </span>
                    {nextUnestimated && (
                      <button
                        className={buttonPrimary}
                        onClick={async () => {
                          if (await run(() => action(env.id, "select", { storyId: nextUnestimated.id }))) {
                            say(`${nextUnestimated.ref || nextUnestimated.title || "Next story"} is on the table`);
                          }
                        }}
                      >
                        Next story
                      </button>
                    )}
                  </>
                ) : (
                  // Nothing to offer when the room only played "?" or coffee:
                  // there is no estimate in that round to write down.
                  results &&
                  hero &&
                  (hero.save ? (
                    <button
                      className={buttonGo}
                      onClick={async () => {
                        const value = hero.save!;
                        if (await run(() => action(env.id, "story", { storyId: current!.id, estimate: value }))) {
                          say(`Estimate ${value} saved to ${current!.ref || "the ad-hoc round"}`);
                        }
                      }}
                    >
                      Save {hero.value} to story
                    </button>
                  ) : (
                    hero.label === "median" && (
                      // A silent gap here reads as a missing button with no
                      // reason, and a screen reader gets nothing at all. Say
                      // why, inside a live region so it is announced.
                      <p role="status" aria-live="polite" className="text-[13px] font-semibold text-ink-faint">
                        {hero.value} isn't a card in this deck — vote again to settle on one.
                      </p>
                    )
                  ))
                ))
              )}
              <button className={buttonQuiet} onClick={() => (env.revealed ? setConfirmReset(true) : reset())}>
                Reset
              </button>
              </>
            )}

            {/* Session-level actions, held off the round-action cluster by a
                hairline: End session used to sit a cursor-width from Export CSV
                at the same size and weight. */}
            <span className="flex items-center gap-2 border-l border-line pl-3">
              {/* A link guest is refused the export, and the whole room's
                  votes are more than its capability anyway. */}
              {!guest && (
              <a
                href={`/api/sessions/${env.id}/export.csv`}
                download
                className="px-2 text-[13px] font-semibold text-ink-faint hover:text-accent"
              >
                Export CSV
              </a>
              )}
              {isFacilitator && !ended && (
                <button
                  className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-stop"
                  onClick={() => setConfirmEnd(true)}
                >
                  End session
                </button>
              )}
            </span>
          </div>
        </header>

        {fail?.where === "room" && (
          <ErrorRow
            fail={fail}
            onDismiss={() => setFail(null)}
            onRetry={fail.retry && (() => run(fail.retry!, { retry: true }))}
          />
        )}

        {ended && (
          <div className="rounded-panel border border-line bg-surface px-8 py-6 text-center shadow-rest">
            <p className="font-display text-2xl">This session has ended</p>
            <p className="mt-1.5 text-[13px] text-ink-soft">
              {env.title} wrapped up. Its results are saved in the space.
            </p>
            {/* A link guest's capability is this room alone; the space behind
                it refuses them, so the way out is not offered — and a guest is
                never the facilitator, so the whole row goes with it. */}
            {!guest && (
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
            )}
          </div>
        )}

        {showClaim && facilitator && (
          <div
            className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-5 py-4 shadow-lift"
            style={{ animation: "modal-drop 300ms var(--ease-settle)" }}
          >
            <span className="relative opacity-60">
              <Avatar
                name={facilitator.name}
                hue={facilitator.avatarHue}
                icon={facilitator.avatarIcon}
                size="md"
              />
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
                // Zero is the moment it becomes claimable, so test for null
                // explicitly — a falsy check disables the button exactly when
                // the grace period has run out.
                disabled={claimLeft === null || claimLeft > 0}
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

        {current && !ended ? (
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
            cueState={cueState}
          />
        ) : !ended ? (
          <EmptyTable
            heading={st.stories.length === 0 ? "Deal the first story" : "Nothing on the table"}
            body={
              st.stories.length === 0
                ? "Two ways in: queue up tickets, or just start pointing and keep the numbers wherever you already track them."
                : "Pick a story from the queue and the table opens for votes."
            }
            footnote={
              st.stories.length === 0
                ? "Ad-hoc rounds need no ticket number — name it in a word, or leave it blank and read the result off the table."
                : undefined
            }
            actions={
              isFacilitator && !ended && st.stories.length === 0 ? (
                <>
                  <button className={buttonPrimary} onClick={quickRound}>
                    Point something now
                  </button>
                  <span className="font-mono text-[11px] text-ink-faint">
                    or use “+ Ticket” in the story queue
                  </span>
                </>
              ) : undefined
            }
          />
        ) : null}

        {results && <ResultsPanel results={results} />}

        {current && !ended && (
          // Sticky so voting never needs a scroll: on a phone 15 seats take
          // several ranks and the page becomes a scrolling document.
          // ponytail: this works only because Hand is the LAST child of a
          // column taller than the viewport. Reorder StoryQueue or anything
          // else below it and the stickiness dies silently, with no test to
          // catch it — the upgrade path is a real bottom-sheet portal.
          // Observed firing, not theorised: below `lg` the aside stacks under
          // the column, so near max scroll the hand unpins for the last stretch
          // of document that sits outside its containing block.
          <div className="sticky bottom-0 z-10 bg-felt pt-2 pb-1">
            <Hand
              values={st.deck.values}
              deckName={st.deck.name}
              selected={selected}
              disabled={env.revealed}
              spectating={self?.spectator ?? false}
              canSpectate={!env.revealed && !guest}
              onPick={(v) => (selected === v ? undefined : castVote(v))}
              onToggleSpectate={() =>
                run(() =>
                  api("POST", `/api/sessions/${env.id}/spectator`, { on: !(self?.spectator ?? false) }),
                )
              }
            />
          </div>
        )}
      </div>

      <StoryQueue
        sessionId={env.id}
        stories={st.stories}
        currentStoryId={st.currentStoryId}
        isFacilitator={isFacilitator && !ended}
        onQuickRound={quickRound}
        fail={fail?.where === "queue" ? fail : null}
        onFail={(msg, retry) => setFail({ where: "queue", msg, retry })}
        onDismiss={() => setFail(null)}
      />

      {confirmEnd && (
        <Modal title="End this session?" onClose={() => setConfirmEnd(false)}>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            This ends the round for everyone at the table right now. The results stay in{" "}
            the space and you can reopen the session afterwards.
          </p>
          <div className="mt-5 flex justify-end gap-2.5">
            <button className={buttonQuiet} onClick={() => setConfirmEnd(false)}>
              Keep playing
            </button>
            <button
              className={buttonDanger}
              onClick={async () => {
                setConfirmEnd(false);
                if (await run(() => api("DELETE", `/api/sessions/${env.id}`))) {
                  say("Session closed — members can still open the results");
                }
              }}
            >
              End session
            </button>
          </div>
        </Modal>
      )}

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

  // An ad-hoc round: a story with no ticket behind it, dealt straight to the
  // table so the room can point something the tracker has never heard of.
  async function quickRound() {
    const before = new Set(st.stories.map((s) => s.id));
    if (!(await run(() => action(env.id, "stories", { title: "Ad-hoc round" }), { where: "queue" }))) return;
    // Outside run(), a failure here rejected unhandled and the button just
    // looked broken — while the story had in fact already been created.
    let added;
    try {
      const fresh = await api<Envelope>("GET", `/api/sessions/${env.id}`);
      added = fresh.state.stories.find((s) => !before.has(s.id));
    } catch {
      setFail({
        where: "queue",
        msg: "The round was added but the table could not be refreshed — pick it from the queue.",
      });
      return;
    }
    if (!added) {
      setFail({
        where: "queue",
        msg: "The round was added but could not be found to deal — pick it from the queue.",
      });
      return;
    }
    if (await run(() => action(env.id, "select", { storyId: added.id }), { where: "queue", retry: true })) {
      say("Ad-hoc round on the table — no ticket needed");
    }
  }

  async function reset() {
    if (await run(() => action(env.id, "reset"), { retry: true })) {
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
  actions,
  footnote,
  art,
}: {
  heading: string;
  body: string;
  actions?: ReactNode;
  footnote?: string;
  /** Defaults to the card stack. A session without a deck brings its own. */
  art?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-8 py-16">
      {art ?? (
      <div className="relative h-24 w-[120px]">
        <span className="absolute inset-x-2.5 bottom-0 top-6 rounded-[10px] border border-line bg-felt-deep shadow-well" />
        <span className="absolute left-8 top-0.5 h-[54px] w-[38px] -rotate-[7deg] rounded-chip border border-line bg-surface shadow-rest" />
        <span className="absolute left-[52px] top-1.5 flex h-[54px] w-[38px] rotate-[6deg] items-center justify-center rounded-chip bg-card-back shadow-rest">
          <span className="h-2.5 w-2.5 rotate-45 border-2 border-pip opacity-50" />
        </span>
        <span className="absolute inset-x-1 bottom-0 top-11 rounded-[10px] border border-line bg-felt-deep" />
      </div>
      )}
      <p className="font-display text-[1.75rem]">{heading}</p>
      <p className="max-w-[420px] text-center text-sm text-ink-soft text-pretty">{body}</p>
      {actions && <div className="flex flex-wrap items-center justify-center gap-2.5">{actions}</div>}
      {footnote && (
        <p className="max-w-[400px] text-center text-xs text-ink-faint text-pretty">{footnote}</p>
      )}
    </div>
  );
}
