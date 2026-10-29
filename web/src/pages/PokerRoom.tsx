import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { action, api, ApiError, errorText, type Envelope, type Person, type Story } from "../lib/api";
import { cueFor, useCueAccumulator, useRoundEpoch } from "../lib/cue";
import type { RoomProps } from "../lib/kinds";
import { voteTally, isPlanningStory, sessionTally } from "../lib/derive";
import { useToast } from "../lib/ui";
import { focusNeutral, swallowHeldActivation } from "../lib/neutralFocus";
import {
  FacilitatorClaim,
  FacilitatorHandoff,
  useFacilitatorAnnouncement,
} from "../components/FacilitatorControls";
import { Hand, HandStrip } from "../components/Hand";
import { ErrorRow, Modal, buttonDanger, buttonGo, buttonPrimary, buttonQuiet, inputClass, type Fail } from "../components/Modal";
import { ResultsPanel, heroOf } from "../components/ResultsPanel";
import { PluginPanels } from "../components/PluginPanels";
import { PluginChrome } from "../components/PluginChrome";
import { getBearer } from "../lib/api";
import { SplitStrip, StoryTree } from "../components/StoryTree";
import { DependencyChips } from "../components/StoryDependencies";
import { StoryQueue } from "../components/StoryQueue";
import { Table, faceOf } from "../components/Table";
import { EndedBanner, useJustEnded } from "../components/EndedBanner";
import { spacePath } from "../lib/paths";
import { safeDisplayName } from "../lib/displayName";
import {
  TRAY_CLEARANCE_PX,
  TRAY_SETTLE_MS,
  bringRoundIntoView,
  primaryRoundControl,
  scrollRoundBy,
  trayFreeArea,
  useClearOfTray,
  useFanReflow,
  useMotionHold,
} from "../lib/fanMotion";
import { revealSettledAt } from "../lib/motion";
import {
  blockerLinks,
  canBeSplit,
  canRefreshTotal,
  hasCurrentEstimate,
  isParentEstimateDue,
  nextStoryToEstimate,
  parentDeclineRequest,
  parentTotalRequest,
  plainErrorText,
  provenanceText,
  storyName,
  storyTotal,
  draftStoriesText,
  estimateRequest,
  focusedParentId,
  hasParkedDrafts,
  parkedDraftsOf,
  splitFanOf,
  splitParents,
  undoneSentence,
} from "../lib/splitFan";
import { useRefreshedEnvelope } from "../lib/useRefreshedEnvelope";

const CELEBRATION_ALLOWANCE_MS = 2400;
const FOCUS_HANDOFF_MS = 2000;
const RESULTS_HEAD_PX = 160;
const FINISH_TYPING = "Add or clear what you typed first";
const FINISH_RENAMING = "Save or cancel the rename first";

function readSplitShown(storageKey: string): boolean {
  try {
    return window.sessionStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

export function PokerRoom({ env: liveEnv, me, status = "live", guest = false, kickReason = "", kicked = null }: RoomProps) {
  const toast = useToast();
  const lastSaid = useRef("");
  const isQuestionOpen = useRef(false);
  const [questionAnnouncement, setQuestionAnnouncement] = useState("");
  const say = useCallback(
    (message: string) => {
      lastSaid.current = message;
      if (isQuestionOpen.current && message) setQuestionAnnouncement(message);
      else toast(message);
    },
    [toast],
  );
  const [isTreeAccessRevoked, setTreeAccessRevoked] = useState(false);
  const revokeReading = useCallback(() => setTreeAccessRevoked(true), []);
  const [draftingParentId, setDraftingParentId] = useState<string | null>(null);
  const [peekedParentId, setPeekedParentId] = useState<string | null>(null);
  const [hasRetainedDraft, setRetainedDraft] = useState(false);
  const [isRenameHeld, setRenameHeld] = useState(false);
  const isAnswerInFlight = useRef(false);
  const [isAnswerPending, setAnswerPending] = useState(false);
  const lastFocused = useRef<Element | null>(null);
  const leaveChoice = useRef<HTMLButtonElement>(null);
  const questionSection = useRef<HTMLElement>(null);
  const tableHeading = useRef<HTMLHeadingElement>(null);
  const wasLive = useRef(status === "live");
  const [undoneParentId, setUndoneParentId] = useState<string | null>(null);
  const [continuingParentId, setContinuingParentId] = useState<string | null>(null);
  const [reopenedQuestionParentId, setReopenedQuestionParentId] = useState<string | null>(null);
  const [lastTableStoryId, setLastTableStoryId] = useState<string | null>(liveEnv.state.currentStoryId ?? null);
  const [undoSlot, setUndoSlot] = useState<HTMLElement | null>(null);
  const room = useRefreshedEnvelope(
    liveEnv,
    status,
    draftingParentId !== null || splitParents(liveEnv.state).length > 0,
    revokeReading,
  );
  const env = room.env;
  const st = env.state;
  const planningStories = st.stories.filter(isPlanningStory);
  const isFacilitator = !guest && env.facilitatorId === me.id;
  const current: Story | undefined = st.stories.find((s) => s.id === st.currentStoryId);
  const currentParent = st.stories.find(s => s.id === current?.parentId);
  const self = env.participants.find((p) => p.userId === me.id);
  const ended = env.endedAt !== null;
  const justEnded = useJustEnded(env.endedAt);

  const [selected, setSelected] = useState<string | null>(null);
  // Tagged with where it happened: an error belongs beside the control that
  // raised it, not in one shared line in the middle of the page.
  const [fail, setFail] = useState<(Fail & { where: "room" | "queue" }) | null>(null);
  useEffect(() => {
    if (status === "live" && !wasLive.current) setFail(null);
    wasLive.current = status === "live";
  }, [status]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dealReview, setDealReview] = useState<{story: Story; round: number | undefined; currentId: string | null} | null>(null);
  const [estimateEditor, setEstimateEditor] = useState<Story | null>(null);
  const [estimateCard, setEstimateCard] = useState("");
  const [scopeEditor, setScopeEditor] = useState<{story: Story; round: number | undefined} | null>(null);
  const [scopeTitle, setScopeTitle] = useState("");
  const [scopeNotes, setScopeNotes] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Who is about to be shown the door, and what to say on the way out.
  const [confirmRemove, setConfirmRemove] = useState<Person | null>(null);
  const [removeMessage, setRemoveMessage] = useState("");
  const reviewParent = st.stories.find(s => s.id === dealReview?.story.parentId);

  const online = new Set(env.presence);
  const seated: Person[] = env.participants.filter((p) => !p.spectator);
  // Both halves follow one rule now: the server's roster is already only the
  // people who have been in this room, so neither is filtered by presence.
  const spectators: Person[] = env.participants.filter((p) => p.spectator);
  const votes = new Map((current?.votes ?? []).map((v) => [v.userId, v.value]));
  const results = env.revealed ? current?.results : undefined;
  const acceptedThisRound = Boolean(current?.estimate && !current.estimateNeedsReview && (current.acceptedRoundVersion === st.roundVersion || (!current.parentId && !current.splitRevision && current.acceptedRoundVersion == null)));
  // The card you played, as the room has it. `selected` cannot answer this:
  // it is optimistic state the reveal clears, and it is gone after a reload.
  // The envelope's votes survive both, and a reset empties them.
  const myVote = votes.get(me.id) ?? null;
  const handHadFocus = useRef(false);
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

  const isShowableSplit = (parentId: string | null) =>
    Boolean(parentId) &&
    st.stories.some((story) => story.id === parentId && !story.parentId && !story.removedAt) &&
    (parentId === draftingParentId || st.stories.some((child) => child.parentId === parentId));
  const isSetAside = (parentId: string | null) => hasParkedDrafts(st.stories.find((story) => story.id === parentId));
  const canPin = (parentId: string | null) =>
    isShowableSplit(parentId) && (!isSetAside(parentId) || hasRetainedDraft || parentId === continuingParentId);
  const pinnedParentId = [draftingParentId, peekedParentId].find(canPin) ?? null;
  const focusedFan = splitFanOf(st, focusedParentId(st, pinnedParentId));
  const fan = focusedFan && focusedFan.parent.id !== undoneParentId ? focusedFan : null;
  const parkedDraftCount = fan ? 0 : parkedDraftsOf(st, current).length;
  const canWriteSplit = isFacilitator && !ended && status === "live" && !room.isRefreshing;
  const canSplitCurrent = canWriteSplit && !fan && canBeSplit(current);
  const isDraftingOnTable = Boolean(fan && !fan.isAdopted && current?.id === fan.parent.id && !hasParkedDrafts(fan.parent));
  const isCurrentInFan = Boolean(fan && current && (current.id === fan.parent.id || current.parentId === fan.parent.id));
  const currentFamily = current?.parentId ? splitFanOf(st, current.parentId) : null;
  const currentOrdinal = currentFamily && current ? currentFamily.planning.indexOf(current) : -1;
  const currentFamilyId = current ? (current.parentId ?? current.id) : null;

  const isDraftHeld = useRef(hasRetainedDraft);
  useEffect(() => {
    isDraftHeld.current = hasRetainedDraft;
  }, [hasRetainedDraft]);
  const shownParentId = fan?.parent.id ?? null;
  useEffect(() => {
    if (!hasRetainedDraft || !shownParentId) return;
    queueMicrotask(() => setPeekedParentId(shownParentId));
  }, [hasRetainedDraft, shownParentId]);
  useEffect(() => {
    if (!currentFamilyId) return;
    queueMicrotask(() => {
      if (isDraftHeld.current) return;
      setPeekedParentId((parentId) => (parentId === currentFamilyId ? parentId : null));
      setDraftingParentId((parentId) => (parentId === currentFamilyId ? parentId : null));
    });
  }, [currentFamilyId]);

  const seenDraftCounts = useRef(new Map<string, number>());
  useEffect(() => {
    const pinnedIds = new Set([draftingParentId, peekedParentId].filter((id): id is string => id !== null));
    for (const parentId of [...seenDraftCounts.current.keys()]) if (!pinnedIds.has(parentId)) seenDraftCounts.current.delete(parentId);
    for (const parentId of pinnedIds) {
      const draftCount = st.stories.filter(
        (story) => story.parentId === parentId && !story.removedAt && story.planningRole === "proposed",
      ).length;
      if (draftCount > 0) {
        seenDraftCounts.current.set(parentId, draftCount);
        continue;
      }
      const hasNoDraftLeft = (seenDraftCounts.current.get(parentId) ?? 0) > 0;
      if (!hasNoDraftLeft || hasRetainedDraft) continue;
      seenDraftCounts.current.delete(parentId);
      const isCommitted = st.stories.some((story) => story.id === parentId && story.planningRole === "context");
      queueMicrotask(() => {
        setDraftingParentId((pinned) => (pinned === parentId ? null : pinned));
        if (!isCommitted) setPeekedParentId((pinned) => (pinned === parentId ? null : pinned));
      });
    }
  });

  const isUndoneParentSetAside = isSetAside(undoneParentId);
  useEffect(() => {
    if (!isUndoneParentSetAside) return;
    queueMicrotask(() => setUndoneParentId(null));
  }, [isUndoneParentSetAside]);

  const isContinuingParentShown = continuingParentId !== null && !isSetAside(continuingParentId);
  useEffect(() => {
    if (!isContinuingParentShown) return;
    queueMicrotask(() => setContinuingParentId(null));
  }, [isContinuingParentShown]);

  const latestState = useRef(st);
  const committedParentIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    latestState.current = st;
    const committed = new Set(
      st.stories.filter((story) => !story.parentId && story.planningRole === "context").map((story) => story.id),
    );
    const before = committedParentIds.current;
    committedParentIds.current = committed;
    if (!before || status !== "live") return;
    for (const parentId of before) {
      const parent = st.stories.find((story) => story.id === parentId);
      if (committed.has(parentId) || !parent || parent.removedAt) continue;
      const draftCount = st.stories.filter(
        (story) => story.parentId === parentId && !story.removedAt && story.planningRole === "proposed",
      ).length;
      say(undoneSentence(parent, draftCount));
    }
  });

  const undoneFocus = useRef<string | null>(null);
  useEffect(() => {
    const parentId = undoneFocus.current;
    if (!parentId || shownParentId === parentId) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-queue-story]")].find(
      (candidate) => candidate.dataset.queueStory === parentId,
    );
    if (st.currentStoryId === parentId) {
      if (focusNeutral([nowOnTable.current, tableHeading.current])) undoneFocus.current = null;
      return;
    }
    const ticketDeal = row?.querySelector<HTMLElement>("[data-queue-deal]");
    if (ticketDeal) {
      undoneFocus.current = null;
      ticketDeal.focus({ preventScroll: true });
      return;
    }
    if (row && focusNeutral(neutralLandings(false))) undoneFocus.current = null;
  });

  const focusOwed = useRef(false);
  const nowOnTable = useRef<HTMLElement>(null);
  const splitEntry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusOwed.current || draftingParentId !== null) return;
    if (focusNeutral([nowOnTable.current, splitEntry.current, ...neutralLandings(false)])) focusOwed.current = false;
  });

  const tableStoryId = st.currentStoryId;
  useEffect(() => {
    if (!tableStoryId) return;
    const timer = window.setTimeout(() => {
      const region = nowOnTable.current;
      bringRoundIntoView(region ? (document.querySelector("[data-fan-strip]") ?? region) : tableHeading.current, region);
    }, TRAY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [tableStoryId, shownParentId]);

  const resultsArea = useRef<HTMLDivElement>(null);
  const isRevealed = env.revealed;
  useEffect(() => {
    if (!isRevealed || !tableStoryId) return;
    const timer = window.setTimeout(() => {
      const shown = resultsArea.current;
      if (!shown) return;
      const box = shown.getBoundingClientRect();
      const free = trayFreeArea();
      const hidden = Math.max(0, box.bottom - free.bottom);
      // The hand collapses to a strip on reveal, so nothing covers the result;
      // once its headline (label, numeral, spread) is on screen, leave the page be.
      if (hidden <= 0 || box.top + RESULTS_HEAD_PX <= free.bottom) return;
      scrollRoundBy(hidden + TRAY_CLEARANCE_PX, [primaryRoundControl() ? null : (tableHeading.current ?? nowOnTable.current)]);
    }, TRAY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isRevealed, tableStoryId]);

  const isMotionHeld = useMotionHold(
    Boolean(env.revealed && results?.consensus),
    revealSettledAt(seated.length) + CELEBRATION_ALLOWANCE_MS,
  );
  const stage = useRef<HTMLDivElement>(null);
  const reflowFan = useFanReflow(stage, isMotionHeld);

  async function run(
    fn: () => Promise<unknown>,
    opts: { where?: "room" | "queue"; retry?: boolean; refreshOnConflict?: boolean } = {},
  ) {
    try {
      setFail(null);
      await fn();
      return true;
    } catch (e) {
      if (opts.refreshOnConflict && e instanceof ApiError && e.status === 409) void room.refresh().catch(() => undefined);
      setFail({
        where: opts.where ?? "room",
        msg: plainErrorText(e),
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
    if (!(await run(() => action(env.id, "vote", { storyId: current.id, value, expectedRoundVersion: st.roundVersion })))) {
      setSelected(prev);
    }
  }

  // Next skips the current story without inferring completion.
  const unfinished = planningStories.filter((s) => !s.estimate || s.estimateNeedsReview);
  const endTally = sessionTally(st.stories);
  const estimated = endTally.estimated;
  if (st.currentStoryId && st.currentStoryId !== lastTableStoryId) setLastTableStoryId(st.currentStoryId);
  const lastTableStory = st.stories.find((s) => s.id === lastTableStoryId);
  const lastTableFan = lastTableStory ? splitFanOf(st, lastTableStory.parentId ?? lastTableStory.id) : null;
  const estimatingFan = current
    ? splitFanOf(st, current.parentId ?? (current.planningRole === "context" ? current.id : null))
    : lastTableFan?.isAdopted
      ? lastTableFan
      : fan;
  const committedFan = estimatingFan?.isAdopted ? estimatingFan : null;
  const nextInSplit = committedFan
    ? (nextStoryToEstimate(committedFan, current?.id ?? lastTableStoryId) ??
      (current ? undefined : nextStoryToEstimate(committedFan, null)))
    : undefined;
  const isRevealedWithNothingToSave = Boolean(env.revealed && current && results && !hero?.save && hasCurrentEstimate(current));
  const isRoundClosed =
    !current || (env.revealed && (acceptedThisRound || isRevealedWithNothingToSave) && current.parentId === committedFan?.parent.id);
  const isParentQuestionDue = Boolean(committedFan && isParentEstimateDue(committedFan));
  const canAnswerForParent = isFacilitator && !ended;
  const reopenedFan = reopenedQuestionParentId ? splitFanOf(st, reopenedQuestionParentId) : null;
  const isReopenedQuestionCurrent = Boolean(
    reopenedFan?.isAdopted &&
      current?.id !== reopenedFan.parent.id &&
      !hasCurrentEstimate(reopenedFan.parent) &&
      reopenedFan.planning.length > 0 &&
      reopenedFan.planning.every(hasCurrentEstimate),
  );
  useEffect(() => {
    if (reopenedQuestionParentId && !isReopenedQuestionCurrent) queueMicrotask(() => setReopenedQuestionParentId(null));
  }, [reopenedQuestionParentId, isReopenedQuestionCurrent]);
  const questionFan =
    canAnswerForParent
      ? isReopenedQuestionCurrent
        ? reopenedFan
        : isParentQuestionDue && isRoundClosed
          ? committedFan
          : null
      : null;
  const nextStory = nextInSplit ?? (isParentQuestionDue ? undefined : unfinished.find((s) => s.id !== current?.id));
  const questionTotal = questionFan ? storyTotal(questionFan, st.deck) : null;
  const isQuestionShown = Boolean(questionFan);
  const splitShownKey = fan ? `parley:split-shown:${env.id}:${fan.parent.id}` : "";
  const [shownSplits, setShownSplits] = useState<Record<string, boolean>>({});
  const canCollapseSplit = Boolean(
    fan &&
      fan.isAdopted &&
      fan.drafted.length === 0 &&
      draftingParentId !== fan.parent.id &&
      !ended &&
      current?.parentId === fan.parent.id &&
      !isQuestionShown,
  );
  const isSplitShown = splitShownKey !== "" && (shownSplits[splitShownKey] ?? readSplitShown(splitShownKey));
  const isSplitCollapsed = canCollapseSplit && !isSplitShown && !hasRetainedDraft;
  function showSplit(isShown: boolean) {
    if (!splitShownKey) return;
    if (!isShown && hasRetainedDraft) {
      say(isRenameHeld ? FINISH_RENAMING : FINISH_TYPING);
      return;
    }
    setShownSplits((shown) => ({ ...shown, [splitShownKey]: isShown }));
    try {
      if (isShown) window.sessionStorage.setItem(splitShownKey, "1");
      else window.sessionStorage.removeItem(splitShownKey);
    } catch {
      return;
    }
  }
  const splitToggle = useRef<HTMLButtonElement>(null);
  const wasQuestionShown = useRef(false);
  function neutralLandings(isSplitFirst: boolean): (HTMLElement | null)[] {
    const splitSection = document.querySelector<HTMLElement>("section[id^='story-tree-']");
    return [
      isSplitFirst ? splitSection : null,
      nowOnTable.current,
      document.querySelector<HTMLElement>("[data-fan-item='now']"),
      tableHeading.current,
      splitSection,
      document.querySelector<HTMLElement>("[data-queue-heading]"),
    ];
  }
  useEffect(() => {
    const hasLostFocus = !document.activeElement || document.activeElement === document.body;
    const hasQuestionClosed = wasQuestionShown.current && !isQuestionShown;
    if (hasQuestionClosed && hasLostFocus) focusNeutral(neutralLandings(false));
    wasQuestionShown.current = isQuestionShown;
    if (!hasQuestionClosed) return;
    const timer = window.setTimeout(() => {
      const region = document.querySelector<HTMLElement>("[data-fan-item='now']");
      bringRoundIntoView(region ?? tableHeading.current, region);
    }, TRAY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isQuestionShown]);
  const questionParentLabel = questionFan ? questionFan.parent.ref || storyName(questionFan.parent) : "";
  const questionText = questionFan
    ? `All ${questionFan.planning.length} stories are estimated. What about ${questionParentLabel}?`
    : "";
  const questionKey = questionFan && !reopenedQuestionParentId ? `${questionFan.parent.id}:${questionFan.parent.splitRevision ?? 0}` : "";
  useEffect(() => {
    queueMicrotask(() => setQuestionAnnouncement(questionKey ? questionText : ""));
  }, [questionKey, questionText]);
  useEffect(() => {
    isQuestionOpen.current = isQuestionShown;
    if (isQuestionShown) toast("");
  }, [isQuestionShown, toast]);
  const shownQuestionParentId = questionFan?.parent.id ?? "";
  useEffect(() => {
    if (!shownQuestionParentId) return;
    const focused = document.activeElement;
    const isTyping =
      focused instanceof HTMLElement &&
      (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable);
    if (isTyping || isDraftHeld.current) return;
    const wasAskedByFacilitator = reopenedQuestionParentId === shownQuestionParentId;
    (wasAskedByFacilitator ? leaveChoice.current : questionSection.current)?.focus({ preventScroll: true });
  }, [shownQuestionParentId, reopenedQuestionParentId]);
  useClearOfTray(isQuestionShown, questionSection);
  useEffect(() => {
    const lost = lastFocused.current;
    if (!lost || lost.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (document.querySelector("dialog[open]")) return;
    const wasInSplit = Boolean(lost.closest("section[id^='story-tree-']"));
    const landing = focusNeutral(neutralLandings(wasInSplit));
    if (!landing) return;
    lastFocused.current = landing;
  });

  useFacilitatorAnnouncement(env, me.id);

  // Removed from THIS room, which is not the same as losing the space — the
  // socket said so with its own close code, and this is its own screen. It
  // replaces the room outright: everything below it belongs to a table this
  // person is no longer at.
  if (status === "removed" || isTreeAccessRevoked) return <p role="alert" className="p-6 text-sm">Your access to this room was removed.</p>;

  if (status === "kicked") return <ShownTheDoor message={kickReason} env={env} guest={guest} />;

  const storyOnTable = current ? (
    <div className="min-w-0 flex-1 basis-[240px]">
      <div className="flex items-center gap-2">
        <span
          className={"font-mono text-[11px] text-ink-faint" + (current.ref || currentOrdinal >= 0 ? "" : " italic")}
        >
          {currentOrdinal >= 0 && currentFamily
            ? `${currentOrdinal + 1} of ${currentFamily.planning.length}${current.ref ? ` · ${current.ref}` : ""}`
            : current.ref || "ad hoc · no ticket"}
        </span>
        {!ended && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent">
            current
          </span>
        )}
      </div>
      <h2 ref={tableHeading} tabIndex={-1} className="mt-0.5 line-clamp-2 text-lg font-bold tracking-tight wrap-anywhere">
        {current.title || current.ref || "ad hoc round"}
      </h2>
      {current.parentId && !isCurrentInFan && <p className="mt-1 text-sm text-ink-soft">Child of {currentParent?.title || currentParent?.ref || "parent story"}</p>}
      {current.estimateNeedsReview ? <p className="mt-1 text-sm text-ink-soft">Needs review · previous estimate {current.estimate}</p> : current.estimate && <p className="mt-1 text-sm text-ink-soft">Accepted {faceOf(current.estimate)} · {provenanceText(current.estimateProvenance)}</p>}
      {env.revealed && !acceptedThisRound && <p className="mt-1 text-sm text-ink-soft">Votes revealed · estimate not accepted</p>}
      {current.notes && (
        <p className="mt-0.5 text-xs text-ink-faint">{current.notes}</p>
      )}
      {fan && isCurrentInFan && (
        <div className="mt-2">
          <DependencyChips links={blockerLinks(fan, current.id)} />
        </div>
      )}
      {parkedDraftCount > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-soft">
          <span>{draftStoriesText(parkedDraftCount)}</span>
          {canSplitCurrent && (
            <>
              <span aria-hidden="true">·</span>
              <button
                ref={splitEntry}
                type="button"
                className="inline-flex min-h-[44px] items-center rounded-chip font-semibold text-accent hover:underline"
                onClick={() => void setDraftsParked(current.id, false)}
              >
                Continue splitting
              </button>
            </>
          )}
        </p>
      )}
      {canSplitCurrent && parkedDraftCount === 0 && (
        <button
          ref={splitEntry}
          type="button"
          data-neutral-control=""
          className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-chip text-[13px] font-semibold text-accent hover:underline"
          onClick={() => setDraftingParentId(current.id)}
        >
          Too big? Split it
        </button>
      )}
    </div>
  ) : ended ? null : (
    <p className="flex-1 text-[15px] font-semibold text-ink-faint">No story on the table</p>
  );

  const lesserControl = fan
    ? "inline-flex min-h-[44px] items-center rounded-chip px-2 text-[13px] font-semibold text-ink-soft hover:text-accent disabled:opacity-50"
    : buttonQuiet;
  const nextStoryButton = nextStory && (
    <button
      key="next-story"
      className={buttonPrimary + " max-w-full text-left wrap-anywhere"}
      aria-disabled={isAnswerPending || undefined}
      onClick={() => requestDeal(nextStory)}
    >
      Next story: {storyName(nextStory)}
    </button>
  );
  const roundVerdict = isFacilitator && !ended && (
    <>
      {!env.revealed ? (
        <button
          key="reveal"
          className={buttonPrimary}
          aria-label={current?.parentId ? `Reveal votes for ${current.title || current.ref}` : undefined}
          disabled={!current || (current.votedUserIds.length === 0)}
          aria-disabled={isAnswerPending || undefined}
          onClick={() => void answerOnce(() => run(() => action(env.id, "reveal", {storyId: current?.id, expectedRoundVersion: st.roundVersion}), { retry: true }))}
        >
          Reveal
        </button>
      ) : (
        (acceptedThisRound && current?.estimate ? (
          // The round is written down. The button used to stay put and
          // still say "Save", so the only evidence of the save expired
          // with the toast and a second click looked like the first.
          <>
            <span className="max-w-full rounded-full border border-settled px-4 py-2 font-mono text-sm font-bold text-settled wrap-anywhere">
              Saved {faceOf(current.estimate)} to {current.ref || (current.parentId ? current.title : "") || "the ad-hoc round"}
            </span>
            {nextStoryButton}
          </>
        ) : (
          // Nothing to offer when the room only played "?" or coffee:
          // there is no estimate in that round to write down.
          <>
          {results && hero && (hero.save ? (
            <button
              key="save"
              className={buttonGo}
              aria-label={current?.parentId ? `Save Poker estimate ${hero.value} to ${current.title || current.ref}` : undefined}
              aria-disabled={isAnswerPending || undefined}
              onClick={() => {
                const value = hero.save!;
                void answerOnce(async () => {
                  if (await run(() => action(env.id, "story", { storyId: current!.id, estimate: value, expectedRevision: current!.contentRevision, acceptanceMode: "poker", expectedScopeRevision: current!.scopeRevision ?? 0, expectedRoundVersion: st.roundVersion }))) {
                    say(`Estimate ${value} saved to ${current!.ref || (current!.parentId ? current!.title : "") || "the ad-hoc round"}`);
                  }
                });
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
          ))}
          {current && !hero?.save && (nextStoryButton || (
            <button key="vote-again" className={buttonPrimary} onClick={() => setConfirmReset(true)}>
              Vote again
            </button>
          ))}
          </>
        ))
      )}
    </>
  );

  const roundAdjustments = isFacilitator && !ended && (
    <>
      {current?.parentId && <>
        <button className={lesserControl + " min-h-[44px]"} onClick={() => {setEstimateCard(""); setEstimateEditor(current);}}>Set estimate</button>
        <button className={lesserControl + " min-h-[44px]"} onClick={() => {setScopeTitle(current.title);setScopeNotes(current.notes);setScopeEditor({story:current,round:st.roundVersion});}}>Change scope</button>
      </>}
      <button className={lesserControl} aria-disabled={isAnswerPending || undefined} onClick={() => (env.revealed ? setConfirmReset(true) : reset())}>
        Reset
      </button>
    </>
  );

  const roundSettings = isFacilitator && !ended && (
    <>
      <button
        className={lesserControl}
        aria-pressed={st.autoReveal}
        onClick={() =>
          run(() => action(env.id, "config", { autoReveal: !st.autoReveal }), { retry: true })
        }
      >
        {st.autoReveal ? "Auto-reveal on" : "Auto-reveal off"}
      </button>
      <button
        className={lesserControl}
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
  );

  const leaveUnestimated = isFacilitator && !ended && current && current.estimate == null && (
    <button
      className={lesserControl + " min-h-[44px] min-w-0 max-w-full break-words"}
      disabled={status !== "live"}
      onClick={async () => { if (status !== "live") return; if (await run(() => action(env.id, "select", {storyId:current.id,leaveUnestimated:true,expectedCurrentStoryId:current.id,expectedRoundVersion:st.roundVersion}))) say("Left unestimated — still in the queue"); }}
    >Leave unestimated</button>
  );

  const isPeeking = Boolean(fan && current && !isCurrentInFan);
  const canParkDrafts = canWriteSplit && isDraftingOnTable && Boolean(fan?.drafted.length);
  const canGoBackToTable = isPeeking || canParkDrafts;
  const stripActions = fan && (
    <>
      {canCollapseSplit && (
        <button
          type="button"
          className={buttonQuiet + " min-h-[44px]"}
          aria-expanded={!isSplitCollapsed}
          aria-controls={`story-tree-${fan.parent.id}`}
          ref={splitToggle}
          data-neutral-control=""
          onClick={() => showSplit(isSplitCollapsed)}
        >
          {isSplitCollapsed ? "Show the split" : "Hide the split"}
        </button>
      )}
      <span ref={setUndoSlot} className="contents" />
      {canWriteSplit && fan.isAdopted && fan.drafted.length === 0 && draftingParentId !== fan.parent.id && (
        <button type="button" className={buttonQuiet + " min-h-[44px]"} onClick={() => setDraftingParentId(fan.parent.id)}>
          Add stories
        </button>
      )}
      {canGoBackToTable && (
        <button type="button" className={buttonQuiet + " min-h-[44px]"} onClick={goBackToTable}>
          Back to the table
        </button>
      )}
      {canWriteSplit && fan.isAdopted && current?.id !== fan.parent.id && canRefreshTotal(fan, st.deck) && (
        <button
          type="button"
          className={buttonQuiet + " min-h-[44px]"}
          aria-disabled={isAnswerPending || undefined}
          onClick={() => void recordTotalFor(fan)}
        >
          Refresh the total: {storyTotal(fan, st.deck)}
        </button>
      )}
      {canWriteSplit &&
        fan.isAdopted &&
        questionFan?.parent.id !== fan.parent.id &&
        current?.id !== fan.parent.id &&
        fan.planning.length > 0 &&
        fan.planning.every(hasCurrentEstimate) &&
        !hasCurrentEstimate(fan.parent) && (
          <button
            type="button"
            data-parent-estimate-control
            className={buttonQuiet + " min-h-[44px]"}
            onClick={() => setReopenedQuestionParentId(fan.parent.id)}
          >
            Estimate {fan.parent.ref || storyName(fan.parent)}
          </button>
        )}
    </>
  );

  const parentQuestion = questionFan && (
    <section
      ref={questionSection}
      role="group"
      aria-labelledby="parent-estimate-question"
      tabIndex={-1}
      data-fan-item="question"
      className="fan-now"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        void leaveParentUnestimated(questionFan);
      }}
    >
      <span className="fan-plate" data-fan-plate aria-hidden="true" />
      <div className="grid gap-2 px-5 py-4">
        <p id="parent-estimate-question" className="text-[15px] font-bold">
          {questionText}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {questionTotal !== null && (
            <button
              type="button"
              className={buttonQuiet + " min-h-[44px]"}
              aria-disabled={isAnswerPending || undefined}
              onClick={() => void recordTotalFor(questionFan)}
            >
              Use the total: {questionTotal}
            </button>
          )}
          <button
            type="button"
            className={buttonQuiet + " min-h-[44px]"}
            aria-disabled={isAnswerPending || undefined}
            onClick={() => {
              if (isAnswerInFlight.current) return;
              setReopenedQuestionParentId(null);
              requestDeal(questionFan.parent);
            }}
          >
            Estimate {questionParentLabel} with the team
          </button>
          <button
            ref={leaveChoice}
            type="button"
            className={buttonQuiet + " min-h-[44px]"}
            aria-disabled={isAnswerPending || undefined}
            onClick={() => void leaveParentUnestimated(questionFan)}
          >
            Leave it without an estimate
          </button>
        </div>
      </div>
    </section>
  );

  const isTableTucked = isDraftingOnTable;
  const isEmptyTableShown = !current && !ended && !fan;
  const isTableAreaShown = Boolean((current && !ended) || isEmptyTableShown || (results && !ended));

  return (
    // pb-36 (pb-24 once the hand is a strip) is on the page, not the left column: the story queue is a sibling
    // of that column and stacks below it on a phone, so with the reserve on
    // the column alone, tabbing into the queue put focus under the fixed hand
    // tray (WCAG 2.2 AA 2.4.11).
    <div
      className={`flex flex-col gap-6 ${env.revealed ? "pb-24" : "pb-36"} lg:pb-0 lg:flex-row lg:flex-wrap lg:items-start p-5 pl-[max(1.25rem,var(--safe-left))] pr-[max(1.25rem,var(--safe-right))] sm:p-7 sm:pl-[max(1.75rem,var(--safe-left))] sm:pr-[max(1.75rem,var(--safe-right))]`}
      onFocusCapture={(event) => {
        lastFocused.current = event.target;
      }}
      onKeyDownCapture={swallowHeldActivation}
    >
      <div ref={stage} data-fan-scope className="relative flex min-w-0 w-full flex-1 flex-col gap-5 lg:basis-[560px]">
        <header
          data-fan-item="strip"
          data-fan-strip={fan ? "slim" : "ticket"}
          className={"fan-strip flex flex-wrap items-center gap-x-4 px-5 " + (fan ? "gap-y-1 py-2" : "gap-y-4 py-4")}
        >
          <span className="fan-plate" data-fan-plate data-fan-origin aria-hidden="true" />
          {fan ? <SplitStrip fan={fan} /> : storyOnTable}

          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            {stripActions}
            {!fan && roundVerdict && (
              <span className="contents" data-round-verdict>
                {roundVerdict}
              </span>
            )}
            {!fan && roundAdjustments}
            {!fan && roundSettings}

            {/* Session-level actions, held off the round-action cluster by a
                hairline: End session used to sit a cursor-width from Export CSV
                at the same size and weight. */}
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2 border-l border-line pl-3">
              {!ended && (
              <a
                href={`/session/${env.id}/present`}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center px-2 py-2 text-[13px] font-semibold text-ink-faint hover:text-accent"
              >
                Present
              </a>
              )}
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
              <PluginChrome slot="export-menu" env={env} />
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
                {!fan && leaveUnestimated}
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

        {fan && (
          <StoryTree
            key={fan.parent.id}
            env={env}
            parentId={fan.parent.id}
            canEdit={canWriteSplit}
            status={status}
            isComposerRequested={draftingParentId === fan.parent.id}
            isMotionHeld={isMotionHeld}
            canPublish={isFacilitator && !getBearer()}
            refresh={room.refresh}
            refreshError={room.refreshError}
            onRetryRefresh={room.retryRefresh}
            onReflow={reflowFan}
            onDeal={requestDeal}
            estimateCards={st.deck.values.filter(card => card !== "?" && card !== "coffee")}
            onSetEstimate={async (story, estimate) => {
              try {
                await action(env.id, "story", estimateRequest(story, estimate, st, env.revealed));
                say("Facilitator-set estimate accepted");
                return "";
              } catch (problem) {
                if (problem instanceof ApiError && problem.status === 409) void room.refresh().catch(() => undefined);
                return errorText(problem);
              }
            }}
            onComposerClose={() => {
              focusOwed.current = true;
              window.setTimeout(() => {
                focusOwed.current = false;
              }, FOCUS_HANDOFF_MS);
              setDraftingParentId(null);
              if (!fan.isAdopted) setPeekedParentId((pinned) => (pinned === fan.parent.id ? null : pinned));
            }}
            onRetainChange={(isRetained, isRenaming = false) => {
              setRetainedDraft(isRetained);
              setRenameHeld(isRenaming);
            }}
            onStoryAdded={() => {
              const parentId = fan.parent.id;
              if (!hasParkedDrafts(latestState.current.stories.find((story) => story.id === parentId))) return;
              setContinuingParentId(parentId);
              void setDraftsParked(parentId, false);
            }}
            onBackToTable={canGoBackToTable ? goBackToTable : undefined}
            undoSlot={undoSlot}
            isCollapsed={isSplitCollapsed}
            onExpand={() => {
              showSplit(true);
              window.setTimeout(() => focusNeutral([splitToggle.current]), 0);
            }}
            onUndoStart={() => setPeekedParentId(fan.parent.id)}
            onUndone={() => {
              setDraftingParentId(null);
              setPeekedParentId(null);
              setRetainedDraft(false);
              setUndoneParentId(fan.parent.id);
              undoneFocus.current = fan.parent.id;
              window.setTimeout(() => {
                undoneFocus.current = null;
              }, FOCUS_HANDOFF_MS);
            }}
          />
        )}

        {fail?.where === "room" && (
          <ErrorRow
            fail={fail}
            onDismiss={() => setFail(null)}
            onRetry={fail.retry && (() => run(fail.retry!, { retry: true }))}
          />
        )}

        {ended && (
          <EndedBanner
            env={env}
            guest={guest}
            isFacilitator={isFacilitator}
            announce={justEnded}
            onReopen={() => run(() => api("POST", `/api/sessions/${env.id}/reopen`))}
          >
            <p className="mt-3 text-[15px] font-semibold">
              {endTally.line}
            </p>
            {estimated.length > 0 && (
              <div className="mt-5 text-left">
                <h2 id="poker-estimated" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Estimated
                </h2>
                <ul aria-labelledby="poker-estimated" className="mt-2 flex flex-col gap-1">
                  {estimated.map((s) => (
                    <li key={s.id} className="flex justify-between gap-3 text-[13px] font-semibold">
                      <span className="min-w-0 wrap-anywhere">{s.title || s.ref || "ad hoc round"}</span>
                      <span className="font-mono">{faceOf(s.estimate!)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {unfinished.length > 0 ? (
              <div className="mt-5 text-left">
                <h2
                  id="poker-unfinished"
                  className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
                >
                  Not estimated
                </h2>
                <ul aria-labelledby="poker-unfinished" className="mt-2 flex flex-col gap-1">
                  {[...new Set(unfinished.map(s => s.parentId || s.id))].map(id => {
                    const parent = st.stories.find(s => s.id === id);
                    const children = unfinished.filter(s => s.parentId === id);
                    return <li key={id} className="text-[13px] font-semibold">
                      {children.length > 0 ? <>
                        <p>{parent?.title || parent?.ref || "Original ticket"} · Parent context</p>
                        <ul className="ml-4 mt-1 list-disc">
                          {children.map(s => <li key={s.id}>
                            <span>{s.title || s.ref} · {s.estimateNeedsReview ? `Needs review · previous ${s.estimate}` : "Unestimated"}</span>
                            {(st.dependencies ?? []).filter(d => d.dependentId === s.id && !d.retiredAt).map(d => <p key={d.id} className="font-normal text-ink-soft">Blocked by {st.stories.find(b => b.id === d.blockerId)?.title || "Unavailable sibling"} · {d.reviewState === "planning" ? "Planning dependency · Completion not checked" : "Needs review · blocker unavailable or changed"}</p>)}
                          </li>)}
                        </ul>
                      </> : parent?.title || parent?.ref || "ad hoc round"}
                    </li>;
                  })}
                </ul>
              </div>
            ) : (
              <p className="mt-5 text-[13px] text-ink-soft">Every story was estimated.</p>
            )}
          </EndedBanner>
        )}

        <FacilitatorClaim
          env={env}
          isFacilitator={isFacilitator}
          guest={guest}
          onClaim={() => run(() => api("POST", `/api/sessions/${env.id}/facilitator/claim`))}
        />

        {fan && current && !ended && !isDraftingOnTable && (
          <section ref={nowOnTable} tabIndex={-1} aria-label="On the table" data-fan-item="now" data-fan-enter="rise" className="fan-now">
            <span className="fan-plate" data-fan-plate aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-4 px-5 py-4">
              {storyOnTable}
              {roundVerdict && (
                <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2" data-round-verdict>
                  {roundVerdict}
                </div>
              )}
            </div>
            {roundAdjustments && (
              <div className="flex flex-wrap items-center gap-x-1 border-t border-line px-3 py-0.5">
                {roundAdjustments}
                {leaveUnestimated}
                <span className="ml-auto flex flex-wrap items-center gap-x-1">{roundSettings}</span>
              </div>
            )}
          </section>
        )}

        {parentQuestion}

        {fan && !current && !ended && !questionFan && nextStoryButton && isFacilitator && (
          <section tabIndex={-1} aria-label="On the table" data-fan-item="now" className="fan-now">
            <span className="fan-plate" data-fan-plate aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-4 px-5 py-4">
              <p className="flex-1 text-[15px] font-semibold text-ink-faint">No story on the table</p>
              <span className="contents" data-round-verdict>
                {nextStoryButton}
              </span>
            </div>
          </section>
        )}

        {isTableAreaShown && (
        <div className="fan-tuck flex flex-col gap-5" data-tucked={isTableTucked || undefined} inert={isTableTucked}>
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
        ) : isEmptyTableShown ? (
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

        {results && !ended && (
          <div ref={resultsArea} data-poker-results>
            <ResultsPanel results={results} deck={st.deck.values} />
          </div>
        )}
        </div>
        )}

        {current && !ended && (
          // Fixed on a phone so the hand stays thumb-reachable while the
          // story queue scrolls beneath the column; sticky inside lg where
          // the aside sits beside us and the document tail is short.
          <div onFocus={() => (handHadFocus.current = true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) handHadFocus.current = false; }} data-poker-hand data-tucked={isTableTucked || undefined} inert={isTableTucked} className="fixed inset-x-0 bottom-0 z-10 bg-felt pt-2 pb-[var(--safe-bottom)] pl-[max(0px,var(--safe-left))] pr-[max(0px,var(--safe-right))] lg:static lg:inset-x-auto lg:z-auto lg:bg-transparent lg:pb-0 lg:sticky lg:bottom-0 [@media(max-height:820px)]:lg:static">
            {env.revealed ? (
              <HandStrip played={myVote} spectating={self?.spectator ?? false} takeFocus={handHadFocus.current} />
            ) : (
            <Hand
              values={st.deck.values}
              deckName={st.deck.name}
              openVoting={st.openVoting}
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
            )}
          </div>
        )}
      </div>

      <StoryQueue
        sessionId={env.id}
        stories={planningStories}
        allStories={st.stories}
        currentStoryId={ended ? null : st.currentStoryId}
        shownSplitId={ended ? null : (fan?.parent.id ?? null)}
        onShowSplit={(parent) => {
          setUndoneParentId(null);
          setPeekedParentId(parent.id);
        }}
        onContinueSplit={(parent) => void setDraftsParked(parent.id, false)}
        isFacilitator={isFacilitator && !ended && status === "live"}
        onQuickRound={quickRound}
        onDeal={requestDeal}
        fail={fail?.where === "queue" ? fail : null}
        onFail={(msg, retry) => setFail({ where: "queue", msg, retry })}
        onDismiss={() => setFail(null)}
      />

      {/* Plugin UI, each in its own sandboxed frame. Frames are marked inert
          while a modal is open so focus cannot tab underneath the overlay. */}
      <p aria-live="polite" className="sr-only" data-question-announcement="">
        {questionAnnouncement}
      </p>
      <PluginPanels env={env} selfId={me.id} modalOpen={Boolean(confirmEnd || confirmReset || confirmRemove || dealReview || estimateEditor || scopeEditor)} />

      {dealReview && (
        <Modal title={dealReview.story.votedUserIds.length > 0 ? `Start a fresh round on ${storyName(dealReview.story)}?` : "Review next child round"} onClose={() => setDealReview(null)}>
          {dealReview.story.votedUserIds.length > 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              {storyName(dealReview.story)} still holds votes from an earlier round. They are cleared when it is dealt;
              every other story keeps its votes and its estimate.
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              {dealReview.story.parentId && <>Parent: {reviewParent?.title || reviewParent?.ref || "Original ticket"}. </>}
              {dealReview.story.title} will be on the table. Earlier votes stay with their story and are never transferred.{" "}
              Only this child is dealt; sibling estimates and parent history stay independent.
            </p>
          )}
          {fail?.where === "queue" && <ErrorRow fail={fail} onDismiss={() => setFail(null)} />}
          <div className="mt-5 flex flex-wrap gap-2">
            <button data-autofocus className={buttonQuiet + " min-h-[44px]"} onClick={() => setDealReview(null)}>
              {current ? "Keep working on this round" : "Cancel"}
            </button>
            <button className={buttonPrimary + " min-h-[44px]"} disabled={!isFacilitator || ended || status !== "live"} onClick={async () => { if (await deal(dealReview.story, true, dealReview)) setDealReview(null); }}>{dealReview.story.votedUserIds.length > 0 ? "Start fresh round" : "Switch to children"}</button>
          </div>
        </Modal>
      )}
      {estimateEditor && (
        <Modal title={`Set estimate for ${estimateEditor.title || estimateEditor.ref}`} onClose={() => setEstimateEditor(null)}>
          <p className="mt-2 text-sm text-ink-soft">
            This records a Facilitator-set estimate, without claiming Poker consensus.
          </p>
          {estimateEditor.id === st.currentStoryId && !env.revealed && (
            <p className="mt-2 text-sm text-ink-soft">This round ends when you accept. Its votes are discarded.</p>
          )}
          <label className="mt-4 block text-sm">
            Estimate card
            <select className={inputClass + " mt-2 min-h-[44px]"} value={estimateCard} onChange={e => setEstimateCard(e.target.value)}>
              <option value="">Choose a card</option>
              {st.deck.values.filter(v => v !== "?" && v !== "coffee").map(v => <option key={v} value={v}>{faceOf(v)}</option>)}
            </select>
          </label>
          {fail?.where === "room" && <ErrorRow fail={fail} onDismiss={() => setFail(null)} />}
          <div className="mt-5 flex flex-wrap gap-2">
            <button className={buttonQuiet + " min-h-[44px]"} onClick={() => setEstimateEditor(null)}>Cancel</button>
            <button
              className={buttonPrimary + " min-h-[44px]"}
              disabled={!estimateCard || !isFacilitator || ended || status !== "live"}
              onClick={async () => {
                if (await run(() => action(env.id, "story", estimateRequest(estimateEditor, estimateCard, st, env.revealed)), { refreshOnConflict: true })) { setEstimateEditor(null); say("Facilitator-set estimate accepted"); }
              }}
            >
              Accept facilitator-set estimate
            </button>
          </div>
        </Modal>
      )}
      {scopeEditor && current && (
        <Modal title={`Review scope for ${scopeEditor.story.title || scopeEditor.story.ref}`} onClose={() => setScopeEditor(null)}>
          <p className="mt-2 text-sm text-ink-soft">
            Changing the title or notes restarts this child's voting round. A previous accepted estimate remains
            Needs review until deliberately accepted again.
          </p>
          <label className="mt-4 block text-sm">
            Title
            <input className={inputClass + " mt-2 min-h-[44px]"} maxLength={200} value={scopeTitle} onChange={e => setScopeTitle(e.target.value)} />
          </label>
          <label className="mt-4 block text-sm">
            Notes
            <textarea className={inputClass + " mt-2 min-h-[44px]"} maxLength={2000} value={scopeNotes} onChange={e => setScopeNotes(e.target.value)} />
          </label>
          {fail?.where === "room" && <ErrorRow fail={fail} onDismiss={() => setFail(null)} />}
          <div className="mt-5 flex flex-wrap gap-2">
            <button className={buttonQuiet + " min-h-[44px]"} onClick={() => setScopeEditor(null)}>Cancel</button>
            <button
              className={buttonPrimary + " min-h-[44px]"}
              disabled={!scopeTitle.trim() || !isFacilitator || ended}
              onClick={async () => {
                if (await run(() => action(env.id, "story", {
                  storyId: scopeEditor.story.id, title: scopeTitle, notes: scopeNotes,
                  expectedRevision: scopeEditor.story.contentRevision, scopeRestart: true,
                  expectedCurrentStoryId: scopeEditor.story.id, expectedRoundVersion: scopeEditor.round,
                }))) { setScopeEditor(null); say("Scope changed — fresh round; previous estimate needs review"); }
              }}
            >
              Change scope and restart review
            </button>
          </div>
        </Modal>
      )}
      {confirmEnd && (
        <Modal title="End this session?" onClose={() => setConfirmEnd(false)}>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            This ends the round for everyone at the table right now. The results stay in{" "}
            the space and you can reopen the session afterwards.
          </p>
          <div className="mt-5 flex justify-end gap-2.5">
            <button className={buttonQuiet} data-autofocus onClick={() => setConfirmEnd(false)}>
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
            <button className={buttonQuiet} data-autofocus onClick={() => setConfirmRemove(null)}>
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
            <button className={buttonQuiet} data-autofocus onClick={() => setConfirmReset(false)}>
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
    if (await run(() => action(env.id, "select", { storyId: added.id, expectedCurrentStoryId: st.currentStoryId ?? "", expectedRoundVersion: st.roundVersion }), { where: "queue", retry: true })) {
      say("Ad-hoc round on the table — no ticket needed");
    }
  }

  async function answerOnce(send: () => Promise<unknown>) {
    const isAlreadyAnswering = isAnswerInFlight.current;
    if (isAlreadyAnswering) return;
    isAnswerInFlight.current = true;
    setAnswerPending(true);
    try {
      await send();
    } finally {
      isAnswerInFlight.current = false;
      setAnswerPending(false);
    }
  }

  function requestDeal(story: Story) {
    if (!isFacilitator || ended || status !== "live" || isAnswerInFlight.current) return;
    const switchingParent = story.parentId === current?.id && (!env.revealed || current?.acceptedRoundVersion !== st.roundVersion);
    const isTicketThatWasSplit = !story.parentId && (story.planningRole === "context" || (story.splitRevision ?? 0) > 0);
    if (isTicketThatWasSplit && story.votedUserIds.length > 0) { setDealReview({story,round:st.roundVersion,currentId:st.currentStoryId}); return; }
    if (story.parentId && (story.votedUserIds.length > 0 || switchingParent)) { setDealReview({story,round:st.roundVersion,currentId:st.currentStoryId}); return; }
    void deal(story,false);
  }

  async function deal(story: Story, reviewed: boolean, snapshot?: {round: number | undefined; currentId: string | null}) {
    if (!isFacilitator || ended || status !== "live") return false;
    const body = reviewed ? {storyId:story.id,freshRound:story.votedUserIds.length > 0,switchToChildren:true,expectedCurrentStoryId:snapshot?.currentId ?? st.currentStoryId ?? "",expectedRoundVersion:snapshot?.round ?? st.roundVersion} : {storyId:story.id,expectedCurrentStoryId:st.currentStoryId ?? "",expectedRoundVersion:st.roundVersion};
    if (isAnswerInFlight.current) return false;
    let isDealt = false;
    await answerOnce(async () => {
      isDealt = await run(() => action(env.id,"select",body),{where:"queue"});
    });
    if (isDealt && !story.parentId && !hasRetainedDraft) {
      setDraftingParentId(null);
      setPeekedParentId(null);
    }
    if (isDealt && story.parentId) oweTableFocus();
    return isDealt;
  }

  async function recordTotalFor(target: NonNullable<typeof fan>) {
    const total = storyTotal(target, st.deck);
    if (total === null) return;
    await answerOnce(async () => {
      const isSaved = await run(() => action(env.id, "parent-estimate", parentTotalRequest(target, total)), { refreshOnConflict: true });
      if (!isSaved && !(await isParentAnswerRecorded(target.parent.id, true))) return;
      setReopenedQuestionParentId(null);
      say(`${target.parent.ref || storyName(target.parent)} estimated at ${total} · Story total`);
    });
  }

  async function leaveParentUnestimated(target: NonNullable<typeof fan>) {
    if (!isParentEstimateDue(target)) {
      setReopenedQuestionParentId(null);
      return;
    }
    await answerOnce(async () => {
      const isSaved = await run(() => action(env.id, "parent-estimate", parentDeclineRequest(target)), { refreshOnConflict: true });
      if (isSaved || (await isParentAnswerRecorded(target.parent.id, false))) setReopenedQuestionParentId(null);
    });
  }

  async function isParentAnswerRecorded(parentId: string, isTotalExpected: boolean) {
    const refreshed = await room.refresh().catch(() => null);
    const parent = refreshed?.state.stories.find((story) => story.id === parentId);
    const isRecorded = Boolean(
      parent &&
        parent.parentEstimateAnsweredRevision === (parent.splitRevision ?? 0) &&
        (!isTotalExpected || (parent.estimateProvenance === "story-total" && !parent.estimateNeedsReview)),
    );
    if (isRecorded) setFail(null);
    return isRecorded;
  }

  function oweTableFocus() {
    const hasLostFocus = !document.activeElement || document.activeElement === document.body;
    if (hasLostFocus && nowOnTable.current) {
      nowOnTable.current.focus({ preventScroll: true });
      return;
    }
    focusOwed.current = true;
    window.setTimeout(() => {
      focusOwed.current = false;
    }, FOCUS_HANDOFF_MS);
  }

  function goBackToTable() {
    if (!fan) return;
    if (hasRetainedDraft) {
      say(isRenameHeld ? FINISH_RENAMING : FINISH_TYPING);
      return;
    }
    if (canParkDrafts) {
      void setDraftsParked(fan.parent.id, true);
      return;
    }
    oweTableFocus();
    setPeekedParentId(null);
    setDraftingParentId(null);
  }

  async function setDraftsParked(parentId: string, isParked: boolean) {
    const isSaved = await run(() => action(env.id, "park-drafts", { parentId, parked: isParked }));
    if (!isSaved) {
      setContinuingParentId(null);
      return;
    }
    if (isParked) oweTableFocus();
    setUndoneParentId(null);
    setPeekedParentId(null);
    setDraftingParentId(isParked ? null : parentId);
  }

  async function reset() {
    await answerOnce(async () => {
      if (await run(() => action(env.id, "reset", {storyId: current?.id, expectedRoundVersion: st.roundVersion}), { retry: true })) {
        setSelected(null);
        say("Votes cleared — same story, fresh round");
      }
    });
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
