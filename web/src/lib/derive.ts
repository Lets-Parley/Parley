import type { Envelope, Person, Story } from "./api";
import { provenanceText } from "./splitFan";

const DECK_LABELS: Record<string, string> = {
  fibonacci: "Fibonacci",
  "modified-fibonacci": "Modified Fibonacci",
  tshirt: "T-shirt",
  "powers-of-2": "Powers of 2",
};

/** A deck for people: the built-ins are slugs on the wire, a custom deck is already named. */
export function deckLabel(name: string): string {
  return DECK_LABELS[name] ?? name;
}

/** How long a stranded table waits before anyone may take the chair. */
export const GRACE_SECONDS = 60;

/**
 * "N of M voted", where M is who could plausibly still vote.
 *
 * Away seats show "zzz" and cannot vote, so counting them in the denominator
 * means "N of N" never arrives while someone is disconnected. Anyone who
 * already voted still counts, even if they dropped afterwards.
 */
export function voteTally(
  seated: Person[],
  online: Set<string>,
  votedUserIds: string[],
  votes: Map<string, string>,
): { votedCount: number; canVote: number; voted: Set<string>; waiting: Person[]; away: number } {
  // One rule for "has voted", shared by the count and by each seat's card —
  // two copies of it can disagree, and then the footer contradicts the table.
  const voted = new Set(votedUserIds);
  for (const userId of votes.keys()) voted.add(userId);
  // And one rule for "is in this round", shared by the denominator and by the
  // "waiting on" line. The line used to restate only the "has not voted" half
  // of it and named away seats the denominator had already left out, so
  // "0 of 1 voted" sat above "Waiting on Dana Whitfield, skippy" — a person
  // whose own card said zzz. `waiting` is the same set minus whoever voted.
  const inRound = seated.filter((p) => online.has(p.userId) || voted.has(p.userId));
  return {
    votedCount: seated.filter((p) => voted.has(p.userId)).length,
    canVote: inRound.length,
    voted,
    waiting: inRound.filter((p) => !voted.has(p.userId)),
    // Seated but gone and not voted: the people the denominator left out.
    away: seated.length - inRound.length,
  };
}

/**
 * Whether to offer the facilitator chair, and how long the grace period has
 * left. `graceLeft` reaching 0 is the claimable moment, not a falsy nothing —
 * see the button's `=== null` test.
 */
export function claimState(
  env: Pick<
    Envelope,
    "facilitatorConnected" | "facilitatorOfflineSince" | "serverTime" | "endedAt"
  >,
  isFacilitator: boolean,
): { showClaim: boolean; offlineFor: number | null; graceLeft: number | null } {
  const offlineFor = env.facilitatorOfflineSince
    ? Math.floor((Date.parse(env.serverTime) - Date.parse(env.facilitatorOfflineSince)) / 1000)
    : null;
  const showClaim =
    !env.facilitatorConnected && !isFacilitator && offlineFor !== null && env.endedAt === null;
  return {
    showClaim,
    offlineFor,
    graceLeft: showClaim ? Math.max(0, GRACE_SECONDS - (offlineFor as number)) : null,
  };
}

/** Historical flat stories omit role; removed and proposed stories never count. */
export function isPlanningStory(story: Story): boolean {
  return (!story.planningRole || story.planningRole === "planning") && !story.removedAt;
}

/** What an ended poker room got through, for the room and its presenter view. */
export function sessionTally(stories: Story[]) {
  const planning = stories.filter(isPlanningStory);
  const estimated = planning.filter((s) => s.estimate && !s.estimateNeedsReview);
  // ponytail: non-numeric cards (?, coffee, T-shirt sizes) count as estimated but add no points.
  const points = estimated.reduce((sum, s) => sum + (Number(s.estimate) || 0), 0);
  const line = `${estimated.length} of ${planning.length} estimated · ${points} ${points === 1 ? "point" : "points"}`;
  return { planning, estimated, points, line };
}

export function estimateLabel(story: Story): string {
  if (story.estimate == null) return "Unestimated";
  if (story.estimateNeedsReview) return `Needs review · previous ${story.estimate}`;
  return `${story.estimate} · ${provenanceText(story.estimateProvenance)}`;
}
