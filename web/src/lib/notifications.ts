import type { Envelope } from "./api";

export type NotificationCue =
  | "poker-start"
  | "poker-reveal"
  | "standup-start"
  | "standup-turn"
  | "standup-finish";

type PokerNotificationState = { currentStoryId?: string | null; roundVersion?: number };
type StandupNotificationState = { currentSpeakerId?: string | null };

export function notificationCue(
  previous: Envelope,
  next: Envelope,
  userId: string,
): NotificationCue | null {
  if (next.kind === "poker" && previous.kind === "poker") {
    const before = previous.state as unknown as PokerNotificationState;
    const after = next.state as unknown as PokerNotificationState;
    const newRound = (after.roundVersion ?? 0) > (before.roundVersion ?? 0);
    if (after.currentStoryId && next.revealed && (!previous.revealed || newRound)) {
      return "poker-reveal";
    }
    if (after.currentStoryId && !next.revealed && newRound) return "poker-start";
    return null;
  }
  if (next.kind === "standup" && previous.kind === "standup") {
    const before = previous.state as unknown as StandupNotificationState;
    const after = next.state as unknown as StandupNotificationState;
    if (
      next.phase === "speaking" &&
      after.currentSpeakerId === userId &&
      before.currentSpeakerId !== userId
    ) {
      return "standup-turn";
    }
    if (next.phase === "speaking" && previous.phase !== "speaking") return "standup-start";
    if (next.phase === "done" && previous.phase !== "done") return "standup-finish";
    if (next.endedAt && !previous.endedAt && previous.phase !== "done") return "standup-finish";
  }
  return null;
}
