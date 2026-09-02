import { useRef } from "react";

/**
 * Daybreak — the round's progress carried by the field getting lighter.
 *
 * The light is SECONDARY. Seat marks and the count text carry all of it; the
 * field only adds an ambient sense of how far along the room is. If the
 * projector gate fails, flip CUE_LIGHT_ENABLED and the field collapses to one
 * static token — see the comment on that constant.
 */

/** The one switch. `false` short-circuits the whole cue layer. */
export const CUE_LIGHT_ENABLED = true;

export const CUE_STATES = ["overcast", "first-light", "daybreak", "day"] as const;
export type CueState = (typeof CUE_STATES)[number];

export function cueRank(state: CueState): number {
  return CUE_STATES.indexOf(state);
}

/**
 * Where the round sits right now, before the accumulator holds it.
 *
 * DAY is keyed to `revealed`, never to r, so a fully-voted-but-unrevealed
 * table sits at DAYBREAK and the reveal always has a step left to make. The
 * `>=` on the DAYBREAK arm matters: an earlier spec wrote `0.34 <= r < 1` and
 * left r=1-with-revealed=false matching nothing at all.
 *
 * Honest about what paints: with five voters the first two votes land at
 * r=0.2 and r=0.4, and React batches WebSocket updates into one tick, so
 * OVERCAST -> DAYBREAK -> DAY is the common path and FIRST LIGHT often never
 * paints. Four states are defined; two or three are what a real round shows.
 */
export function cueFor(votedCount: number, canVote: number, revealed: boolean): CueState {
  if (revealed) return "day";
  const r = canVote > 0 ? votedCount / canVote : 0;
  if (r === 0) return "overcast";
  if (r < 0.34) return "first-light";
  return "daybreak";
}

/** The arc's endpoints, per theme. Existing ground tokens only. */
const ARC = {
  dark: ["#0E1726", "#1E2B3F"], // --color-felt -> --color-surface-hi
  light: ["#DBD8D0", "#FFFFFF"], // --color-felt-deep -> --color-surface-hi
} as const;

export type Theme = keyof typeof ARC;

/**
 * The field colour at one cue step, 0..3. The single source of the arc: both
 * tokens.css's literals and the contrast test come from here, so no test ever
 * restates the interpolation.
 */
export function arcStep(theme: Theme, step: number): string {
  const [from, to] = ARC[theme];
  const t = step / (CUE_STATES.length - 1);
  const chan = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(chan(from, i) + (chan(to, i) - chan(from, i)) * t);
  return (
    "#" +
    [0, 1, 2]
      .map((i) => mix(i).toString(16).padStart(2, "0").toUpperCase())
      .join("")
  );
}

/** The custom property tokens.css declares for a cue state. */
export function cueVar(state: CueState): string {
  return `--cue-${state}`;
}

/**
 * A round boundary, detected client-side.
 *
 * NOT `env.version`: the server bumps that in six write paths — addStory,
 * patchStory, selectStory, castVote, reveal and reset — so keying anything
 * per-round to it resets on every vote cast. Verified in
 * internal/poker/routes.go. Do not re-derive this.
 *
 * What actually only happens at a boundary: the story changes, the reveal
 * flag flips, or the vote count DROPS to zero. Votes can be changed but never
 * withdrawn, so within one round the count only climbs; a fall to zero is a
 * reset and nothing else. That catches the pre-reveal Reset the old
 * `[currentStoryId, revealed]` effect missed entirely — it writes false over
 * false and leaves the story alone, so neither dependency moves.
 */
export function useRoundEpoch(
  storyId: string | null,
  revealed: boolean,
  votedCount: number,
): number {
  const prev = useRef({ storyId, revealed, votedCount, epoch: 0 });
  const p = prev.current;
  const boundary =
    p.storyId !== storyId || p.revealed !== revealed || (votedCount === 0 && p.votedCount > 0);
  if (boundary) prev.current = { storyId, revealed, votedCount, epoch: p.epoch + 1 };
  else prev.current = { ...p, votedCount };
  return prev.current.epoch;
}

/**
 * Hold the highest state reached this round, never step down.
 *
 * `canVote` counts online members, so r genuinely decreases when a non-voter
 * reconnects — "2 of 3 voted" becomes "2 of 2 voted" and the raw state would
 * fall back. Returns null when the light is cut, which is what makes the cut
 * a short-circuit rather than a revert.
 */
export function useCueAccumulator(epoch: number, live: CueState): CueState | null {
  const held = useRef({ epoch, state: live });
  if (!CUE_LIGHT_ENABLED) return null;
  if (held.current.epoch !== epoch) held.current = { epoch, state: live };
  else if (cueRank(live) > cueRank(held.current.state)) held.current = { epoch, state: live };
  return held.current.state;
}
