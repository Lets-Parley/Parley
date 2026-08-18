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
): { votedCount: number; canVote: number } {
  const voted = new Set(votedUserIds);
  const hasVoted = (p: Person) => voted.has(p.userId) || votes.has(p.userId);
  return {
    votedCount: seated.filter(hasVoted).length,
    canVote: seated.filter((p) => online.has(p.userId) || hasVoted(p)).length,
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
