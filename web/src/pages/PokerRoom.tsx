import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { action, api, errorText, type Envelope, type Person, type Story } from "../lib/api";
import { cueFor, useCueAccumulator, useRoundEpoch } from "../lib/cue";
import type { RoomProps } from "../lib/kinds";
import { voteTally } from "../lib/derive";
import { useToast } from "../lib/ui";
import {
  FacilitatorClaim,
  FacilitatorHandoff,
  useFacilitatorAnnouncement,
} from "../components/FacilitatorControls";
import { Hand } from "../components/Hand";
import { ErrorRow, Modal, buttonDanger, buttonGo, buttonPrimary, buttonQuiet, type Fail } from "../components/Modal";
import { ResultsPanel, heroOf } from "../components/ResultsPanel";
import { PluginPanels } from "../components/PluginPanels";
import { StoryQueue } from "../components/StoryQueue";
import { Table, faceOf } from "../components/Table";
import { spacePath } from "../lib/paths";
import { safeDisplayName } from "../lib/displayName";

export function PokerRoom({ env, me, status = "live", guest = false, kickReason = "", kicked = null }: RoomProps) {
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
  // Who is about to be shown the door, and what to say on the way out.
  const [confirmRemove, setConfirmRemove] = useState<Person | null>(null);
  const [removeMessage, setRemoveMessage] = useState("");

  const online = new Set(env.presence);
  const seated: Person[] = env.participants.filter((p) => !p.spectator);
  const spectators: Person[] = env.participants.filter((p) => p.spectator && online.has(p.userId));
  const votes = new Map((current?.votes ?? []).map((v) => [v.userId, v.value]));
  const results = env.revealed ? current?.results : undefined;
  // The card you played, as the room has it. `selected` cannot answer this:
  // it is optimistic state the reveal clears, and it is gone after a reload.
  // The envelope's votes survive both, and a reset empties them.
  const myVote = votes.get(me.id) ?? null;
  // Computed once so the render guard, the click handler and the label can
  // never disagree about which value is offered — three separate calls used
  // to drift out of sync and post an estimate the deck would reject.
  const hero = results ? heroOf(results, st.deck.values) : undefined;
  const tally = voteTally(seated, online, current?.votedUserIds ?? [], votes);
  // Who the round is still waiting for, by name. A count alone tells the room
  // that somebody is missing but not whether it is waiting on the one person
  // who has already left for the day. Taken straight from the tally so this
  // line and the count above it cannot disagree about who is in the round.
  const waitingOn = tally.waiting.map((p) => safeDisplayName(p.name));

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

  useFacilitatorAnnouncement(env, me.id);

  // Removed from THIS room, which is not the same as losing the space — the
  // socket said so with its own close code, and this is its own screen. It
  // replaces the room outright: everything below it belongs to a table this
  // person is no longer at.
  if (status === "kicked") return <ShownTheDoor message={kickReason} env={env} guest={guest} />;

  return (
    // pb-44 is on the page, not the left column: the story queue is a sibling
    // of that column and stacks below it on a phone, so with the reserve on
    // the column alone, tabbing into the queue put focus under the fixed hand
    // tray (WCAG 2.2 AA 2.4.11).
    <div className="flex flex-col gap-6 pb-44 lg:pb-0 lg:flex-row lg:flex-wrap lg:items-start p-5 pl-[max(1.25rem,var(--safe-left))] pr-[max(1.25rem,var(--safe-right))] sm:p-7 sm:pl-[max(1.75rem,var(--safe-left))] sm:pr-[max(1.75rem,var(--safe-right))]">
      <div className="flex min-w-0 w-full flex-1 flex-col gap-5 lg:basis-[560px]">
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
              <h2 className="mt-0.5 line-clamp-2 text-lg font-bold tracking-tight">
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
              <button
                className={buttonQuiet}
                aria-pressed={st.autoReveal}
                onClick={() =>
                  run(() => action(env.id, "config", { autoReveal: !st.autoReveal }), { retry: true })
                }
              >
                {st.autoReveal ? "Auto-reveal on" : "Auto-reveal off"}
              </button>
              <button
                className={buttonQuiet}
                aria-pressed={st.openVoting}
                aria-describedby="open-voting-hint"
                onClick={() =>
                  run(() => action(env.id, "config", { openVoting: !st.openVoting }), { retry: true })
                }
              >
                {st.openVoting ? "Open voting on" : "Open voting off"}
              </button>
              {/* The one thing people get wrong about this switch: it is not a
                  second Reveal. Say so where a screen reader will read it with
                  the button. */}
              <span id="open-voting-hint" className="sr-only">
                Changes who the round waits for, not whether it reveals: with open voting on the round
                waits for everyone who has been in this room, connected or not.
              </span>
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
                className="inline-flex items-center px-2 py-2 text-[13px] font-semibold text-ink-faint hover:text-accent"
              >
                Export CSV
              </a>
              )}
              {isFacilitator && !ended && (
                <>
                <FacilitatorHandoff
                  env={env}
                  onTransfer={(p) =>
                    run(() =>
                      api("POST", `/api/sessions/${env.id}/facilitator`, { userId: p.userId }),
                    )
                  }
                />
                <button
                  className="px-2 py-2 text-[13px] font-semibold text-ink-faint transition hover:text-stop"
                  onClick={() => setConfirmEnd(true)}
                >
                  End session
                </button>
                </>
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
              <Link to={spacePath(env.orgSlug, env.spaceSlug)} className={buttonPrimary}>
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

        <FacilitatorClaim
          env={env}
          isFacilitator={isFacilitator}
          guest={guest}
          onClaim={() => run(() => api("POST", `/api/sessions/${env.id}/facilitator/claim`))}
        />

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
            status={status}
            kicked={kicked}
            onRemove={isFacilitator && !ended ? setConfirmRemove : undefined}
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

        {current && !ended && !env.revealed && waitingOn.length > 0 && (
          // Deliberately not a live region: the cue line above already
          // announces "n of m voted" on every change, and a second live
          // region reciting the same round twice is noise, not detail.
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Waiting on{" "}
            {waitingOn.length > 5
              ? `${waitingOn.slice(0, 5).join(", ")} and ${waitingOn.length - 5} more`
              : waitingOn.join(", ")}
          </p>
        )}

        {results && <ResultsPanel results={results} deck={st.deck.values} />}

        {current && !ended && (
          // Fixed on a phone so the hand stays thumb-reachable while the
          // story queue scrolls beneath the column; sticky inside lg where
          // the aside sits beside us and the document tail is short.
          <div className="fixed inset-x-0 bottom-0 z-10 bg-felt pt-2 pb-[var(--safe-bottom)] pl-[max(0px,var(--safe-left))] pr-[max(0px,var(--safe-right))] lg:static lg:inset-x-auto lg:z-auto lg:bg-transparent lg:pb-0 lg:sticky lg:bottom-0">
            <Hand
              values={st.deck.values}
              deckName={st.deck.name}
              selected={selected}
              played={myVote}
              disabled={env.revealed}
              spectating={self?.spectator ?? false}
              canSpectate={!env.revealed && !guest}
              status={status}
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

      {/* Plugin UI, each in its own sandboxed frame. Frames are marked inert
          while a modal is open so focus cannot tab underneath the overlay. */}
      <PluginPanels env={env} modalOpen={Boolean(confirmEnd || confirmReset || confirmRemove)} />

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

      {confirmRemove && (
        <Modal
          title={`Remove ${safeDisplayName(confirmRemove.name)} from the room?`}
          onClose={() => setConfirmRemove(null)}
        >
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            They lose their seat at this table right away. Their space membership is
            untouched — they can be invited back into the room whenever you like.
          </p>
          <label className="mt-4 block text-[13px] font-semibold text-ink-soft" htmlFor="kick-message">
            A message, if you want one (optional)
          </label>
          <textarea
            id="kick-message"
            value={removeMessage}
            onChange={(e) => setRemoveMessage(e.target.value)}
            /* 80 characters, not a round 100: the message rides the websocket
               close frame, which carries 123 BYTES, and a cap in characters
               has to leave room for the multi-byte ones. */
            maxLength={80}
            rows={2}
            placeholder="Wrong room — see you in the retro"
            className="mt-1.5 w-full resize-none rounded-chip border border-line bg-surface px-3 py-2 text-sm"
          />
          <p className="mt-1 text-right font-mono text-[11px] text-ink-faint">
            {removeMessage.length}/80
          </p>
          <div className="mt-5 flex justify-end gap-2.5">
            <button className={buttonQuiet} onClick={() => setConfirmRemove(null)}>
              Keep them
            </button>
            <button
              className={buttonDanger}
              onClick={async () => {
                const target = confirmRemove;
                const message = removeMessage.trim();
                setConfirmRemove(null);
                setRemoveMessage("");
                if (
                  await run(() =>
                    api(
                      "POST",
                      `/api/sessions/${env.id}/participants/${target.userId}/remove`,
                      { message },
                    ),
                  )
                ) {
                  say(`${safeDisplayName(target.name)} is out of the room`);
                }
              }}
            >
              Remove from room
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

/**
 * Where a removed person lands. Deliberately not the space-level "no access"
 * banner: they are still a member of the space, and telling them otherwise
 * over one round of planning poker would be both wrong and alarming. Playful
 * on purpose — being asked to step out of a meeting is not a security event.
 */
function ShownTheDoor({
  message,
  env,
  guest,
}: {
  message: string;
  env: Envelope;
  guest: boolean;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-8 py-16 text-center">
      <span aria-hidden className="text-[4rem] leading-none">
        🥾
      </span>
      <h2 className="font-display text-[1.75rem]">You've been shown the door</h2>
      <p role="status" className="max-w-[420px] text-sm text-ink-soft text-pretty">
        The facilitator took your seat at {env.title}. You're still in the space — ask
        them for a nudge when the table has room again.
      </p>
      {message && (
        // Somebody else's words, so they are quoted rather than spoken in the
        // product's voice.
        <blockquote className="max-w-[420px] rounded-panel border border-line bg-surface px-5 py-3 text-sm italic text-ink-soft shadow-rest">
          “{message}”
        </blockquote>
      )}
      {!guest && (
        <Link to={spacePath(env.orgSlug, env.spaceSlug)} className={buttonPrimary}>
          Back to the space
        </Link>
      )}
    </div>
  );
}
