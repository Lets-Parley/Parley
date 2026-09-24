import type { CSSProperties } from "react";
import { kindLabel } from "../lib/kinds";

/*
 * How a session kind names itself: a small object taken from its own room,
 * then the label. Poker is the face-down card the table deals; standup is the
 * round of speakers with the current one marked. The label is a name, not
 * data, so it is sans — never mono.
 *
 * `label={false}` is for places where the word would repeat down a list (the
 * sidebar, a space filtered to one kind). The object then carries the kind's
 * name itself, as an image, so dropping the word never drops it from the
 * accessibility tree. `size="lg"` is the create dialog's picker: the same
 * objects scaled up, answering hover on the nearest `group` ancestor.
 *
 * An unregistered kind has no object. It keeps a quiet text chip with its wire
 * id, whatever `label` says — never another kind's object, never nothing.
 */
type Size = "md" | "lg";
type Props = { kind: string; label?: boolean; size?: Size };

export function KindChip({ kind, label = true, size = "md" }: Props) {
  const name = kindLabel(kind);
  const object =
    kind === "poker" ? <Card size={size} /> : kind === "standup" ? <Round size={size} /> : null;

  if (!object) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
        {name}
      </span>
    );
  }
  if (!label) {
    return (
      <span role="img" aria-label={name} className="inline-flex shrink-0 items-center">
        {object}
      </span>
    );
  }
  return (
    <span
      className={
        "inline-flex shrink-0 items-center " +
        // The picker's label sets its own size, weight and colour (it bolds
        // the chosen kind); a row's token sets them here.
        (size === "lg" ? "gap-3" : "gap-2 text-[13px] font-semibold text-ink-soft")
      }
    >
      {object}
      {name}
    </span>
  );
}

/*
 * Only the picker moves. A session row is itself a link whose hover already
 * lifts the whole row; a second, smaller lift inside it would be noise. Motion
 * uses the hand's tokens, and the global reduced-motion rule in tokens.css
 * turns every transition here into an instant change.
 */
const MOTION = "transition-[rotate,translate] duration-[var(--dur-lift)] ease-[var(--ease-spring)]";

/*
 * The table's face-down card (`Table.tsx`, state "back"): card-back, its
 * diamond pip, dealt at an angle. The pip never themes — it is the same brass
 * on both backs, by design.
 */
function Card({ size }: { size: Size }) {
  return (
    <span
      data-token="card"
      aria-hidden="true"
      className={
        "grid shrink-0 -rotate-6 place-items-center bg-card-back shadow-rest " +
        (size === "lg"
          ? `h-[46px] w-[34px] rounded-[6px] ${MOTION} group-hover:rotate-0 group-hover:-translate-y-1`
          : "h-6 w-[18px] rounded-[4px]")
      }
    >
      <span
        className={
          "rotate-45 border-pip opacity-85 " +
          (size === "lg" ? "h-3 w-3 border-2" : "h-[7px] w-[7px] border-[1.5px]")
        }
      />
    </span>
  );
}

/*
 * Four seats in a round, and the speaker: a larger accent marker parked on one
 * of them. The marker is its own element, pushed out from the centre by
 * `transform` and swung round by the separate `rotate` property — which
 * applies after `transform`, about the ring's centre — so stepping to the next
 * seat is one rotate transition along the ring, and the seat it leaves is
 * still there underneath.
 */
const SEATS = [0, 90, 180, 270];
const SPEAKER_SEAT = "rotate-[270deg]";

function Round({ size }: { size: Size }) {
  const lg = size === "lg";
  const radius = lg ? 14 : 7.5;
  const dot = lg ? 7 : 5;
  const speaker = lg ? 10 : 7;
  const at = (d: number): CSSProperties => ({ width: d, height: d, margin: -d / 2 });
  return (
    <span
      data-token="round"
      aria-hidden="true"
      className={
        "relative shrink-0 rounded-full border-ink-soft " +
        (lg ? "h-10 w-10 border-2" : "h-[22px] w-[22px] border-[1.5px]")
      }
    >
      {SEATS.map((deg) => (
        <span
          key={deg}
          data-seat
          className="absolute left-1/2 top-1/2 rounded-full bg-ink-soft"
          style={{ ...at(dot), transform: `rotate(${deg}deg) translateY(-${radius}px)` }}
        />
      ))}
      <span
        data-speaker
        className={
          `absolute left-1/2 top-1/2 rounded-full bg-accent ${SPEAKER_SEAT} ` +
          (lg ? `${MOTION} group-hover:rotate-[360deg]` : "")
        }
        style={{ ...at(speaker), transform: `translateY(-${radius}px)` }}
      />
    </span>
  );
}
