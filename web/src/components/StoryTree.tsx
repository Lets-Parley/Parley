import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  action,
  api,
  ApiError,
  errorText,
  type ChildAcknowledgment,
  type Envelope,
  type Story,
} from "../lib/api";
import { focusNeutral } from "../lib/neutralFocus";
import { FanWires, type WireCard, playArrival, playEstimateStamp, prefersReducedMotion, useClearOfTray } from "../lib/fanMotion";
import type { ConnectionStatus } from "../lib/socket";
import {
  adoptionRequest,
  blockReason,
  canDealWithoutReview,
  canReconfirmCoverage,
  countSentence,
  coverageStanding,
  creationReceiptOf,
  dependencyProposal,
  hasCurrentEstimate,
  isLinked,
  leftoverRequest,
  mayExistInTracker,
  pastedTitles,
  plainErrorText,
  publicationSentence,
  recordedLeftoverId,
  removalRequest,
  splitFanOf,
  splitStateText,
  briefNameOf,
  storyName,
  blockerLinks,
  trackerRefusalText,
  undoSplitRequest,
  undoSplitSentence,
  undoneSentence,
  undoStateKey,
  type CreationReceipt,
  type SplitFan,
} from "../lib/splitFan";
import { dependencyNeedsReview } from "../lib/pokerDependencies";
import { buttonPrimary, buttonQuiet } from "./Modal";
import { SplitPublication } from "./SplitPublication";
import { StoryCard, type StoryEdit } from "./StoryCard";
import { TicketEstimate } from "./StoryDependencies";
import { faceOf } from "./Table";

const compactPrimary = buttonPrimary + " min-h-[44px] min-w-0 max-w-full px-4";
const compactQuiet = buttonQuiet + " min-h-[44px] min-w-0 max-w-full px-4";
const ANNOUNCEMENT_BATCH_MS = 450;
const RECONNECT_QUIET_MS = 900;
const isApplePlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

type Operation = { id: string; title: string };
type CreationOutcome =
  | { kind: "saved"; storyId: string | null; splitRevision: number | null }
  | { kind: "refused"; message: string }
  | { kind: "absent" }
  | { kind: "unknown" };
type StoryPart = "link" | "edit" | "removal" | "estimate";
type FailurePlace = "composer" | "leftover" | "undo" | { story: string; part: StoryPart };
type LeftoverCreation = Operation & { storyId: string | null; splitRevision: number };

const NOT_SAVED = "That story did not save. Press Enter to try again; it will not be added twice.";
const SAVE_UNKNOWN = "We could not tell whether that story saved. Check before trying again.";

function isOtherTextField(target: EventTarget | null, composer: HTMLElement | null): boolean {
  return (
    target instanceof HTMLElement &&
    target !== composer &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
type DragState = { fromId: string; toId: string | null; reason: string };

export function SplitStrip({ fan }: { fan: SplitFan }) {
  return (
    <div className="flex min-w-0 flex-1 basis-[220px] flex-wrap items-baseline gap-x-3 gap-y-0.5">
      {fan.parent.ref && <span className="font-mono text-[11px] text-ink-faint">{fan.parent.ref}</span>}
      <h2 className="fan-strip-title min-w-0 text-base font-bold tracking-tight wrap-anywhere">
        {storyName(fan.parent)}
      </h2>
      <span className="text-[13px] text-ink-soft">{splitStateText(fan)}</span>
      {fan.isAdopted && fan.parent.estimate != null && (
        <span className="text-[13px] text-ink-soft">
          <TicketEstimate story={fan.parent} />
        </span>
      )}
    </div>
  );
}

function useBatchedAnnouncements(): [string, (message: string) => void] {
  const [spoken, setSpoken] = useState("");
  const waiting = useRef<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const announce = useCallback((message: string) => {
    waiting.current.push(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSpoken(waiting.current.join(" "));
      waiting.current = [];
    }, ANNOUNCEMENT_BATCH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [spoken, announce];
}

type RoomSnapshot = {
  titles: Map<string, string>;
  estimates: Map<string, string | null>;
  links: Map<string, string>;
  isAdopted: boolean;
  onTableId: string | null;
};

function snapshotOf(fan: SplitFan, onTableId: string | null): RoomSnapshot {
  return {
    titles: new Map(fan.children.map((story) => [story.id, storyName(story)])),
    estimates: new Map(
      fan.children.map((story) => [story.id, story.estimate != null && !story.estimateNeedsReview ? story.estimate : null]),
    ),
    links: new Map(
      fan.edges.map((edge) => {
        const dependent = fan.everyChild.find((story) => story.id === edge.dependentId);
        const blocker = fan.everyChild.find((story) => story.id === edge.blockerId);
        return [edge.id, `${storyName(dependent)} now waits on ${storyName(blocker)}.`];
      }),
    ),
    isAdopted: fan.isAdopted,
    onTableId: fan.children.some((story) => story.id === onTableId) ? onTableId : null,
  };
}

export type StoryTreeProps = {
  env: Envelope;
  parentId: string;
  canEdit: boolean;
  status: ConnectionStatus;
  isComposerRequested?: boolean;
  isMotionHeld?: () => boolean;
  canPublish?: boolean;
  refreshError?: string;
  refresh?: () => Promise<Envelope>;
  onRetryRefresh?: () => void;
  onReflow?: () => void;
  onDeal?: (story: Story) => void;
  estimateCards?: string[];
  onSetEstimate?: (story: Story, estimate: string) => Promise<string> | void;
  onComposerClose?: () => void;
  onRetainChange?: (isRetained: boolean, isRenaming?: boolean) => void;
  onStoryAdded?: () => void;
  onBackToTable?: () => void;
  undoSlot?: HTMLElement | null;
  isCollapsed?: boolean;
  onExpand?: () => void;
  onUndoStart?: () => void;
  onUndone?: (draftCount: number) => void;
};

const RAIL_ITEM_GAP_PX = 6;

export function StoryTree(props: StoryTreeProps) {
  const fan = splitFanOf(props.env.state, props.parentId);
  if (!fan || props.status === "removed" || props.status === "kicked") return null;
  return <SplitFanStage {...props} fan={fan} />;
}

function SplitFanStage({
  env,
  fan,
  canEdit,
  status,
  isComposerRequested = false,
  isMotionHeld,
  canPublish = false,
  refreshError = "",
  refresh,
  onRetryRefresh,
  onReflow,
  onDeal,
  estimateCards,
  onSetEstimate,
  onComposerClose,
  onRetainChange,
  onStoryAdded,
  onBackToTable,
  undoSlot,
  isCollapsed = false,
  onExpand,
  onUndoStart,
  onUndone,
}: StoryTreeProps & { fan: SplitFan }) {
  const parent = fan.parent;
  const sessionId = env.id;
  const round = { currentStoryId: env.endedAt ? null : env.state.currentStoryId, roundVersion: env.state.roundVersion };
  const composerId = useId();
  const undoHeadingId = useId();
  const arrowId = "fan-arrow-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const phase = fan.isAdopted ? "planning" : "drafting";
  const canWrite = canEdit && !refreshError;

  const [title, setTitle] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [queuedTitles, setQueuedTitles] = useState<string[]>([]);
  const [sendingTitle, setSendingTitle] = useState<string | null>(null);
  const [isOutcomeUnknown, setOutcomeUnknown] = useState(false);
  const [isPending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ place: FailurePlace; message: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [leftoverTitle, setLeftoverTitle] = useState<string | null>(null);
  const [isCancelOpen, setCancelOpen] = useState(false);
  const [isRoundEndOpen, setRoundEndOpen] = useState(false);
  const [editingIds, setEditingIds] = useState<string[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [receipts, setReceipts] = useState<CreationReceipt[]>([]);
  const [receiptsRequested, setReceiptsRequested] = useState(0);
  const [isPublicationAvailable, setIsPublicationAvailable] = useState(false);
  const [isUndoOpen, setUndoOpen] = useState(false);
  const [trackerRefusedAt, setTrackerRefusedAt] = useState<string | null>(null);
  const [spoken, announce] = useBatchedAnnouncements();

  const isRequestInFlight = useRef(false);
  const isDealing = useRef(false);
  const waitingTitles = useRef<string[]>([]);
  const typedTitle = useRef("");
  const isComposingText = useRef(false);
  const leftoverOperation = useRef<LeftoverCreation | null>(null);
  const dealFocusOwed = useRef<string | null>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const cancelQuestion = useRef<HTMLDivElement>(null);
  const roundEndQuestion = useRef<HTMLDivElement>(null);
  const undoPanel = useRef<HTMLDivElement>(null);
  const roomAfterFailure = useRef<Envelope | null>(null);
  const wasConnected = useRef(status === "live");
  const composerInput = useRef<HTMLInputElement>(null);
  const undoTrigger = useRef<HTMLButtonElement>(null);
  const undoClose = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLElement>(null);
  const row = useRef<HTMLOListElement>(null);
  const wiresLayer = useRef<SVGSVGElement>(null);
  const dragLayer = useRef<SVGSVGElement>(null);
  const wires = useRef<FanWires | null>(null);
  const dragLabel = useRef<HTMLDivElement>(null);
  const ghostCard = useRef<HTMLLIElement>(null);
  const cardElements = useRef(new Map<string, HTMLLIElement>());
  const slotElements = useRef(new Map<string, HTMLSpanElement>());
  const seenRoom = useRef<RoomSnapshot | null>(null);
  const wasLive = useRef(status === "live");

  const hasUnsentText =
    title.trim().length > 0 ||
    operation !== null ||
    isOutcomeUnknown ||
    queuedTitles.length > 0 ||
    sendingTitle !== null ||
    Boolean(leftoverTitle?.trim());
  const hasRetainedDraft = hasUnsentText || editingIds.length > 0;
  const isComposerWanted = isComposerRequested || !fan.isAdopted || fan.drafted.length > 0;
  const isComposerShown = canWrite ? isComposerWanted : hasRetainedDraft && (title.length > 0 || operation !== null);
  const isGhostCardShown = canWrite && isComposerShown;
  const ghostTitle = sendingTitle ?? title;
  const storyOnTable = fan.children.find((story) => story.id === round.currentStoryId);
  const tabledStoryId = storyOnTable?.id ?? null;
  useEffect(() => {
    const rail = isCollapsed ? row.current : null;
    const currentItem = rail?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!rail || !currentItem || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollLeft = Math.max(0, currentItem.offsetLeft - RAIL_ITEM_GAP_PX);
  }, [isCollapsed, tabledStoryId]);
  const isResting = fan.isAdopted && !storyOnTable;
  const isRefusedByTracker = trackerRefusedAt === undoStateKey(fan);
  const canOfferUndo = canWrite && fan.isAdopted && !mayExistInTracker(receipts) && !isRefusedByTracker;
  const undoRefusal = failure?.place === "undo" ? failure.message : "";
  const undoRefusalText =
    trackerRefusalText(undoRefusal) || undoRefusal.charAt(0).toUpperCase() + undoRefusal.slice(1).replace(/\.$/, "") + ".";
  const isUndoPanelShown = isUndoOpen && fan.isAdopted && canWrite;
  const storyCount = fan.children.length;
  const hasEnoughStories = storyCount >= 2;
  const hasUnsentTitle = title.trim().length > 0;
  const commitReason = sendingTitle !== null
    ? "Adding your stories"
    : !hasEnoughStories
      ? storyCount === 1
        ? "One more story makes a split"
        : "Two stories make a split"
      : hasUnsentTitle
      ? "Press Enter to add what you typed, or clear it"
      : "";

  const focusComposer = useCallback(() => {
    window.setTimeout(() => {
      const landing = [composerInput.current, stage.current].find((element) => element?.isConnected);
      landing?.focus({ preventScroll: true });
    }, 0);
  }, []);

  useEffect(() => {
    const storyId = dealFocusOwed.current;
    if (!storyId) return;
    const card = cardElements.current.get(storyId);
    if (!card?.querySelector("[data-fan-deal]")) return;
    dealFocusOwed.current = null;
    focusNeutral([card]);
  });

  const isOnlyRenameHeld = editingIds.length > 0 && !hasUnsentText;
  useEffect(() => {
    onRetainChange?.(hasRetainedDraft, isOnlyRenameHeld);
  }, [hasRetainedDraft, isOnlyRenameHeld, onRetainChange]);
  useEffect(() => () => onRetainChange?.(false), [onRetainChange]);

  useEffect(() => {
    if (isComposerRequested) composerInput.current?.focus({ preventScroll: true });
  }, [isComposerRequested]);

  const refreshRoom = useCallback(async () => (refresh ? refresh() : null), [refresh]);

  useEffect(() => {
    if (status === "live" && !wasConnected.current) setFailure(null);
    wasConnected.current = status === "live";
  }, [status]);
  useClearOfTray(isCancelOpen, cancelQuestion);
  useClearOfTray(isRoundEndOpen, roundEndQuestion);

  function beginRequest() {
    isRequestInFlight.current = true;
    setPending(true);
    setFailure(null);
    setNotice("");
  }
  function finishRequest() {
    isRequestInFlight.current = false;
    setPending(false);
  }

  async function createOne(creation: Operation, expectedSplitRevision: number): Promise<CreationOutcome> {
    const createdStoryIn = (room: Envelope | null) =>
      room?.state.stories.find((story) => story.creationOperation === creation.id) ?? null;
    try {
      const acknowledgment = await action<ChildAcknowledgment | null>(sessionId, "child", {
        parentId: parent.id,
        title: creation.title,
        notes: "",
        operationId: creation.id,
        expectedSplitRevision,
      });
      try {
        await refreshRoom();
      } catch {
        setNotice("Story saved. Room refresh pending; reconnect before further changes.");
      }
      return {
        kind: "saved",
        storyId: acknowledgment?.storyId ?? null,
        splitRevision: acknowledgment?.splitRevision ?? null,
      };
    } catch (problem) {
      if (problem instanceof ApiError && problem.status < 500) {
        return { kind: "refused", message: errorText(problem) };
      }
      try {
        const created = createdStoryIn(await refreshRoom());
        return created ? { kind: "saved", storyId: created.id, splitRevision: null } : { kind: "absent" };
      } catch {
        return { kind: "unknown" };
      }
    }
  }

  function clearHeldTitle() {
    setOperation(null);
    typedTitle.current = "";
    setTitle("");
    setOutcomeUnknown(false);
  }

  function keepWaiting(titles: string[]) {
    waitingTitles.current = titles;
    setQueuedTitles(titles);
  }
  function showTyped(value: string) {
    typedTitle.current = value;
    setTitle(value);
  }

  async function dealTitles(first: Operation) {
    if (!canWrite || isRequestInFlight.current) return;
    beginRequest();
    isDealing.current = true;
    let creation = first;
    let splitRevision = parent.splitRevision ?? 0;
    try {
      for (;;) {
        setSendingTitle(creation.title);
        const outcome = await createOne(creation, splitRevision);
        if (outcome.kind !== "saved") {
          const typedAhead = typedTitle.current.trim();
          if (typedAhead) keepWaiting([typedAhead, ...waitingTitles.current]);
          showTyped(creation.title);
          setOperation(outcome.kind === "refused" ? null : creation);
          setOutcomeUnknown(outcome.kind === "unknown");
          setFailure({
            place: "composer",
            message:
              outcome.kind === "refused"
                ? outcome.message
                : outcome.kind === "absent"
                  ? NOT_SAVED
                  : SAVE_UNKNOWN,
          });
          return;
        }
        splitRevision = outcome.splitRevision ?? splitRevision + 1;
        onStoryAdded?.();
        const [next, ...later] = waitingTitles.current;
        if (next === undefined) return;
        keepWaiting(later);
        creation = { id: crypto.randomUUID(), title: next };
      }
    } finally {
      isDealing.current = false;
      setSendingTitle(null);
      finishRequest();
    }
  }

  function submitTitles(titles: string[]) {
    if (!canWrite || isOutcomeUnknown || isComposingText.current || titles.length === 0) return;
    if (isDealing.current) {
      keepWaiting([...waitingTitles.current, ...titles]);
      showTyped("");
      return;
    }
    if (isRequestInFlight.current) return;
    const first = operation?.title === titles[0] ? operation : { id: crypto.randomUUID(), title: titles[0] };
    setOperation(null);
    showTyped("");
    keepWaiting([...waitingTitles.current, ...titles.slice(1)]);
    void dealTitles(first);
  }

  function submitTitle() {
    const typed = title.trim();
    if (typed) submitTitles([typed]);
  }

  async function reconcileUnknown() {
    if (status !== "live" || isRequestInFlight.current || !operation) return;
    beginRequest();
    try {
      const room = await refreshRoom();
      if (room?.state.stories.some((story) => story.creationOperation === operation.id)) {
        clearHeldTitle();
      } else {
        setOutcomeUnknown(false);
        setFailure({ place: "composer", message: NOT_SAVED });
      }
    } catch {
      setOutcomeUnknown(true);
      setFailure({ place: "composer", message: SAVE_UNKNOWN });
    } finally {
      finishRequest();
      focusComposer();
    }
  }

  const heldOperationId = operation?.id;
  const isHeldTitleSaved =
    heldOperationId !== undefined &&
    !isPending &&
    env.state.stories.some((story) => story.creationOperation === heldOperationId);
  useEffect(() => {
    if (!isHeldTitleSaved) return;
    queueMicrotask(() => {
      setOperation(null);
      typedTitle.current = "";
      setTitle("");
      setOutcomeUnknown(false);
      setFailure(null);
    });
  }, [isHeldTitleSaved]);

  async function write(name: string, body: unknown, place: FailurePlace): Promise<Envelope | "saved" | null> {
    if (!canWrite || isRequestInFlight.current) return null;
    beginRequest();
    try {
      await action(sessionId, name, body);
      try {
        return (await refreshRoom()) ?? "saved";
      } catch {
        setNotice("Change saved. Room refresh pending; reconnect before further changes.");
        return "saved";
      }
    } catch (problem) {
      setFailure({ place, message: plainErrorText(problem) });
      if (place === "undo" && trackerRefusalText(errorText(problem))) setTrackerRefusedAt(undoStateKey(fan));
      roomAfterFailure.current = null;
      try {
        roomAfterFailure.current = await refreshRoom();
      } catch {
      }
      return null;
    } finally {
      finishRequest();
    }
  }

  async function toggleLink(dependentId: string, blockerId: string, shouldLink: boolean) {
    if (shouldLink && (isLinked(fan, dependentId, blockerId) || blockReason(fan, dependentId, blockerId))) return;
    await write("dependencies", dependencyProposal(fan, { dependentId, blockerId, shouldLink }), {
      story: dependentId,
      part: "link",
    });
  }

  async function reconfirmCoverage(room: Envelope | "saved" | null) {
    if (!room || room === "saved" || !canWrite || isRequestInFlight.current) return;
    const changed = splitFanOf(room.state, parent.id);
    if (!changed || !canReconfirmCoverage(changed) || coverageStanding(changed) !== "unconfirmed") return;
    isRequestInFlight.current = true;
    setPending(true);
    try {
      await action(
        sessionId,
        "adopt",
        adoptionRequest(changed, { currentStoryId: room.state.currentStoryId, roundVersion: room.state.roundVersion }),
      );
      await refreshRoom();
    } catch {
    } finally {
      finishRequest();
    }
  }

  async function nameLeftover() {
    const named = leftoverTitle?.trim();
    if (!named || !canWrite || isRequestInFlight.current || isComposingText.current) return;
    const creation: LeftoverCreation =
      leftoverOperation.current?.title === named
        ? leftoverOperation.current
        : { id: crypto.randomUUID(), title: named, storyId: null, splitRevision: parent.splitRevision ?? 0 };
    leftoverOperation.current = creation;
    beginRequest();
    try {
      if (!creation.storyId) {
        const outcome = await createOne(creation, creation.splitRevision);
        if (outcome.kind === "refused") {
          leftoverOperation.current = null;
          setFailure({ place: "leftover", message: outcome.message });
          return;
        }
        if (outcome.kind !== "saved" || !outcome.storyId) {
          setFailure({ place: "leftover", message: "That may not have saved. Press Enter to try again; it will not be added twice." });
          return;
        }
        creation.storyId = outcome.storyId;
        creation.splitRevision = outcome.splitRevision ?? creation.splitRevision + 1;
        onStoryAdded?.();
      }
      try {
        await action(sessionId, "leftover", leftoverRequest(fan, creation.storyId, creation.splitRevision));
      } catch {
        const room = await refreshRoom().catch(() => null);
        const latest = room ? splitFanOf(room.state, parent.id) : null;
        if (latest) creation.splitRevision = latest.parent.splitRevision ?? creation.splitRevision;
        setFailure({
          place: "leftover",
          message: `“${named}” was added as a story, but is not marked as left over yet. Press Enter to mark it.`,
        });
        return;
      }
      leftoverOperation.current = null;
      setLeftoverTitle(null);
      focusComposer();
      await refreshRoom().catch(() => setNotice("Change saved. Room refresh pending; reconnect before further changes."));
    } finally {
      finishRequest();
    }
  }

  async function commit(isRoundEndConfirmed = false) {
    if (!canWrite || isRequestInFlight.current || !isComposerShown) return;
    if (!hasEnoughStories) return;
    if (hasUnsentTitle) {
      announce("Press Enter to add what you typed, or clear it, before splitting.");
      return;
    }
    if (fan.isAdopted && round.currentStoryId === parent.id && !isRoundEndConfirmed) {
      setRoundEndOpen(true);
      return;
    }
    setRoundEndOpen(false);
    const canDealFirstStory = round.currentStoryId === null || round.currentStoryId === parent.id;
    const saved = await write("adopt", adoptionRequest(fan, round), "composer");
    if (!saved) {
      const latest = roomAfterFailure.current ? splitFanOf(roomAfterFailure.current.state, parent.id) : null;
      if (!latest?.isAdopted || latest.drafted.length > 0) return;
      setFailure(null);
      clearHeldTitle();
      keepWaiting([]);
      onComposerClose?.();
      return;
    }
    clearHeldTitle();
    keepWaiting([]);
    onComposerClose?.();
    if (saved === "saved" || !canDealFirstStory) return;
    const adopted = splitFanOf(saved.state, parent.id);
    const firstStory = adopted?.planning.find((story) => !hasCurrentEstimate(story)) ?? adopted?.planning[0];
    if (!firstStory || saved.state.currentStoryId) return;
    if (!canDealWithoutReview(firstStory)) {
      dealFocusOwed.current = firstStory.id;
      return;
    }
    await write(
      "select",
      {
        storyId: firstStory.id,
        expectedCurrentStoryId: "",
        expectedRoundVersion: saved.state.roundVersion,
      },
      "composer",
    );
  }

  function requestCancel() {
    if (fan.drafted.length < 2) void cancelDraft();
    else setCancelOpen(true);
  }
  function keepRound() {
    setRoundEndOpen(false);
    window.setTimeout(() => composerInput.current?.focus({ preventScroll: true }), 0);
  }
  function keepDrafting() {
    setCancelOpen(false);
    window.setTimeout(() => (cancelTrigger.current ?? composerInput.current)?.focus({ preventScroll: true }), 0);
  }
  async function cancelDraft() {
    if (isRequestInFlight.current) return;
    setCancelOpen(false);
    showTyped("");
    setOperation(null);
    keepWaiting([]);
    setLeftoverTitle(null);
    setFailure(null);
    let latest: SplitFan | null = fan;
    while (canWrite && latest && latest.drafted.length > 0) {
      const saved = await write("remove-child", removalRequest(latest, latest.drafted[0]), "composer");
      if (!saved || saved === "saved") return;
      latest = splitFanOf(saved.state, parent.id);
    }
    onComposerClose?.();
  }

  function openUndo() {
    setFailure(null);
    setUndoOpen(true);
    onUndoStart?.();
  }
  function closeUndo() {
    setUndoOpen(false);
    setFailure((current) => (current?.place === "undo" ? null : current));
    window.setTimeout(() => {
      const landing = [undoTrigger.current, composerInput.current, stage.current].find((element) => element?.isConnected);
      landing?.focus({ preventScroll: true });
    }, 0);
  }
  async function setEstimate(story: Story, estimate: string) {
    setFailure(null);
    const refusal = await onSetEstimate?.(story, estimate);
    if (refusal) setFailure({ place: { story: story.id, part: "estimate" }, message: refusal });
  }
  async function undoSplit() {
    const saved = await write("undo-split", undoSplitRequest(fan, round), "undo");
    if (!saved) {
      setReceiptsRequested((count) => count + 1);
      window.setTimeout(() => undoClose.current?.focus({ preventScroll: true }), 0);
      return;
    }
    setUndoOpen(false);
    setLeftoverTitle(null);
    onUndone?.(fan.children.length);
  }

  useClearOfTray(isUndoPanelShown, undoPanel);
  const isUndoQuestionStale = isUndoOpen && !fan.isAdopted;
  useEffect(() => {
    if (!isUndoQuestionStale) return;
    queueMicrotask(() => {
      setUndoOpen(false);
      setFailure((current) => (current?.place === "undo" ? null : current));
    });
  }, [isUndoQuestionStale]);

  const commitFromKeyboard = useRef(commit);
  useEffect(() => {
    commitFromKeyboard.current = commit;
  });
  useEffect(() => {
    if (!canWrite || !isComposerShown) return;
    function commitOnShortcut(event: KeyboardEvent) {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      if (document.querySelector("dialog[open]")) return;
      if (isOtherTextField(event.target, composerInput.current)) return;
      event.preventDefault();
      void commitFromKeyboard.current();
    }
    document.addEventListener("keydown", commitOnShortcut);
    return () => document.removeEventListener("keydown", commitOnShortcut);
  }, [canWrite, isComposerShown]);

  useEffect(() => {
    if (!canPublish || !fan.isAdopted) return;
    let isCurrent = true;
    const root = `/api/sessions/${sessionId}/publication`;
    void (async () => {
      try {
        const connection = await api<{ available?: boolean; binding?: unknown } | null>("GET", `${root}/connection`);
        if (isCurrent) setIsPublicationAvailable(connection?.available === true);
        if (!connection?.available || !connection.binding) return;
        const reviews = await api<{ id: string; parentId: string }[] | null>("GET", `${root}/reviews`);
        const forParent = Array.isArray(reviews) ? reviews.filter((review) => review.parentId === parent.id) : [];
        const latest = forParent[0];
        if (!latest) return;
        const found = await api<CreationReceipt[] | null>("GET", `${root}/reviews/${latest.id}/receipts`);
        if (isCurrent && Array.isArray(found)) setReceipts(found);
      } catch {
      }
    })();
    return () => {
      isCurrent = false;
    };
  }, [canPublish, fan.isAdopted, sessionId, parent.id, receiptsRequested]);

  useLayoutEffect(() => {
    const now = snapshotOf(fan, round.currentStoryId);
    const before = seenRoom.current;
    const isCatchingUp = !wasLive.current || status !== "live";
    seenRoom.current = now;
    wasLive.current = status === "live";
    if (!before || isCatchingUp) return;
    const arrivals = [...now.titles].filter(([id]) => !before.titles.has(id)).map(([, name]) => name);
    if (arrivals.length > 0) {
      announce(`Added ${arrivals.join(", ")}. ${storyCount === 1 ? "1 story" : `${storyCount} stories`} so far.`);
    }
    for (const [id, name] of before.titles) if (!now.titles.has(id)) announce(`Removed ${name}.`);
    if (now.isAdopted && !before.isAdopted) announce(`Split into ${fan.planning.length} stories.`);
    if (!now.isAdopted && before.isAdopted) {
      announce(undoneSentence(parent, storyCount));
    }
    const isHeld = Boolean(isMotionHeld?.());
    for (const [edgeId, sentence] of now.links) {
      if (before.links.has(edgeId)) continue;
      announce(sentence);
      if (isHeld) continue;
      wires.current?.announceLink(edgeId);
      playArrival(row.current?.querySelector(`[data-edge-id="${edgeId}"]`) ?? null);
    }
    for (const [id, estimate] of now.estimates) {
      if (estimate === null || before.estimates.get(id) === estimate || !before.titles.has(id)) continue;
      announce(`${now.titles.get(id)} estimated ${estimate}.`);
      if (!isHeld) playEstimateStamp(slotElements.current.get(id) ?? null);
    }
    if (now.onTableId && now.onTableId !== before.onTableId && !isHeld) wires.current?.pulseTether(now.onTableId);
  });

  useLayoutEffect(() => {
    const layer = wiresLayer.current;
    const frontLayer = dragLayer.current;
    if (!layer || !frontLayer) return;
    const drawer = new FanWires(layer, frontLayer, () => {
      const list = row.current;
      return !list || getComputedStyle(list).flexDirection === "column";
    });
    wires.current = drawer;
    return () => {
      drawer.dispose();
      wires.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    if (status !== "live") {
      element.dataset.fanQuiet = "";
      return;
    }
    const timer = window.setTimeout(() => delete element.dataset.fanQuiet, RECONNECT_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  useLayoutEffect(() => {
    onReflow?.();
    const cards: WireCard[] = [];
    for (const story of fan.children) {
      const element = cardElements.current.get(story.id);
      if (element) cards.push({ id: story.id, element, isDashed: false, isLive: story.id === round.currentStoryId });
    }
    if (ghostCard.current) cards.push({ id: "ghost", element: ghostCard.current, isDashed: true, isLive: false });
    wires.current?.setPlan({
      origin: stage.current?.closest("[data-fan-scope]")?.querySelector<HTMLElement>("[data-fan-origin]") ?? null,
      cards,
      links: isCollapsed
        ? []
        : fan.edges.map((edge) => ({
        id: edge.id,
        blockerId: edge.blockerId,
        dependentId: edge.dependentId,
        isUnsettled: dependencyNeedsReview(edge, fan.everyChild),
      })),
      hasGrips: canWrite,
      arrowId,
    });
  });

  useEffect(() => {
    const element = stage.current;
    const scope = element?.closest("[data-fan-scope]");
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => wires.current?.track(prefersReducedMotion() ? 0 : 240));
    observer.observe(element);
    if (scope) observer.observe(scope);
    void document.fonts?.ready.then(() => wires.current?.draw());
    return () => observer.disconnect();
  }, []);

  function storyIdAt(clientX: number, clientY: number): string | null {
    if (typeof document.elementFromPoint !== "function") return null;
    const card = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-story-id]");
    return card && row.current?.contains(card) ? (card.dataset.storyId ?? null) : null;
  }
  function beginDrag(event: ReactPointerEvent<HTMLOListElement>) {
    const grip = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-fan-grip]") : null;
    const fromId = grip?.closest<HTMLElement>("[data-story-id]")?.dataset.storyId;
    if (!grip || !fromId || !canWrite) return;
    event.preventDefault();
    grip.setPointerCapture?.(event.pointerId);
    setDrag({ fromId, toId: null, reason: "" });
    wires.current?.setDragLine({ fromId, clientX: event.clientX, clientY: event.clientY, snapToId: null, isRefused: false });
  }
  function continueDrag(event: ReactPointerEvent<HTMLOListElement>) {
    if (!drag) return;
    const hovered = storyIdAt(event.clientX, event.clientY);
    const toId = hovered && hovered !== drag.fromId ? hovered : null;
    const reason = !toId ? "" : isLinked(fan, toId, drag.fromId) ? "Already linked" : blockReason(fan, toId, drag.fromId);
    wires.current?.setDragLine({
      fromId: drag.fromId,
      clientX: event.clientX,
      clientY: event.clientY,
      snapToId: toId && !reason ? toId : null,
      isRefused: Boolean(toId && reason),
    });
    if (toId !== drag.toId || reason !== drag.reason) setDrag({ ...drag, toId, reason });
    const label = dragLabel.current;
    const frame = stage.current?.getBoundingClientRect();
    if (label && frame) {
      label.style.left = `${Math.max(8, Math.min(frame.width - 268, event.clientX - frame.left + 14))}px`;
      label.style.top = `${event.clientY - frame.top + 18}px`;
    }
  }
  function endDrag(shouldSave: boolean) {
    if (!drag) return;
    const finished = drag;
    setDrag(null);
    if (shouldSave && finished.toId && !finished.reason) {
      wires.current?.releaseDrag("linked");
      void toggleLink(finished.toId, finished.fromId, true).finally(() => wires.current?.settlePendingLink());
    } else {
      wires.current?.releaseDrag("dropped");
    }
  }
  function traceFrom(target: EventTarget | null) {
    if (drag || !(target instanceof Element) || !row.current?.contains(target)) return;
    const cardId = target.closest<HTMLElement>("[data-story-id]")?.dataset.storyId;
    const edgeId = target.closest<HTMLElement>("[data-edge-id]")?.dataset.edgeId ?? null;
    wires.current?.setTrace(cardId ? { cardId, edgeId } : null);
  }

  const failureAt = (storyId: string, part: StoryPart) =>
    failure && typeof failure.place === "object" && failure.place.story === storyId && failure.place.part === part
      ? failure.message
      : "";
  const composerFailure = failure?.place === "composer" ? failure.message : "";

  const hasVisibleLinks = fan.edges.some(
    (edge) => fan.children.some((story) => story.id === edge.blockerId) && fan.children.some((story) => story.id === edge.dependentId),
  );
  const dragSource = drag ? fan.children.find((story) => story.id === drag.fromId) : undefined;
  const dragTarget = drag?.toId ? fan.children.find((story) => story.id === drag.toId) : undefined;
  const leftoverStory = fan.drafted.find((story) => story.id === recordedLeftoverId(fan));
  const coverage = coverageStanding(fan);
  const committedLeftover = fan.planning.find((story) => story.isRemainder);
  const hasRows = fan.children.length > 0 || isGhostCardShown;

  return (
    <section
      ref={stage}
      id={`story-tree-${parent.id}`}
      tabIndex={-1}
      className="fan-stage"
      aria-label={`Stories split from ${storyName(parent)}`}
    >
      <svg ref={wiresLayer} className="fan-wires" aria-hidden="true">
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto">
            <path className="fan-arrowhead" d="M0,1.5 L10,5 L0,8.5 z" />
          </marker>
        </defs>
      </svg>

      {isCollapsed ? (
        <ol ref={row} className="fan-rail" data-fan-rail="" data-phase={phase} aria-label="Stories in this split">
          {fan.planning.map((story, storyIndex) => {
            const name = storyName(story);
            const standing = story.estimateNeedsReview ? "Needs review" : story.estimate != null ? faceOf(story.estimate) : "Not estimated";
            const blockerTitles = blockerLinks(fan, story.id).map((link) => link.title);
            const waitsOn = blockerTitles.length > 0 ? `waits on ${blockerTitles.join(", ")}` : "";
            const place = `story ${storyIndex + 1} of ${fan.planning.length}`;
            const summary = (
              <>
                <span className="fan-rail-position" aria-hidden="true">
                  {storyIndex + 1}
                </span>
                <span className="fan-rail-title">{name}</span>
                <span className="fan-rail-standing" data-standing={story.estimateNeedsReview ? "review" : story.estimate != null ? "set" : "none"}>
                  {story.estimateNeedsReview ? (
                    "Review"
                  ) : story.estimate != null ? (
                    standing
                  ) : (
                    <span aria-hidden="true">—</span>
                  )}
                  {(story.estimateNeedsReview || story.estimate == null) && <span className="sr-only">{standing}</span>}
                </span>
                {waitsOn && (
                  <span className="fan-rail-waits">
                    <span aria-hidden="true">↳</span>
                    <span className="sr-only">{waitsOn}</span>
                  </span>
                )}
              </>
            );
            if (story.id === round.currentStoryId) {
              return (
                <li key={story.id} className="fan-rail-item is-current" aria-current="true" title={name}>
                  {summary}
                  <span className="sr-only">, {place}, on the table</span>
                </li>
              );
            }
            return (
              <li key={story.id} className="fan-rail-slot">
                {canWrite && onDeal ? (
                  <button
                    key="deal"
                    type="button"
                    className="fan-rail-item"
                    title={name}
                    aria-label={`Deal ${name}: ${place}, ${standing}${waitsOn ? `, ${waitsOn}` : ""}`}
                    onClick={() => onDeal(story)}
                  >
                    {summary}
                  </button>
                ) : (
                  <span key="story" className="fan-rail-item" title={name}>
                    {summary}
                    <span className="sr-only">, {place}</span>
                  </span>
                )}
              </li>
            );
          })}
          {canWrite && fan.removed.length > 0 && onExpand && (
            <li className="fan-rail-slot">
              <button
                type="button"
                className="fan-rail-item is-quiet"
                aria-label={`Show the split and its ${fan.removed.length === 1 ? "1 removed story" : `${fan.removed.length} removed stories`}`}
                onClick={onExpand}
              >
                {fan.removed.length} removed
              </button>
            </li>
          )}
        </ol>
      ) : (
      <ol
        ref={row}
        className="fan-row"
        hidden={!hasRows}
        data-phase={phase}
        data-has-links={hasVisibleLinks ? "" : undefined}
        data-can-write={canWrite ? "" : undefined}
        aria-label="Stories in this split"
        onPointerOver={(event) => traceFrom(event.target)}
        onPointerLeave={() => wires.current?.setTrace(null)}
        onFocus={(event) => traceFrom(event.target)}
        onBlur={() => wires.current?.setTrace(null)}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
      >
        {fan.children.map((story, storyIndex) => {
          const ordinal = fan.planning.indexOf(story);
          const positionLabel = !fan.isAdopted
            ? parent.ref
              ? `from ${parent.ref}`
              : "new story"
            : ordinal >= 0
              ? `${ordinal + 1} of ${fan.planning.length}`
              : "Draft";
          return (
            <StoryCard
              key={story.id}
              fan={fan}
              story={story}
              heirOf={`ghost:${storyIndex}`}
              phase={phase}
              positionLabel={positionLabel}
              isOnTable={story.id === round.currentStoryId}
              isRoundHidden={!env.revealed}
              canWrite={canWrite}
              isBusy={isPending}
              round={round}
              receipt={creationReceiptOf(receipts, story.id)}
              dragStanding={drag?.toId === story.id ? (drag.reason ? "refused" : "target") : "none"}
              isGripHeld={drag?.fromId === story.id}
              hasGrip={fan.children.length > 1}
              linkError={failureAt(story.id, "link")}
              editError={failureAt(story.id, "edit")}
              removalError={failureAt(story.id, "removal")}
              estimateError={failureAt(story.id, "estimate")}
              cardRef={(element) => {
                if (element) cardElements.current.set(story.id, element);
                else cardElements.current.delete(story.id);
              }}
              slotRef={(element) => {
                if (element) slotElements.current.set(story.id, element);
                else slotElements.current.delete(story.id);
              }}
              onToggleLink={(blockerId, shouldLink) => toggleLink(story.id, blockerId, shouldLink)}
              onSaveEdit={async (edit: StoryEdit) => Boolean(await write("story", edit, { story: story.id, part: "edit" }))}
              onRemove={async () => {
                const saved = await write("remove-child", removalRequest(fan, story, round), { story: story.id, part: "removal" });
                await reconfirmCoverage(saved);
                return Boolean(saved);
              }}
              onUndoSplit={canOfferUndo ? openUndo : undefined}
              onDeal={onDeal ? () => onDeal(story) : undefined}
              estimateCards={estimateCards}
              onSetEstimate={onSetEstimate ? (estimate) => void setEstimate(story, estimate) : undefined}
              onEditingChange={(isEditing) =>
                setEditingIds((ids) => (isEditing ? [...new Set([...ids, story.id])] : ids.filter((id) => id !== story.id)))
              }
              onFocusComposer={focusComposer}
            />
          );
        })}

        {isGhostCardShown && (
          <li
            ref={ghostCard}
            className={"fan-card is-ghost" + (sendingTitle !== null ? " is-setting" : "")}
            data-fan-item={`ghost:${storyCount}`}
            data-fan-ghost=""
            data-fan-enter="deal"
            role="presentation"
            aria-hidden="true"
          >
            <span className="fan-plate" data-fan-plate />
            <span className="fan-eyebrow">{fan.isAdopted ? "Draft" : parent.ref ? `from ${parent.ref}` : "new story"}</span>
            <span className="fan-title">
              {ghostTitle}
              <span className="fan-caret" />
            </span>
          </li>
        )}
      </ol>
      )}

      <svg ref={dragLayer} className="fan-wires is-front" aria-hidden="true" />

      {drag && dragSource && dragTarget && (
        <div ref={dragLabel} className="fan-drag-label" aria-hidden="true">
          {drag.reason || `${storyName(dragTarget)} waits on ${storyName(dragSource)}`}
        </div>
      )}

      {isComposerShown && (
        <form
          className="fan-composer"
          data-fan-item="composer"
          data-fan-enter="rise"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            submitTitle();
          }}
        >
          <span className="fan-plate" data-fan-plate aria-hidden="true" />
          <label htmlFor={composerId} className="fan-composer-label">
            Name a story, then press Enter
          </label>
          <div className="fan-composer-row">
            <input
              ref={composerInput}
              id={composerId}
              className={"fan-composer-input" + (operation ? " is-held" : "")}
              autoComplete="off"
              enterKeyHint="done"
              maxLength={200}
              placeholder={storyCount > 0 ? "Next story" : "First story"}
              value={title}
              readOnly={!canWrite || isOutcomeUnknown || operation !== null}
              aria-busy={sendingTitle !== null || undefined}
              onChange={(event) => showTyped(event.target.value)}
              onCompositionStart={() => {
                isComposingText.current = true;
              }}
              onCompositionEnd={() => {
                isComposingText.current = false;
              }}
              onPaste={(event) => {
                const pasted = pastedTitles(event.clipboardData.getData("text"));
                if (pasted.length < 2 || !canWrite || isOutcomeUnknown || operation !== null) return;
                event.preventDefault();
                submitTitles(pasted);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  if (operation !== null || isOutcomeUnknown) return;
                  event.stopPropagation();
                  if (title) showTyped("");
                  else if (onBackToTable) onBackToTable();
                  else if (fan.drafted.length === 0) void cancelDraft();
                  return;
                }
                if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
                event.preventDefault();
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                submitTitle();
              }}
            />
            {canWrite && (
              <button type="submit" className={compactQuiet} aria-label={`Add story to ${storyName(parent)}`}>
                Add
              </button>
            )}
          </div>
          {(sendingTitle !== null || queuedTitles.length > 0) && (
            <p className="fan-note">
              {sendingTitle !== null && `Adding “${sendingTitle}”`}
              {sendingTitle !== null && queuedTitles.length > 0 && " · "}
              {queuedTitles.length > 0 && `${queuedTitles.length} more waiting`}
            </p>
          )}
          {composerFailure && (
            <p role="alert" className="fan-note text-stop">
              {composerFailure}
            </p>
          )}
          {isOutcomeUnknown && canWrite && (
            <button type="button" className={compactQuiet + " justify-self-start"} disabled={isPending} onClick={() => void reconcileUnknown()}>
              Check saved story
            </button>
          )}
          {notice && <p className="fan-note">{notice}</p>}
          {canWrite && storyCount > 0 && leftoverTitle !== null && (
            <div className="grid gap-1">
              <label className="grid gap-1 text-[13px] font-semibold">
                What is left over?
                <input
                  className="fan-field"
                  maxLength={200}
                  value={leftoverTitle}
                  autoFocus
                  readOnly={isPending}
                  onChange={(event) => setLeftoverTitle(event.target.value)}
                  onCompositionStart={() => {
                    isComposingText.current = true;
                  }}
                  onCompositionEnd={() => {
                    isComposingText.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setLeftoverTitle(null);
                      focusComposer();
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    void nameLeftover();
                  }}
                />
              </label>
              {failure?.place === "leftover" && (
                <p role="alert" className="fan-note text-stop">
                  {failure.message}
                </p>
              )}
              <div className="flex flex-wrap gap-x-3">
                <button type="button" className="fan-link" onClick={() => void nameLeftover()}>
                  Add it
                </button>
                <button
                  type="button"
                  className="fan-link is-quiet"
                  onClick={() => {
                    setLeftoverTitle(null);
                    focusComposer();
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {canWrite && storyCount > 0 && leftoverTitle === null && (
            <button
              type="button"
              className="fan-link is-quiet justify-self-start"
              onClick={async () => {
                if (!leftoverStory) {
                  setLeftoverTitle("");
                  return;
                }
                await write("leftover", leftoverRequest(fan, ""), "composer");
                focusComposer();
              }}
            >
              {leftoverStory ? `${storyName(leftoverStory)} is not left over` : "Name what’s left over"}
            </button>
          )}
          {canWrite && isRoundEndOpen ? (
            <div
              key="round-end-question"
              ref={roundEndQuestion}
              role="group"
              aria-label={`End the round on ${parent.ref || storyName(parent)}?`}
              className="grid gap-1"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                keepRound();
              }}
            >
              <p className="fan-note font-semibold">
                Split into {storyCount} stories and end the round on {parent.ref || storyName(parent)}?
              </p>
              <p className="fan-note">The round that is on the table for it ends. Its votes are kept.</p>
              <div className="flex flex-wrap gap-x-4">
                <button type="button" className="fan-link is-danger" disabled={isPending} onClick={() => void commit(true)}>
                  Split and end the round
                </button>
                <button type="button" className="fan-link is-quiet" autoFocus onClick={keepRound}>
                  Keep the round
                </button>
              </div>
            </div>
          ) : canWrite && isCancelOpen ? (
            <div
              key="cancel-question"
              ref={cancelQuestion}
              role="group"
              aria-label="Discard these drafts?"
              className="grid gap-1"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                keepDrafting();
              }}
            >
              <p className="fan-note font-semibold">Discard these {fan.drafted.length} draft stories?</p>
              <p className="fan-note">
                {fan.isAdopted
                  ? "The stories already in the split stay."
                  : `${parent.ref || briefNameOf(storyName(parent))} stays one story. Removed drafts can be brought back from this view.`}
              </p>
              <div className="flex flex-wrap gap-x-4">
                <button type="button" className="fan-link is-danger" disabled={isPending} onClick={() => void cancelDraft()}>
                  Discard drafts
                </button>
                <button type="button" className="fan-link is-quiet" autoFocus onClick={keepDrafting}>
                  Keep drafting
                </button>
              </div>
            </div>
          ) : canWrite ? (
            <div key="composer-actions" className="fan-composer-row">
              <button ref={cancelTrigger} type="button" className="fan-link is-quiet" onClick={requestCancel}>
                Cancel
              </button>
              <span className="fan-reason">
                {commitReason || (
                  <>
                    <kbd className="fan-key">{isApplePlatform ? "⌘" : "Ctrl"}</kbd> <kbd className="fan-key">Enter</kbd>
                  </>
                )}
              </span>
              <button type="button" className={compactPrimary} disabled={!hasEnoughStories || isPending} onClick={() => void commit()}>
                {hasEnoughStories ? `Split into ${storyCount} stories` : "Split"}
              </button>
            </div>
          ) : (
            <p className="fan-note">
              {status === "live" ? "You are no longer facilitating." : "Connection paused."} Your text is kept.
            </p>
          )}
        </form>
      )}

      {canWrite && canReconfirmCoverage(fan) && (
        <p className="fan-note fan-watching">
          {coverage === "leftover-needs-review"
            ? `A story was removed or brought back since ${storyName(committedLeftover)} was named as the leftover.`
            : "A story was removed or brought back since this split was made."}{" "}
          <button
            type="button"
            className="fan-link"
            disabled={isPending}
            onClick={() => void write("adopt", adoptionRequest(fan, round), "composer")}
          >
            {coverage === "leftover-needs-review" ? `Keep ${storyName(committedLeftover)} as the leftover` : "Confirm these stories"}
          </button>
        </p>
      )}

      {canWrite && !isCollapsed && fan.removed.length > 0 && (
        <details className="fan-removed" open={fan.removed.length === 1}>
          <summary className="fan-link is-quiet">
            {fan.removed.length === 1 ? "1 removed story" : `${fan.removed.length} removed stories`}
          </summary>
          <ul aria-label="Removed stories" className="grid justify-items-center">
            {fan.removed.map((story) => (
              <li key={story.id} className="fan-note flex flex-wrap items-center justify-center gap-x-2">
                <span>
                  {storyName(story)}
                  {story.ref && ` · ${story.ref}`}
                </span>
                <button
                  type="button"
                  className="fan-link"
                  aria-label={`Undo removal of ${storyName(story)}`}
                  onClick={async () => {
                    await reconfirmCoverage(await write("restore-child", removalRequest(fan, story), "composer"));
                    focusComposer();
                  }}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!canEdit && !fan.isAdopted && !isComposerShown && (
        <p className="fan-note fan-watching" data-fan-item="watching" data-fan-enter="fade">
          {storyCount === 0
            ? "This ticket is being split. Stories land here as they are named."
            : "Still being split. Nothing is counted until the split is made."}
        </p>
      )}

      {undoSlot &&
        canOfferUndo &&
        createPortal(
          <button
            ref={undoTrigger}
            type="button"
            className="fan-link is-quiet px-2"
            aria-expanded={isUndoOpen}
            onClick={() => (isUndoOpen ? closeUndo() : openUndo())}
          >
            Undo split
          </button>,
          undoSlot,
        )}

      {isUndoPanelShown && (
        <div
          ref={undoPanel}
          role="group"
          aria-labelledby={undoHeadingId}
          className="fan-undo"
          data-fan-item="undo"
          data-fan-enter="rise"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeUndo();
          }}
        >
          <p id={undoHeadingId} className="fan-undo-title">
            Undo this split?
          </p>
          {undoRefusal ? (
            <>
              <p role="alert" className="fan-note text-stop">
                {undoRefusalText}
              </p>
              <button key="close" ref={undoClose} type="button" className="fan-link is-quiet" onClick={closeUndo}>
                Close
              </button>
            </>
          ) : (
            <>
              <p className="fan-note">{undoSplitSentence(fan)}</p>
              {storyOnTable && <p className="fan-note">The round on {briefNameOf(storyName(storyOnTable))} ends. Its votes are kept.</p>}
              <div className="flex flex-wrap justify-center gap-x-4">
                <button type="button" className="fan-link is-danger" disabled={isPending} onClick={() => void undoSplit()}>
                  Undo split
                </button>
                <button type="button" className="fan-link is-quiet" autoFocus onClick={closeUndo}>
                  Keep the split
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {isResting && !isCollapsed && !isUndoPanelShown && (
        <div className="fan-rest" data-fan-item="rest" data-fan-enter="rise">
          <p className="fan-rest-count">{countSentence(fan)}</p>
          {receipts.length > 0 && <p className="fan-note">{publicationSentence(fan, receipts)} on GitHub</p>}
          {canPublish && canEdit && isPublicationAvailable && (
            <SplitPublication env={env} parentId={parent.id} onClosed={() => setReceiptsRequested((count) => count + 1)} />
          )}
        </div>
      )}

      {refreshError && canEdit && (
        <p role="alert" className="fan-note relative z-[1] text-stop">
          {refreshError}{" "}
          <button type="button" className="fan-link" onClick={onRetryRefresh}>
            Refresh room
          </button>
        </p>
      )}

      {composerFailure && !isComposerShown && (
        <p role="alert" className="fan-note relative z-[1] text-stop">
          {composerFailure}
        </p>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
    </section>
  );
}
