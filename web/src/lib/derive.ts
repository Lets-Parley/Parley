import type { Envelope, Person } from "./api";

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
): { votedCount: number; canVote: number; voted: Set<string>; waiting: Person[] } {
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
