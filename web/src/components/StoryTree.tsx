import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  action,
  api,
  ApiError,
  errorText,
  type Envelope,
  type Story,
} from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { buttonDanger, buttonPrimary, buttonQuiet, inputClass } from "./Modal";
import { faceOf } from "./Table";
import { StoryDependencies } from "./StoryDependencies";
import { dependencyNeedsReview, storyIdentity } from "../lib/pokerDependencies";

const quiet =
  buttonQuiet + " min-h-[44px] min-w-0 max-w-full wrap-anywhere px-[12px]";
const primary =
  buttonPrimary + " min-h-[44px] min-w-0 max-w-full wrap-anywhere px-[12px]";
type TreeProps = {
  env: Envelope;
  canEdit: boolean;
  status: ConnectionStatus;
  onReadRevoked?: () => void;
  onDeal: (story: Story) => void;
  onSetEstimate: (story: Story) => void;
};

export function StoryTree(props: TreeProps) {
  const sessionId = props.env.id;
  const onReadRevoked = props.onReadRevoked;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [retainedRoots, setRetainedRoots] = useState<string[]>([]);
  const retainRoot = useCallback((id: string, retain: boolean) => {
    setRetainedRoots((roots) => {
      if (roots.includes(id) === retain) return roots;
      return retain ? [...roots, id] : roots.filter((root) => root !== id);
    });
  }, []);
  const [fresh, setFresh] = useState<Envelope | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [revoked, setRevoked] = useState(false);
  const previousStatus = useRef(props.status);
  const visible =
    props.status !== "removed" && props.status !== "kicked" && !revoked;
  const env = fresh && fresh.version > props.env.version ? fresh : props.env;
  const hasAuthority =
    visible &&
    props.canEdit &&
    props.status === "live" &&
    !refreshing &&
    env.endedAt === null &&
    env.facilitatorId === props.env.facilitatorId;

  const refresh = useCallback(async () => {
    try {
      const next = await api<Envelope>("GET", `/api/sessions/${sessionId}`);
      setFresh(next);
      setRefreshError("");
      return next;
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        setRevoked(true);
        onReadRevoked?.();
      }
      setRefreshError("Refresh the room before writing again.");
      throw e;
    }
  }, [sessionId, onReadRevoked]);
  useEffect(() => {
    if (previousStatus.current !== "live" && props.status === "live") {
      queueMicrotask(() => setRefreshing(true));
      void refresh()
        .catch(() => setRefreshError("Refresh the room before writing again."))
        .finally(() => setRefreshing(false));
    }
    previousStatus.current = props.status;
  }, [props.status, refresh]);

  if (!visible) return null;
  const roots = env.state.stories.filter(
    (s) =>
      !s.parentId &&
      !s.removedAt &&
      (s.id === env.state.currentStoryId ||
        retainedRoots.includes(s.id) ||
        env.state.stories.some((c) => c.parentId === s.id)),
  );
  if (!roots.length) return null;
  const canWrite = hasAuthority && !refreshError;
  return (
    <section
      aria-label="Story trees"
      className="min-w-0 rounded-panel border border-line bg-surface p-[12px] shadow-rest sm:p-4"
      onFocusCapture={(e) => {
        const tray = document.querySelector<HTMLElement>("[data-poker-hand]");
        if (!tray || getComputedStyle(tray).position !== "fixed") return;
        const target = e.target.closest("label") ?? e.target;
        const overlap = target.getBoundingClientRect().bottom - tray.getBoundingClientRect().top;
        if (overlap > -16) window.scrollBy({ top: overlap + 16, behavior: "instant" });
      }}
    >
      {refreshError && (
        <p role="alert" className="text-sm text-stop">
          {refreshError}{" "}
          <button
            className={quiet}
            onClick={() => {
              setRefreshing(true);
              void refresh()
                .catch(() =>
                  setRefreshError("Refresh the room before writing again."),
                )
                .finally(() => setRefreshing(false));
            }}
          >
            Refresh room
          </button>
        </p>
      )}
      {!canWrite && (
        <p className="mb-3 text-sm text-ink-soft">
          {env.endedAt
            ? "Session ended. Reopen it using the room controls to edit."
            : props.status !== "live" || refreshing
              ? "Connection paused. Reading stays available; writes wait for a refreshed room."
              : "Only the current facilitator can change these stories. Your unsaved edits are kept."}
        </p>
      )}
      <ul className="space-y-5">
        {roots.map((parent) => (
          <li key={parent.id}>
            <ParentTree
              {...props}
              env={env}
              parent={parent}
              expanded={expanded}
              setExpanded={setExpanded}
              editing={editing}
              setEditing={setEditing}
              retainRoot={retainRoot}
              canWrite={canWrite}
              authorized={() => canWrite}
              refresh={refresh}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

type Editor = {
  story: Story;
  title: string;
  notes: string;
  currentId: string | null;
  round: number | undefined;
  trigger: HTMLButtonElement;
};
type Adoption = {
  parent: Story;
  children: Story[];
  currentId: string | null;
  round: number | undefined;
  trigger: HTMLButtonElement;
};
function ParentTree({
  env,
  status,
  parent,
  canWrite,
  authorized,
  refresh,
  onDeal,
  onSetEstimate,
  expanded,
  setExpanded,
  editing,
  setEditing,
  retainRoot,
}: TreeProps & {
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
  retainRoot: (id: string, retain: boolean) => void;
  parent: Story;
  canWrite: boolean;
  authorized: () => boolean;
  refresh: () => Promise<Envelope>;
}) {
  const heading = useId();
  const children = env.state.stories.filter((s) => s.parentId === parent.id);
  const active = children.filter((s) => !s.removedAt);
  const planning = active.filter(
    (s) => !s.planningRole || s.planningRole === "planning",
  );
  const proposed = active.filter((s) => s.planningRole === "proposed");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [adoption, setAdoption] = useState<Adoption | null>(null);
  const [coverage, setCoverage] = useState<"full" | "remainder">("full");
  const [remainder, setRemainder] = useState("");
  const [remove, setRemove] = useState<{
    story: Story;
    parent: Story;
    trigger: HTMLButtonElement;
    dependencies: string[];
  } | null>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [operation, setOperation] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [errorAt, setErrorAt] = useState("child");
  const [notice, setNotice] = useState("");
  const addInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const latest = editor && children.find((s) => s.id === editor.story.id);
  const conflict = Boolean(
    editor &&
    latest &&
    (latest.contentRevision !== editor.story.contentRevision ||
      editor.currentId !== env.state.currentStoryId ||
      editor.round !== env.state.roundVersion),
  );
  const adoptionConflict = Boolean(
    adoption &&
    (adoption.parent.contentRevision !== parent.contentRevision ||
      adoption.parent.splitRevision !== parent.splitRevision ||
      adoption.children.some(
        (s) =>
          children.find((c) => c.id === s.id)?.contentRevision !==
          s.contentRevision,
      )),
  );

  function restoreFocus(target?: HTMLElement | null) {
    if (busy.current) {
      pendingFocus.current = target ?? addInput.current;
      return;
    }
    if (target instanceof HTMLButtonElement && target.disabled) {
      window.setTimeout(() => {
        if (target.isConnected && !target.disabled) target.focus();
        else addInput.current?.focus();
      }, 0);
      return;
    }
    if (target?.isConnected) target.focus();
    else addInput.current?.focus();
  }
  function finishRequest() {
    busy.current = false;
    setPending(false);
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target) window.setTimeout(() => restoreFocus(target), 0);
  }
  function closeEditor() {
    const trigger = editor?.trigger;
    setEditor(null);
    setEditing(false);
    setError("");
    restoreFocus(trigger);
  }
  const acknowledge = useCallback(() => {
    retainRoot(parent.id, false);
    setOperation(null);
    setTitle("");
    setUnknown(false);
    setError("");
    setNotice("Story saved · Local only");
  }, [
    retainRoot,
    parent.id,
    setOperation,
    setTitle,
    setUnknown,
    setError,
    setNotice,
  ]);
  useEffect(() => {
    if (
      operation &&
      env.state.stories.some((c) => c.creationOperation === operation.id)
    )
      queueMicrotask(acknowledge);
  }, [env.state.stories, operation, acknowledge]);

  async function reconcile() {
    setErrorAt("child");
    if (status !== "live" || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const next = await refresh();
      if (next.state.stories.some((s) => s.creationOperation === operation?.id))
        acknowledge();
      else {
        setUnknown(false);
        setError(
          "Story not found in the refreshed room. Retry uses the same identity.",
        );
      }
    } catch {
      setUnknown(true);
      setError("Outcome unknown. Check the saved story before retrying.");
    } finally {
      finishRequest();
    }
  }
  async function create() {
    if (
      !authorized() ||
      busy.current ||
      unknown ||
      composing.current ||
      !title.trim()
    )
      return;
    busy.current = true;
    setPending(true);
    setError("");
    setErrorAt("child");
    const op = operation ?? { id: crypto.randomUUID(), title: title.trim() };
    setOperation(op);
    try {
      await action(env.id, "child", {
        parentId: parent.id,
        title: op.title,
        notes: "",
        operationId: op.id,
        expectedSplitRevision: parent.splitRevision ?? 0,
      });
      acknowledge();
      try {
        await refresh();
      } catch {
        setNotice(
          "Story saved. Room refresh pending; reconnect before further changes.",
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        setOperation(null);
        setError(errorText(e));
      } else {
        try {
          const next = await refresh();
          if (next.state.stories.some((s) => s.creationOperation === op.id))
            acknowledge();
          else {
            setUnknown(false);
            setError(
              "Story not found in the refreshed room. Retry uses the same identity.",
            );
          }
        } catch {
          setUnknown(true);
          setError("Outcome unknown. Check the saved story before retrying.");
        }
      }
    } finally {
      pendingFocus.current = addInput.current;
      finishRequest();
    }
  }
  async function write(name: string, body: unknown, success: () => void) {
    setErrorAt(name);
    if (!authorized() || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await action(env.id, name, body);
      success();
      try {
        await refresh();
      } catch {
        setNotice(
          "Change saved. Room refresh pending; reconnect before further changes.",
        );
      }
    } catch (e) {
      setError(errorText(e));
      try {
        await refresh();
      } catch {
        /* Keep the editor until authority can be refreshed. */
      }
    } finally {
      finishRequest();
    }
  }
  function reviewAdoption(e: React.MouseEvent<HTMLButtonElement>) {
    setEditor(null);
    setRemove(null);
    setCoverage("full");
    setRemainder("");
    setError("");
    setAdoption({
      parent,
      children: active,
      currentId: env.state.currentStoryId,
      round: env.state.roundVersion,
      trigger: e.currentTarget,
    });
  }
  function cancelAdoption() {
    restoreFocus(adoption?.trigger);
    setAdoption(null);
    setError("");
  }
  function childRevisions(stories: Story[]) {
    return Object.fromEntries(
      stories.map((s) => [s.id, s.contentRevision ?? 0]),
    );
  }
  function removeBody(s: Story, p: Story, dependencies: string[]) {
    return {
      storyId: s.id,
      expectedRevision: s.contentRevision ?? 0,
      expectedSplitRevision: p.splitRevision ?? 0,
      expectedDependencyRevision: p.dependencyRevision ?? 0,
      affectedDependencies: dependencies,
    };
  }
  function affected(s: Story) {
    return (env.state.dependencies ?? [])
      .filter(
        (d) => !d.retiredAt && (d.blockerId === s.id || d.dependentId === s.id),
      )
      .map((d) => d.id);
  }

  return (
    <div
      id={`story-tree-${parent.id}`}
      className="min-w-0 scroll-mt-4 wrap-anywhere"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          if (editor) {
            e.stopPropagation();
            closeEditor();
          } else if (adoption) {
            e.stopPropagation();
            cancelAdoption();
          } else if (remove) {
            remove.trigger.focus();
            setRemove(null);
            setError("");
          }
        }
      }}
    >
      <h2 id={heading} className="break-words font-display text-xl">
        {children.length ? "Parent: " : "Split into stories: "}
        {parent.title || parent.ref || "Parent story"}
      </h2>
      {parent.ref && (
        <p className="break-words font-mono text-sm text-ink-soft">
          {parent.ref}
        </p>
      )}
      <p className="mt-1 text-sm text-ink-soft">
        {parent.planningRole === "context"
          ? "Parent context · excluded from active planning counts"
          : "Parent stays in planning until adoption"}
        {parent.estimate &&
          ` · Previous estimate ${faceOf(parent.estimate)} (never a child rollup)`}
      </p>
      {parent.id !== env.state.currentStoryId && parent.notes && (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-soft">
          {parent.notes}
        </p>
      )}
      {parent.coverage === "needs-review" && (
        <p className="mt-2 text-sm font-semibold">Coverage needs review</p>
      )}
      <p className="mt-3 text-sm">
        {parent.planningRole === "context"
          ? `${planning.length} independent planning stories`
          : `${proposed.length} proposed children · counts unchanged`}
        {parent.planningRole === "context" &&
          ` · ${planning.filter((s) => !s.estimate).length} Unestimated`}
        {planning.some((s) => s.estimateNeedsReview) &&
          ` · ${planning.filter((s) => s.estimateNeedsReview).length} Needs review`}
      </p>
      {parent.planningRole === "context" && proposed.length > 0 && (
        <p className="mt-1 text-sm text-ink-soft">
          {proposed.length} proposed{" "}
          {proposed.length === 1 ? "child" : "children"} · not counted until
          adoption
        </p>
      )}
      <ul
        aria-labelledby={heading}
        className="mt-3 space-y-2 border-l-2 border-line pl-[12px]"
      >
        {children.map((s) => {
          const blockers = (env.state.dependencies ?? []).filter(
            (d) => !d.retiredAt && d.dependentId === s.id,
          );
          const dependents = (env.state.dependencies ?? []).filter((d) => !d.retiredAt && d.blockerId === s.id);
          return (
            <li
              key={s.id}
              id={`story-row-${s.id}`}
              tabIndex={-1}
              className="min-w-0 rounded-chip border border-line p-[8px] sm:p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className={
                    "min-h-[44px] w-full min-w-0 break-words text-left font-semibold text-ink hover:text-accent"
                  }
                  aria-label={`${expanded === s.id ? "Collapse" : "Expand"} ${s.title}`}
                  disabled={editing}
                  aria-expanded={expanded === s.id}
                  onClick={() => {
                    if (editing) return;
                    setExpanded(expanded === s.id ? null : s.id);
                  }}
                >
                  {s.title}
                </button>
                <span className="text-sm text-ink-soft">
                  {s.removedAt
                    ? "Removed"
                    : s.planningRole === "proposed"
                      ? "Proposed"
                      : "Planning"}
                  {s.id === env.state.currentStoryId ? " · Active child" : ""}
                </span>
              </div>
              <p className="break-words text-sm">
                {s.estimateNeedsReview
                  ? `Needs review · previous ${s.estimate}`
                  : s.estimate
                    ? `${faceOf(s.estimate)} · ${s.estimateProvenance === "facilitator-set" ? "Facilitator-set" : s.estimateProvenance === "poker" ? "Poker" : "Historical"}`
                    : "Unestimated"}
                {s.isRemainder && " · Remaining scope"}
              </p>
              <p className="break-words text-sm text-ink-soft">
                {s.ref
                  ? `Retained key ${s.ref} · Remote status not checked`
                  : "Local only"}
              {blockers.length > 0 && <svg aria-hidden="true" className="ml-1 inline h-4 w-4 text-ink-soft" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" /></svg>}
                {blockers.length > 0 &&
                  ` · Blocked by ${blockers.length} ${blockers.length === 1 ? "story" : "stories"}${blockers.some((d) => dependencyNeedsReview(d, children)) ? " · Needs review" : ""}`}
              </p>
              {dependents.length > 0 && <p className="text-sm text-ink-soft">Blocks {dependents.map((d) => children.find((c) => c.id === d.dependentId)?.title || "Unavailable story").join(", ")}{dependents.some((d) => dependencyNeedsReview(d, children)) && " · Needs review"}</p>}
              {s.removedAt && (
                <button
                  className={quiet}
                  disabled={!canWrite || pending}
                  aria-label={`Undo removal of ${s.title}`}
                  onClick={() =>
                    void write(
                      "restore-child",
                      removeBody(s, parent, affected(s)),
                      () => {
                        setNotice(`${s.title} restored with the same identity`);
                        restoreFocus(addInput.current);
                      },
                    )
                  }
                >
                  Undo
                </button>
              )}
              {expanded === s.id && (
                <div className="mt-3 space-y-3">
                  {s.notes && (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {s.notes}
                    </p>
                  )}
                  <StoryDependencies
                    env={env}
                    parent={parent}
                    story={s}
                    canWrite={canWrite && !pending}
                    locked={editing}
                    setEditing={setEditing}
                    refresh={refresh}
                    onReveal={(id) => {
                      setExpanded(id);
                      window.setTimeout(() => document.getElementById(`story-row-${id}`)?.focus(), 0);
                    }}
                  />
                  {!s.removedAt && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={quiet}
                        disabled={!canWrite || pending || editing}
                        aria-label={`Quick refine ${s.title}`}
                        onClick={(e) => {
                          setError("");
                          setAdoption(null);
                          setRemove(null);
                          setEditing(true);
                          setEditor({
                            story: s,
                            title: s.title,
                            notes: s.notes,
                            currentId: env.state.currentStoryId,
                            round: env.state.roundVersion,
                            trigger: e.currentTarget,
                          });
                        }}
                      >
                        Quick refine
                      </button>
                      <button
                        className={quiet}
                        disabled={
                          !canWrite ||
                          pending ||
                          editing ||
                          s.planningRole !== "planning"
                        }
                        aria-label={`Set estimate for ${s.title}`}
                        onClick={() => onSetEstimate(s)}
                      >
                        Set estimate
                      </button>
                      <button
                        className={primary}
                        disabled={
                          !canWrite ||
                          pending ||
                          editing ||
                          s.planningRole !== "planning"
                        }
                        aria-label={`Deal ${s.title}`}
                        onClick={() => onDeal(s)}
                      >
                        Deal
                      </button>
                      <button
                        className={buttonDanger + " min-h-[44px]"}
                        disabled={!canWrite || pending || editing}
                        aria-label={`Remove ${s.title}`}
                        onClick={(e) => {
                          setEditor(null);
                          setAdoption(null);
                          setError("");
                          setRemove({
                            story: s,
                            parent,
                            trigger: e.currentTarget,
                            dependencies: affected(s),
                          });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  {editor?.story.id === s.id && (
                    <div className="space-y-3 border-t border-line pt-3">
                      <label className="block text-sm">
                        Title for {s.title}
                        <input
                          className={inputClass + " mt-1 min-h-[44px]"}
                          maxLength={200}
                          readOnly={pending}
                          value={editor.title}
                          onChange={(e) =>
                            setEditor({ ...editor, title: e.target.value })
                          }
                        />
                      </label>
                      <p className="text-right text-xs text-ink-soft">
                        {editor.title.length}/200
                      </p>
                      <label className="block text-sm">
                        Notes for {s.title}
                        <textarea
                          className={inputClass + " mt-1 min-h-[88px]"}
                          rows={4}
                          maxLength={2000}
                          readOnly={pending}
                          value={editor.notes}
                          onChange={(e) =>
                            setEditor({ ...editor, notes: e.target.value })
                          }
                        />
                      </label>
                      <p className="text-right text-xs text-ink-soft">
                        {editor.notes.length}/2000 · Optional
                      </p>
                      <p className="text-sm text-ink-soft">
                        Scope changes mark prior estimates Needs review.
                        {editor.currentId === s.id &&
                          " Saving restarts this active child's round and clears its votes."}
                      </p>
                      {conflict && (
                        <div className="space-y-2 break-words text-sm">
                          <p>
                            Latest: {latest?.title} · {latest?.notes}
                          </p>
                          <p className="whitespace-pre-wrap">
                            Mine: {editor.title} · {editor.notes}
                          </p>
                          <p>Review both versions before saving.</p>
                          <button
                            className={quiet}
                            onClick={() =>
                              latest &&
                              setEditor({
                                ...editor,
                                story: latest,
                                currentId: env.state.currentStoryId,
                                round: env.state.roundVersion,
                              })
                            }
                          >
                            Keep mine against latest for {s.title}
                          </button>
                          <button
                            className={quiet}
                            onClick={() =>
                              latest &&
                              setEditor({
                                ...editor,
                                story: latest,
                                title: latest.title,
                                notes: latest.notes,
                                currentId: env.state.currentStoryId,
                                round: env.state.roundVersion,
                              })
                            }
                          >
                            Use latest for {s.title}
                          </button>
                        </div>
                      )}
                      <TreeError message={errorAt === "story" ? error : ""} />
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={quiet}
                          disabled={pending}
                          onClick={closeEditor}
                        >
                          Cancel refinement for {s.title}
                        </button>
                        <button
                          className={primary}
                          disabled={
                            !canWrite ||
                            pending ||
                            conflict ||
                            !editor.title.trim()
                          }
                          onClick={() =>
                            void write(
                              "story",
                              {
                                storyId: s.id,
                                title: editor.title,
                                notes: editor.notes,
                                expectedRevision:
                                  editor.story.contentRevision ?? 0,
                                scopeRestart: editor.currentId === s.id,
                                expectedCurrentStoryId: editor.currentId ?? "",
                                expectedRoundVersion: editor.round,
                              },
                              () => {
                                closeEditor();
                                setNotice(`${s.title} refinement saved`);
                              },
                            )
                          }
                        >
                          Save refinement for {s.title}
                          {editor.currentId === s.id && " and restart round"}
                        </button>
                      </div>
                    </div>
                  )}
                  {remove?.story.id === s.id && (
                    <div className="space-y-3 border-t border-line pt-3">
                      <p className="text-sm">
                        Remove {s.title} from planning? Its identity and
                        published key stay here. {remove.dependencies.length}{" "}
                        affected planning links remain visible for review. Undo
                        validates their restoration.
                      </p>
                      <ul className="space-y-1 text-sm" aria-label="Affected dependencies">
                        {(env.state.dependencies ?? []).filter((d) => remove.dependencies.includes(d.id)).map((d) => <li key={d.id}>{storyIdentity(children.find((c) => c.id === d.dependentId), d.dependentId)} is blocked by {storyIdentity(children.find((c) => c.id === d.blockerId), d.blockerId)} · Needs review after removal</li>)}
                      </ul>
                      <TreeError
                        message={errorAt === "remove-child" ? error : ""}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={quiet}
                          disabled={pending}
                          onClick={() => {
                            remove.trigger.focus();
                            setRemove(null);
                          }}
                        >
                          Keep {s.title}
                        </button>
                        <button
                          className={buttonDanger + " min-h-[44px]"}
                          disabled={!canWrite || pending}
                          onClick={() =>
                            void write(
                              "remove-child",
                              removeBody(
                                remove.story,
                                remove.parent,
                                remove.dependencies,
                              ),
                              () => {
                                setRemove(null);
                                setNotice(
                                  `${s.title} removed · Undo available`,
                                );
                                restoreFocus(addInput.current);
                              },
                            )
                          }
                        >
                          Confirm removal of {s.title}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 space-y-2">
        <label className="block text-sm">
          New story title for {parent.title}
          <input
            ref={addInput}
            className={inputClass + " mt-1 min-h-[44px]"}
            maxLength={200}
            value={title}
            disabled={pending || unknown || operation !== null}
            onChange={(e) => {
              retainRoot(parent.id, e.target.value.length > 0);
              setOperation(null);
              setTitle(e.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (
                  e.nativeEvent.isComposing ||
                  e.keyCode === 229 ||
                  composing.current
                )
                  return;
                e.preventDefault();
                void create();
              }
            }}
          />
        </label>
        <p className="text-right text-xs text-ink-soft">
          {title.length}/200 · Title is all you need
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={primary}
            disabled={!canWrite || pending || unknown || !title.trim()}
            aria-label={`Add story to ${parent.title}`}
            onClick={() => void create()}
          >
            Add story
          </button>
          {unknown && (
            <button
              className={quiet}
              disabled={status !== "live" || pending}
              onClick={() => void reconcile()}
            >
              Check saved story for {parent.title}
            </button>
          )}
          <button
            className={quiet}
            disabled={!canWrite || pending || editing || active.length < 2}
            aria-label={`Use these stories for ${parent.title}`}
            onClick={reviewAdoption}
          >
            Use these stories
          </button>
        </div>
      </div>
      {adoption && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <h3 className="font-semibold">Review coverage</h3>
          <p className="text-sm">
            Parent becomes context, excluded from active counts.{" "}
            {adoption.children.length} independent planning stories replace it;
            estimates stay independent, with blanks Unestimated. No sum or
            consensus is required.
          </p>
          <p className="text-sm">
            Parent voting stops if it is active. Its earlier votes and estimate
            stay in history; adoption never deals a child.
          </p>
          <fieldset className="space-y-2">
            <legend className="text-sm">
              Does this cover the parent's scope?
            </legend>
            <label className="flex min-h-[44px] items-center gap-2 text-sm">
              <input
                type="radio"
                name={`coverage-${heading}`}
                checked={coverage === "full"}
                onChange={() => setCoverage("full")}
              />
              These stories cover the full scope
            </label>
            <label className="flex min-h-[44px] items-center gap-2 text-sm">
              <input
                type="radio"
                name={`coverage-${heading}`}
                checked={coverage === "remainder"}
                onChange={() => setCoverage("remainder")}
              />
              Scope remains · name a remainder child
            </label>
          </fieldset>
          {coverage === "remainder" && (
            <label className="block text-sm">
              Remainder story for {parent.title}
              <select
                className={inputClass + " mt-1 min-h-[44px]"}
                value={remainder}
                onChange={(e) => setRemainder(e.target.value)}
              >
                <option value="">Choose remaining scope</option>
                {adoption.children.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {adoptionConflict && (
            <p className="text-sm">
              Latest stories changed. Cancel and review coverage again; your
              choice remains visible. Mine:{" "}
              {adoption.children.map((c) => c.title).join(", ")}. Latest:{" "}
              {active.map((c) => c.title).join(", ")}.
            </p>
          )}
          <TreeError message={errorAt === "adopt" ? error : ""} />
          <div className="flex flex-wrap gap-2">
            <button
              className={quiet}
              disabled={pending}
              onClick={cancelAdoption}
            >
              Cancel adoption for {parent.title}
            </button>
            <button
              className={primary}
              disabled={
                !canWrite ||
                pending ||
                adoptionConflict ||
                (coverage === "remainder" && !remainder)
              }
              onClick={() =>
                void write(
                  "adopt",
                  {
                    parentId: parent.id,
                    expectedRevision: adoption.parent.contentRevision ?? 0,
                    expectedSplitRevision: adoption.parent.splitRevision ?? 0,
                    children: childRevisions(adoption.children),
                    coverage,
                    ...(coverage === "remainder"
                      ? { remainderId: remainder }
                      : {}),
                    switchToChildren: true,
                    expectedCurrentStoryId: adoption.currentId ?? "",
                    expectedRoundVersion: adoption.round,
                  },
                  () => {
                    cancelAdoption();
                    setNotice(
                      "Split saved · Parent context; children plan independently",
                    );
                  },
                )
              }
            >
              Confirm use of these stories for {parent.title}
            </button>
          </div>
        </div>
      )}
      <TreeError
        message={
          ["story", "adopt", "remove-child"].includes(errorAt) ? "" : error
        }
      />
      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 break-words text-sm text-ink-soft"
        >
          {notice}
        </p>
      )}
    </div>
  );
}

function TreeError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="mt-3 break-words text-sm text-stop">
      {message}
    </p>
  ) : null;
}
