import { ApiError, errorText, type DependencyProposal, type PlanningDependency, type PokerState, type Story } from "./api";
import { dependencyNeedsReview } from "./pokerDependencies";

export type SplitFan = {
  parent: Story;
  everyChild: Story[];
  children: Story[];
  removed: Story[];
  drafted: Story[];
  planning: Story[];
  edges: PlanningDependency[];
  isAdopted: boolean;
};

export type BlockerLink = {
  edgeId: string;
  blockerId: string;
  title: string;
  isUnavailable: boolean;
};

export type EstimateStanding = "on-table" | "accepted" | "needs-review" | "not-estimated";

export function storyName(story: Story | undefined): string {
  return story?.title || story?.ref || "Untitled story";
}

const BRIEF_NAME_LENGTH = 48;

export function briefNameOf(name: string): string {
  return name.length > BRIEF_NAME_LENGTH ? `${name.slice(0, BRIEF_NAME_LENGTH - 1)}…` : name;
}

export function splitFanOf(state: PokerState, parentId: string | null | undefined): SplitFan | null {
  const parent = state.stories.find((story) => story.id === parentId && !story.parentId && !story.removedAt);
  if (!parent) return null;
  const everyChild = state.stories.filter((story) => story.parentId === parent.id);
  const children = everyChild.filter((story) => !story.removedAt);
  return {
    parent,
    everyChild,
    children,
    removed: everyChild.filter((story) => story.removedAt),
    drafted: children.filter((story) => story.planningRole === "proposed"),
    planning: children.filter((story) => story.planningRole !== "proposed"),
    edges: (state.dependencies ?? []).filter((edge) => edge.parentId === parent.id && !edge.retiredAt),
    isAdopted: parent.planningRole === "context",
  };
}

export function splitParents(state: PokerState): Story[] {
  return state.stories.filter(
    (story) =>
      !story.parentId &&
      !story.removedAt &&
      state.stories.some((child) => child.parentId === story.id && !child.removedAt),
  );
}

export function hasParkedDrafts(story: Story | undefined): boolean {
  return Boolean(story && story.draftsParked && !story.parentId && story.planningRole !== "context");
}

export function draftStoriesText(count: number): string {
  return count === 1 ? "1 draft story" : `${count} draft stories`;
}

export function parkedDraftsOf(state: PokerState, parent: Story | undefined): Story[] {
  if (!parent || !hasParkedDrafts(parent)) return [];
  return state.stories.filter(
    (story) => story.parentId === parent.id && !story.removedAt && story.planningRole === "proposed",
  );
}

export const SERVER_PROBLEM =
  "The server had a problem and that may not have gone through. Check the room, then try again.";

export function plainErrorText(problem: unknown): string {
  const isRawServerError =
    problem instanceof ApiError && problem.status >= 500 && /^internal( server)? error\.?$/i.test(problem.message.trim());
  return isRawServerError ? SERVER_PROBLEM : errorText(problem);
}

export function undoneSentence(parent: Story, draftCount: number): string {
  const kept = draftCount === 1 ? "1 draft story is kept" : `${draftCount} draft stories are kept`;
  return `Split undone. ${parent.ref || storyName(parent)} is one story again. ${kept}.`;
}

export function estimateRequest(story: Story, estimate: string, state: PokerState, isRevealed: boolean) {
  const isRoundLive = state.currentStoryId === story.id && !isRevealed;
  return {
    storyId: story.id,
    estimate,
    acceptanceMode: "facilitator-set",
    expectedRevision: story.contentRevision,
    expectedScopeRevision: story.scopeRevision,
    ...(isRoundLive ? { endRound: true, expectedCurrentStoryId: story.id, expectedRoundVersion: state.roundVersion } : {}),
  };
}

export function canBeSplit(story: Story | undefined): story is Story {
  return Boolean(story && !story.parentId && !story.removedAt);
}

export function focusedParentId(state: PokerState, pinnedParentId: string | null): string | null {
  const parents = splitParents(state).filter((parent) => !hasParkedDrafts(parent));
  const isKnownRoot = (id: string) => state.stories.some((story) => story.id === id && !story.parentId && !story.removedAt);
  if (pinnedParentId && isKnownRoot(pinnedParentId)) return pinnedParentId;
  const current = state.stories.find((story) => story.id === state.currentStoryId);
  if (current) {
    const familyId = current.parentId ?? current.id;
    return parents.some((parent) => parent.id === familyId) ? familyId : null;
  }
  const unfinished = parents.find((parent) =>
    state.stories.some(
      (child) => child.parentId === parent.id && !child.removedAt && (child.estimate == null || child.estimateNeedsReview),
    ),
  );
  return (unfinished ?? parents[parents.length - 1])?.id ?? null;
}

function isSettledEdge(fan: SplitFan, edge: PlanningDependency): boolean {
  return !dependencyNeedsReview(edge, fan.everyChild);
}

function waitsOn(fan: SplitFan, dependentId: string, blockerId: string, visited = new Set<string>()): boolean {
  if (visited.has(dependentId)) return false;
  visited.add(dependentId);
  return fan.edges
    .filter((edge) => edge.dependentId === dependentId && isSettledEdge(fan, edge))
    .some((edge) => edge.blockerId === blockerId || waitsOn(fan, edge.blockerId, blockerId, visited));
}

export function isLinked(fan: SplitFan, dependentId: string, blockerId: string): boolean {
  return fan.edges.some((edge) => edge.dependentId === dependentId && edge.blockerId === blockerId);
}

export function blockReason(fan: SplitFan, dependentId: string, blockerId: string): string {
  if (dependentId === blockerId) return "A story cannot wait on itself";
  if (waitsOn(fan, blockerId, dependentId)) return "It already waits on this story";
  return "";
}

export function blockerLinks(fan: SplitFan, dependentId: string): BlockerLink[] {
  return fan.edges
    .filter((edge) => edge.dependentId === dependentId)
    .map((edge) => {
      const blocker = fan.everyChild.find((story) => story.id === edge.blockerId);
      return {
        edgeId: edge.id,
        blockerId: edge.blockerId,
        title: blocker ? storyName(blocker) : "a story that is no longer here",
        isUnavailable: !isSettledEdge(fan, edge),
      };
    });
}

export function linkChipText(link: BlockerLink): string {
  return link.isUnavailable ? `waits on ${link.title} · needs review` : `waits on ${link.title}`;
}

function revisionsOf(stories: Story[]): Record<string, number> {
  return Object.fromEntries(stories.map((story) => [story.id, story.contentRevision ?? 0]));
}

export function dependencyProposal(
  fan: SplitFan,
  change: { dependentId: string; blockerId: string; shouldLink: boolean },
): DependencyProposal {
  const isChangedPair = (edge: PlanningDependency) =>
    edge.dependentId === change.dependentId && edge.blockerId === change.blockerId;
  const edges = fan.edges
    .filter((edge) => isSettledEdge(fan, edge) && !isChangedPair(edge))
    .map(({ blockerId, dependentId }) => ({ blockerId, dependentId }));
  if (change.shouldLink) edges.push({ blockerId: change.blockerId, dependentId: change.dependentId });
  const retireIds = change.shouldLink
    ? []
    : fan.edges.filter((edge) => isChangedPair(edge) && !isSettledEdge(fan, edge)).map((edge) => edge.id);
  return {
    parentId: fan.parent.id,
    expectedRevision: fan.parent.contentRevision ?? 0,
    expectedDependencyRevision: fan.parent.dependencyRevision ?? 0,
    children: revisionsOf(fan.everyChild),
    edges,
    retireIds,
  };
}

export function affectedDependencyIds(fan: SplitFan, storyId: string): string[] {
  return fan.edges.filter((edge) => edge.blockerId === storyId || edge.dependentId === storyId).map((edge) => edge.id);
}

type RoundIdentity = { currentStoryId: string | null; roundVersion: number | undefined };

export function removalRequest(fan: SplitFan, story: Story, round?: RoundIdentity) {
  return {
    storyId: story.id,
    expectedRevision: story.contentRevision ?? 0,
    expectedSplitRevision: fan.parent.splitRevision ?? 0,
    expectedDependencyRevision: fan.parent.dependencyRevision ?? 0,
    affectedDependencies: affectedDependencyIds(fan, story.id),
    ...(round && round.currentStoryId === story.id
      ? { endRound: true, expectedCurrentStoryId: story.id, expectedRoundVersion: round.roundVersion }
      : {}),
  };
}

const MIN_COMMITTED_STORIES = 2;

export function removalRefusal(fan: SplitFan, story: Story): string {
  if (!fan.isAdopted || story.planningRole === "proposed") return "";
  if (fan.planning.length <= MIN_COMMITTED_STORIES) return "A split keeps at least two stories.";
  return story.isRemainder ? "A split keeps its leftover story." : "";
}

export function undoSplitRequest(fan: SplitFan, round: RoundIdentity) {
  const isChildOnTable = fan.children.some((story) => story.id === round.currentStoryId);
  return {
    parentId: fan.parent.id,
    expectedRevision: fan.parent.contentRevision ?? 0,
    expectedSplitRevision: fan.parent.splitRevision ?? 0,
    children: revisionsOf(fan.children),
    ...(isChildOnTable
      ? { endRound: true, expectedCurrentStoryId: round.currentStoryId, expectedRoundVersion: round.roundVersion }
      : {}),
  };
}

export function adoptionRequest(fan: SplitFan, round: RoundIdentity) {
  const leftoverStoryId = recordedLeftoverId(fan);
  return {
    parentId: fan.parent.id,
    expectedRevision: fan.parent.contentRevision ?? 0,
    expectedSplitRevision: fan.parent.splitRevision ?? 0,
    children: revisionsOf(fan.children),
    ...(leftoverStoryId
      ? { coverage: "remainder" as const, remainderId: leftoverStoryId }
      : { coverage: "full" as const }),
    switchToChildren: true,
    expectedCurrentStoryId: round.currentStoryId ?? "",
    expectedRoundVersion: round.roundVersion,
  };
}

export function recordedLeftoverId(fan: SplitFan): string | null {
  return fan.children.find((story) => story.isRemainder)?.id ?? null;
}

export function leftoverRequest(fan: SplitFan, storyId: string, expectedSplitRevision = fan.parent.splitRevision ?? 0) {
  return { parentId: fan.parent.id, storyId, expectedSplitRevision };
}

export type CoverageStanding = "confirmed" | "unconfirmed" | "leftover-needs-review";

export function coverageStanding(fan: SplitFan): CoverageStanding {
  if (!fan.isAdopted || fan.parent.coverage !== "needs-review") return "confirmed";
  return fan.planning.some((story) => story.isRemainder) ? "leftover-needs-review" : "unconfirmed";
}

export function canReconfirmCoverage(fan: SplitFan): boolean {
  return coverageStanding(fan) !== "confirmed" && fan.drafted.length === 0;
}

export function canDealWithoutReview(story: Story): boolean {
  return story.votedUserIds.length === 0;
}

const PROVENANCE_TEXT: Record<string, string> = {
  "facilitator-set": "Facilitator-set",
  poker: "Poker",
  "story-total": "Story total",
};

export function provenanceText(provenance: Story["estimateProvenance"]): string {
  return PROVENANCE_TEXT[provenance ?? ""] ?? "Historical";
}

export function hasCurrentEstimate(story: Story): boolean {
  return story.estimate != null && !story.estimateNeedsReview;
}

export function nextStoryToEstimate(fan: SplitFan, afterStoryId: string | null): Story | undefined {
  if (!fan.isAdopted) return undefined;
  const start = fan.planning.findIndex((story) => story.id === afterStoryId);
  const inOrder = [...fan.planning.slice(start + 1), ...fan.planning.slice(0, start + 1)];
  return inOrder.find((story) => story.id !== afterStoryId && !hasCurrentEstimate(story));
}

type TotalDeck = { ordinal?: boolean };

const DECIMAL_CARD = /^\d+(?:\.(\d+))?$/;

export function storyTotal(fan: SplitFan, deck: TotalDeck): string | null {
  if (!fan.isAdopted || deck.ordinal || fan.planning.length === 0) return null;
  const cards = fan.planning.map((story) => (hasCurrentEstimate(story) ? (story.estimate === "½" ? "0.5" : story.estimate!) : ""));
  if (cards.some((card) => !DECIMAL_CARD.test(card))) return null;
  const places = Math.max(...cards.map((card) => DECIMAL_CARD.exec(card)?.[1]?.length ?? 0));
  const scaled = cards.reduce((sum, card) => {
    const [whole, fraction = ""] = card.split(".");
    return sum + BigInt(whole + fraction.padEnd(places, "0"));
  }, 0n);
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function isParentEstimateDue(fan: SplitFan): boolean {
  if (!fan.isAdopted || fan.planning.length === 0 || hasCurrentEstimate(fan.parent)) return false;
  if (!fan.planning.every(hasCurrentEstimate)) return false;
  return (fan.parent.parentEstimateAnsweredRevision ?? null) !== (fan.parent.splitRevision ?? 0);
}

export function canRefreshTotal(fan: SplitFan, deck: TotalDeck): boolean {
  return (
    fan.parent.estimateProvenance === "story-total" &&
    Boolean(fan.parent.estimateNeedsReview) &&
    storyTotal(fan, deck) !== null
  );
}

export function parentTotalRequest(fan: SplitFan, total: string) {
  return {
    parentId: fan.parent.id,
    answer: "total" as const,
    expectedRevision: fan.parent.contentRevision ?? 0,
    expectedSplitRevision: fan.parent.splitRevision ?? 0,
    expectedTotal: total,
    children: revisionsOf(fan.children),
  };
}

export function parentDeclineRequest(fan: SplitFan) {
  return { parentId: fan.parent.id, answer: "none" as const, expectedSplitRevision: fan.parent.splitRevision ?? 0 };
}

export function estimateStanding(story: Story, isOnTable: boolean): EstimateStanding {
  if (story.estimate != null && story.estimateNeedsReview) return "needs-review";
  if (story.estimate != null) return "accepted";
  return isOnTable ? "on-table" : "not-estimated";
}

export function estimateCounts(counted: Story[]) {
  const needsReview = counted.filter((story) => story.estimate != null && story.estimateNeedsReview).length;
  const estimated = counted.filter((story) => story.estimate != null && !story.estimateNeedsReview).length;
  return { total: counted.length, estimated, needsReview, notEstimated: counted.length - estimated - needsReview };
}

export function splitCounts(fan: SplitFan) {
  return estimateCounts(fan.isAdopted ? fan.planning : fan.children);
}

const storiesWord = (count: number) => (count === 1 ? "1 story" : `${count} stories`);

export function estimateCountsText(counts: ReturnType<typeof estimateCounts>): string {
  const review = counts.needsReview > 0 ? `, ${counts.needsReview} to review` : "";
  return `${counts.estimated} estimated, ${counts.notEstimated} not estimated${review}`;
}

export function countSentence(fan: SplitFan): string {
  const counts = splitCounts(fan);
  return `${storiesWord(counts.total)}. ${estimateCountsText(counts)}.`;
}

export function undoSplitSentence(fan: SplitFan): string {
  const estimates = fan.planning.some((story) => story.estimate != null)
    ? " Estimates set on them are kept and marked for review."
    : "";
  return `${fan.parent.ref || briefNameOf(storyName(fan.parent))} becomes one story again. The ${storiesWord(fan.planning.length)} are kept as drafts you can come back to.${estimates}`;
}

export function splitStateText(fan: SplitFan): string {
  if (!fan.isAdopted) return "Splitting";
  const drafts = fan.drafted.length > 0 ? ` · ${fan.drafted.length} more drafted` : "";
  const standing = coverageStanding(fan);
  const coverage =
    standing === "leftover-needs-review" ? " · leftover needs review" : standing === "unconfirmed" && fan.drafted.length === 0 ? " · not confirmed since it changed" : "";
  return `Split into ${storiesWord(fan.planning.length)}${drafts}${coverage}`;
}

export function pastedTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").replace(/^\s*\[[ xX]?\]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, 200));
}

export type CreationReceipt = {
  kind: string;
  state: string;
  childId?: string;
  remoteId?: string;
};

export const receiptStateText: Record<string, string> = {
  "local-only": "Local only",
  "waiting-for-issues": "Waiting on another issue",
  pending: "Pending",
  confirmed: "Created",
  failed: "Not created",
  unknown: "Unknown · may have reached GitHub",
};

const TRACKER_STATES = ["unknown", "confirmed"];

export function mayExistInTracker(receipts: CreationReceipt[]): boolean {
  return receipts.some((receipt) => receipt.kind === "create" && TRACKER_STATES.includes(receipt.state));
}

const TRACKER_REFUSALS: Record<string, string> = {
  "this split has stories already created in the tracker, so it cannot be undone here":
    "Some of these stories were already created in the tracker. Parley never deletes a tracker issue, so this split stays as it is.",
  "this split has stories that may already be created in the tracker, so it cannot be undone here":
    "A story from this split may already have reached the tracker. It cannot be undone until the receipt says the story was not created.",
};

export function trackerRefusalText(serverMessage: string): string {
  return TRACKER_REFUSALS[serverMessage] ?? "";
}

export function undoStateKey(fan: SplitFan): string {
  return `${fan.parent.contentRevision ?? 0}:${fan.parent.splitRevision ?? 0}`;
}

export function creationReceiptOf(receipts: CreationReceipt[], storyId: string): CreationReceipt | undefined {
  return receipts.find((receipt) => receipt.kind === "create" && receipt.childId === storyId);
}

export function publicationSentence(fan: SplitFan, receipts: CreationReceipt[]): string {
  const states = fan.planning.map((story) => creationReceiptOf(receipts, story.id)?.state ?? "local-only");
  const created = states.filter((state) => state === "confirmed").length;
  const failed = states.filter((state) => state === "failed").length;
  const unknown = states.filter((state) => state === "unknown").length;
  const tail = [failed > 0 ? `${failed} not created` : "", unknown > 0 ? `${unknown} unknown` : ""].filter(Boolean);
  return [`${created} of ${fan.planning.length} created`, ...tail].join(" · ");
}
