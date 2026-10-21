import { useId, useRef, useState, type Ref } from "react";
import { useClearOfTray } from "../lib/fanMotion";
import type { Story } from "../lib/api";
import {
  provenanceText,
  affectedDependencyIds,
  blockerLinks,
  estimateStanding,
  receiptStateText,
  removalRefusal,
  briefNameOf,
  storyName,
  type CreationReceipt,
  type SplitFan,
} from "../lib/splitFan";
import { buttonPrimary, buttonQuiet } from "./Modal";
import { BlockedByMenu, CardMenu, DependencyChips, type MenuCloseCause } from "./StoryDependencies";
import { faceOf } from "./Table";

export type RoundSnapshot = { currentStoryId: string | null; roundVersion: number | undefined };

export type StoryEdit = {
  storyId: string;
  title: string;
  notes: string;
  expectedRevision: number;
  scopeRestart: boolean;
  expectedCurrentStoryId: string;
  expectedRoundVersion: number | undefined;
};

type Draft = { base: Story; title: string; notes: string };

const compactPrimary = buttonPrimary + " min-h-[44px] px-4";
const compactQuiet = buttonQuiet + " min-h-[44px] px-4";

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function EstimateStandingRow({
  story,
  isOnTable,
  slotRef,
  pickerTrigger,
  isPickerOpen,
  onOpenPicker,
}: {
  story: Story;
  isOnTable: boolean;
  slotRef: Ref<HTMLSpanElement>;
  pickerTrigger: Ref<HTMLButtonElement>;
  isPickerOpen: boolean;
  onOpenPicker?: () => void;
}) {
  const standing = estimateStanding(story, isOnTable);
  const face = story.estimate ? faceOf(story.estimate) : "";
  const slotShape =
    standing === "accepted" ? " is-face" : standing === "needs-review" ? " is-face is-stale" : standing === "on-table" ? " is-back" : "";
  const slot = (
    <span ref={slotRef} aria-hidden="true" className={"fan-slot" + slotShape + (face.length > 2 ? " is-long" : "")}>
      {standing === "accepted" || standing === "needs-review" ? face : ""}
    </span>
  );
  return (
    <p className={"fan-standing is-" + standing + (onOpenPicker ? " can-set" : "")}>
      {onOpenPicker ? (
        <button
          ref={pickerTrigger}
          type="button"
          className="fan-standing-set"
          aria-label={`${story.estimate ? "Change" : "Set"} estimate for ${storyName(story)}`}
          aria-expanded={isPickerOpen}
          onClick={onOpenPicker}
        >
          {slot}
        </button>
      ) : (
        slot
      )}
      {standing === "accepted" && (
        <span>
          <span className="sr-only">Estimate {face}, </span>
          {provenanceText(story.estimateProvenance)}
        </span>
      )}
      {standing === "needs-review" && (
        <span>
          Needs review<span className="sr-only">, previous estimate {face}</span>
        </span>
      )}
      {standing === "on-table" && <span>On the table</span>}
      {standing === "not-estimated" && <span>Not estimated</span>}
      {onOpenPicker && (
        <span className="fan-standing-cue" aria-hidden="true">
          {story.estimate ? "Change" : "Set"}
        </span>
      )}
    </p>
  );
}

export function StoryCard({
  fan,
  story,
  heirOf,
  phase,
  positionLabel,
  isOnTable,
  isRoundHidden,
  canWrite,
  isBusy,
  round,
  receipt,
  dragStanding,
  isGripHeld,
  hasGrip,
  linkError,
  editError,
  removalError,
  estimateError,
  cardRef,
  slotRef,
  onToggleLink,
  onSaveEdit,
  onRemove,
  onUndoSplit,
  estimateCards,
  onDeal,
  onSetEstimate,
  onEditingChange,
  onFocusComposer,
}: {
  fan: SplitFan;
  story: Story;
  heirOf?: string;
  phase: "drafting" | "planning";
  positionLabel: string;
  isOnTable: boolean;
  isRoundHidden: boolean;
  canWrite: boolean;
  isBusy: boolean;
  round: RoundSnapshot;
  receipt?: CreationReceipt;
  dragStanding: "none" | "target" | "refused";
  isGripHeld: boolean;
  hasGrip: boolean;
  linkError: string;
  editError: string;
  removalError: string;
  estimateError: string;
  cardRef: Ref<HTMLLIElement>;
  slotRef: Ref<HTMLSpanElement>;
  onToggleLink: (blockerId: string, shouldLink: boolean) => Promise<void> | void;
  onSaveEdit: (edit: StoryEdit) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onUndoSplit?: () => void;
  estimateCards?: string[];
  onDeal?: () => void;
  onSetEstimate?: (estimate: string) => void;
  onEditingChange: (isEditing: boolean) => void;
  onFocusComposer: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<"blocked-by" | "more" | "estimate" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isConfirmingRemoval, setConfirmingRemoval] = useState(false);
  const [estimateToConfirm, setEstimateToConfirm] = useState<string | null>(null);
  const estimateQuestionId = useId();
  const blockedByTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const estimateTrigger = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const removalTrigger = () => moreTrigger.current ?? removeTrigger.current;
  const canSetEstimate = canWrite && Boolean(onSetEstimate) && Boolean(estimateCards?.length);
  const name = storyName(story);
  const links = blockerLinks(fan, story.id);
  const isDraftCard = story.planningRole === "proposed";
  const isStandingShown = phase === "planning" && !isDraftCard;
  const isDraftingCard = phase === "drafting" || isDraftCard;
  const affectedLinkCount = affectedDependencyIds(fan, story.id).length;
  const whyNotRemovable = removalRefusal(fan, story);
  const hasConflict = Boolean(draft && (draft.base.title !== story.title || draft.base.notes !== story.notes));
  const canSaveEdit = Boolean(draft && canWrite && !isBusy && !hasConflict && draft.title.trim());
  const removalQuestion = useRef<HTMLDivElement>(null);
  const estimateQuestion = useRef<HTMLDivElement>(null);
  useClearOfTray(isConfirmingRemoval, removalQuestion);
  useClearOfTray(estimateToConfirm !== null, estimateQuestion);

  function focusSoon(target: () => HTMLElement | null) {
    window.setTimeout(() => {
      const element = target();
      if (element?.isConnected) element.focus({ preventScroll: true });
      else onFocusComposer();
    }, 0);
  }
  function closeMenu(cause?: MenuCloseCause) {
    const trigger = openMenu === "more" ? moreTrigger : openMenu === "estimate" ? estimateTrigger : blockedByTrigger;
    setOpenMenu(null);
    if (cause !== "outside-press") focusSoon(() => trigger.current);
  }
  function chooseEstimate(card: string) {
    if (isOnTable && isRoundHidden) {
      setOpenMenu(null);
      setEstimateToConfirm(card);
      return;
    }
    closeMenu();
    onSetEstimate?.(card);
  }
  function answerEstimateQuestion(shouldSet: boolean) {
    const card = estimateToConfirm;
    setEstimateToConfirm(null);
    focusSoon(() => estimateTrigger.current);
    if (shouldSet && card !== null) onSetEstimate?.(card);
  }
  function startEditing() {
    setOpenMenu(null);
    setConfirmingRemoval(false);
    setDraft({ base: story, title: story.title, notes: story.notes });
    onEditingChange(true);
  }
  async function saveEdit() {
    if (!draft || !canSaveEdit) return;
    const isSaved = await onSaveEdit({
      storyId: story.id,
      title: draft.title,
      notes: draft.notes,
      expectedRevision: story.contentRevision ?? 0,
      scopeRestart: round.currentStoryId === story.id,
      expectedCurrentStoryId: round.currentStoryId ?? "",
      expectedRoundVersion: round.roundVersion,
    });
    if (isSaved) stopEditing();
  }
  function stopEditing() {
    setDraft(null);
    onEditingChange(false);
    focusSoon(() => editTrigger.current ?? moreTrigger.current);
  }
  async function remove() {
    setConfirmingRemoval(false);
    setOpenMenu(null);
    if (await onRemove()) onFocusComposer();
    else focusSoon(removalTrigger);
  }
  function keepStory() {
    setConfirmingRemoval(false);
    focusSoon(removalTrigger);
  }
  function requestRemoval() {
    setOpenMenu(null);
    if (phase === "drafting" && affectedLinkCount === 0) void remove();
    else setConfirmingRemoval(true);
  }

  const classes =
    "fan-card" +
    (isOnTable ? " is-on-table" : "") +
    (isDraftCard && phase === "planning" ? " is-draft" : "") +
    (draft ? " is-editing" : "") +
    (openMenu || draft ? " is-raised" : "") +
    (dragStanding !== "none" ? " is-target" : "") +
    (dragStanding === "refused" ? " is-refused" : "");

  return (
    <li
      ref={cardRef}
      className={classes}
      data-fan-item={story.id}
      data-fan-enter="deal"
      data-fan-heir={heirOf}
      data-story-id={story.id}
      tabIndex={-1}
      aria-current={isOnTable ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (draft) {
          event.stopPropagation();
          stopEditing();
        } else if (isConfirmingRemoval) {
          event.stopPropagation();
          keepStory();
        } else if (estimateToConfirm !== null) {
          event.stopPropagation();
          answerEstimateQuestion(false);
        }
      }}
    >
      <span className="fan-plate" data-fan-plate aria-hidden="true" />
      {isOnTable && <span className="fan-marker" data-fan-item="table-marker" data-fan-enter="fade" aria-hidden="true" />}
      <span className="fan-eyebrow">{positionLabel}</span>

      {draft ? (
        <div className="grid gap-2">
          <label className="grid gap-1 text-[13px] font-semibold">
            Title
            <input
              className="fan-field"
              aria-label={`Title for ${name}`}
              maxLength={200}
              value={draft.title}
              autoFocus
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void saveEdit();
              }}
            />
          </label>
          <label className="grid gap-1 text-[13px] font-semibold">
            Notes
            <textarea
              className="fan-field min-h-[88px]"
              aria-label={`Notes for ${name}`}
              rows={3}
              maxLength={2000}
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            />
          </label>
          {round.currentStoryId === story.id && (
            <p className="fan-note">Saving restarts this story's round and clears its votes.</p>
          )}
          {hasConflict && (
            <div className="grid gap-1 fan-note">
              <p>This story changed while you were editing.</p>
              <p className="whitespace-pre-wrap">
                Latest: {story.title}
                {story.notes && ` · ${story.notes}`}
              </p>
              <p className="whitespace-pre-wrap">
                Mine: {draft.title}
                {draft.notes && ` · ${draft.notes}`}
              </p>
              <div className="flex flex-wrap gap-x-3">
                <button
                  type="button"
                  className="fan-link"
                  onClick={() => setDraft({ ...draft, base: story })}
                >
                  Keep mine
                </button>
                <button
                  type="button"
                  className="fan-link"
                  onClick={() => setDraft({ base: story, title: story.title, notes: story.notes })}
                >
                  Use latest
                </button>
              </div>
            </div>
          )}
          {editError && (
            <p role="alert" className="fan-note text-stop">
              {editError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={compactPrimary}
              aria-label={`Save changes to ${name}`}
              disabled={!canSaveEdit}
              onClick={() => void saveEdit()}
            >
              Save
            </button>
            <button type="button" className={compactQuiet} aria-label={`Cancel changes to ${name}`} onClick={stopEditing}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="fan-title">{name}</span>
          {story.isRemainder && <span className="fan-note">Leftover scope</span>}
          {phase === "drafting" && story.notes && <span className="fan-note line-clamp-2">{story.notes}</span>}
          {isStandingShown && (
            <EstimateStandingRow
              story={story}
              isOnTable={isOnTable}
              slotRef={slotRef}
              pickerTrigger={estimateTrigger}
              isPickerOpen={openMenu === "estimate"}
              onOpenPicker={canSetEstimate ? () => setOpenMenu(openMenu === "estimate" ? null : "estimate") : undefined}
            />
          )}
          <DependencyChips links={links} />
          {receipt && (
            <span className="fan-receipt" data-state={receipt.state}>
              {receiptStateText[receipt.state] ?? "Unavailable"}
              {receipt.state === "confirmed" && receipt.remoteId && (
                <>
                  {" "}
                  <b>#{receipt.remoteId}</b>
                </>
              )}
            </span>
          )}
        </>
      )}

      {canWrite && !draft && isConfirmingRemoval && (
        <div ref={removalQuestion} role="group" aria-label={`Remove ${name}?`} className="mt-auto grid gap-1">
          <p className="fan-note">
            Remove this story?
            {isOnTable && ` The round on ${briefNameOf(name)} ends. Its votes are kept.`}
            {affectedLinkCount > 0 &&
              ` Its ${affectedLinkCount === 1 ? "link stays" : `${affectedLinkCount} links stay`} on record for review.`}
          </p>
          <div className="flex flex-wrap gap-x-3">
            <button type="button" className="fan-link is-danger" aria-label={`Confirm removing ${name}`} onClick={() => void remove()}>
              Remove
            </button>
            <button
              type="button"
              className="fan-link is-quiet"
              aria-label={`Keep ${name}`}
              autoFocus
              onClick={keepStory}
            >
              Keep
            </button>
          </div>
        </div>
      )}

      {removalError && !draft && (
        <p role="alert" className="fan-note text-stop">
          {removalError}
        </p>
      )}

      {canSetEstimate && !draft && estimateToConfirm !== null && (
        <div ref={estimateQuestion} role="group" aria-labelledby={estimateQuestionId} className="mt-auto grid gap-1">
          <p id={estimateQuestionId} className="fan-note font-semibold">
            Set {faceOf(estimateToConfirm)} while this round is live?
          </p>
          <p className="fan-note">It is recorded as Facilitator-set. The round on {briefNameOf(name)} ends and its votes are discarded.</p>
          <div className="flex flex-wrap gap-x-3">
            <button
              type="button"
              className="fan-link"
              aria-label={`Confirm estimating ${name} at ${faceOf(estimateToConfirm)}`}
              onClick={() => answerEstimateQuestion(true)}
            >
              Set {faceOf(estimateToConfirm)}
            </button>
            <button type="button" className="fan-link is-quiet" autoFocus onClick={() => answerEstimateQuestion(false)}>
              Keep voting
            </button>
          </div>
        </div>
      )}

      {estimateError && !draft && (
        <p role="alert" className="fan-note text-stop">
          {estimateError}
        </p>
      )}

      {canWrite && !draft && !isConfirmingRemoval && estimateToConfirm === null && (
        <>
          {isDraftingCard ? (
            <button
              key="remove"
              ref={removeTrigger}
              type="button"
              className="fan-icon-button fan-corner is-danger"
              aria-label={`Remove ${name}`}
              onClick={requestRemoval}
            >
              <CloseIcon />
            </button>
          ) : (
            <button
              key="more"
              ref={moreTrigger}
              type="button"
              className="fan-icon-button fan-corner"
              aria-label={`More for ${name}`}
              aria-expanded={openMenu === "more"}
              onClick={() => setOpenMenu(openMenu === "more" ? null : "more")}
            >
              <MoreIcon />
            </button>
          )}
          <div className="fan-actions">
            <button
              ref={blockedByTrigger}
              type="button"
              className="fan-link"
              aria-label={`Set what ${name} is blocked by`}
              aria-expanded={openMenu === "blocked-by"}
              onClick={() => setOpenMenu(openMenu === "blocked-by" ? null : "blocked-by")}
            >
              Blocked by…
            </button>
            {isDraftingCard ? (
              <button
                key="rename"
                ref={editTrigger}
                type="button"
                className="fan-icon-button"
                aria-label={`Rename or add notes to ${name}`}
                onClick={startEditing}
              >
                <PencilIcon />
              </button>
            ) : (
              !isOnTable &&
              onDeal && (
                <button key="deal" type="button" className="fan-deal" data-fan-deal aria-label={`Deal ${name}`} onClick={onDeal}>
                  Deal
                </button>
              )
            )}
          </div>
        </>
      )}

      {canWrite && openMenu === "blocked-by" && (
        <BlockedByMenu fan={fan} story={story} error={linkError} onToggle={onToggleLink} onClose={closeMenu} />
      )}
      {canSetEstimate && openMenu === "estimate" && (
        <CardMenu heading={`Estimate for ${name}`} onClose={closeMenu} footer="Recorded as Facilitator-set, not a Poker result">
          <div className="fan-deck">
            {estimateCards?.map((card) => (
              <button
                key={card}
                type="button"
                className="fan-deck-card"
                aria-label={`Estimate ${name} at ${faceOf(card)}`}
                aria-pressed={story.estimate === card}
                aria-current={story.estimate === card ? "true" : undefined}
                onClick={() => chooseEstimate(card)}
              >
                {faceOf(card)}
              </button>
            ))}
          </div>
        </CardMenu>
      )}
      {canWrite && openMenu === "more" && (
        <CardMenu heading={name} onClose={closeMenu}>
          <button type="button" className="fan-menu-action" onClick={startEditing}>
            Rename or add notes
          </button>
          {canSetEstimate && (
            <button type="button" className="fan-menu-action" onClick={() => setOpenMenu("estimate")}>
              Set estimate
            </button>
          )}
          {whyNotRemovable ? (
            <>
              <p className="fan-note px-2 py-1">{whyNotRemovable}</p>
              {onUndoSplit && (
                <button
                  type="button"
                  className="fan-menu-action"
                  onClick={() => {
                    setOpenMenu(null);
                    onUndoSplit();
                  }}
                >
                  Undo split instead
                </button>
              )}
            </>
          ) : (
            <button type="button" className="fan-menu-action is-danger" onClick={requestRemoval}>
              Remove from the split
            </button>
          )}
        </CardMenu>
      )}

      {canWrite && hasGrip && !draft && (
        <span
          className={"fan-grip" + (isGripHeld ? " is-held" : "")}
          data-fan-grip
          aria-hidden="true"
          title="Drag onto the story that waits on this one"
        />
      )}
    </li>
  );
}
