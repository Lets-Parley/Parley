import { useRef, useState } from "react";
import { action, errorText, type DependencyProposal, type Envelope, type PlanningDependency, type Story } from "../lib/api";
import { storyIdentity, dependencyNeedsReview } from "../lib/pokerDependencies";
import { buttonPrimary, buttonQuiet, inputClass } from "./Modal";

const quiet = buttonQuiet + " min-h-[44px] min-w-0 max-w-full wrap-anywhere px-[12px]";
const primary = buttonPrimary + " min-h-[44px] min-w-0 max-w-full wrap-anywhere px-[12px]";
type Snapshot = { parent: Story; children: Story[] };

export function StoryDependencies({ env, parent, story, canWrite, locked, setEditing, refresh, onReveal }: {
  env: Envelope; parent: Story; story: Story; canWrite: boolean; locked: boolean;
  setEditing: (editing: boolean) => void; refresh: () => Promise<Envelope>;
  onReveal: (id: string) => void;
}) {
  const children = env.state.stories.filter((s) => s.parentId === parent.id);
  const edges = (env.state.dependencies ?? []).filter((d) => d.parentId === parent.id && !d.retiredAt);
  const incoming = edges.filter((d) => d.dependentId === story.id);
  const [draft, setDraft] = useState<{ base: Snapshot; selected: string[] } | null>(null);
  const [reversalAccepted, setReversalAccepted] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLInputElement>(null);
  const current = { parent, children };
  const conflict = draft && (parent.contentRevision !== draft.base.parent.contentRevision || parent.dependencyRevision !== draft.base.parent.dependencyRevision || children.length !== draft.base.children.length || children.some((s) => {
    const previous = draft.base.children.find((c) => c.id === s.id);
    return !previous || previous.contentRevision !== s.contentRevision || previous.removedAt !== s.removedAt;
  }));
  const reversals = draft ? edges.filter((d) => d.blockerId === story.id && draft.selected.includes(d.dependentId)) : [];
  const unavailableSelection = draft?.selected.some((id) => !children.some((c) => c.id === id && !c.removedAt) && !incoming.some((d) => d.blockerId === id));
  const candidates = draft ? [...new Set([...children.filter((c) => c.id !== story.id && !c.removedAt).map((c) => c.id), ...incoming.map((d) => d.blockerId), ...draft.selected])].filter((id) => id !== story.id) : [];
  const titleOf = (id: string) => {
    const sibling = children.find((c) => c.id === id);
    if (!sibling) return `Unavailable story · ID ${id}`;
    return children.filter((c) => c.title === sibling.title).length > 1
      ? storyIdentity(sibling, id)
      : sibling.title;
  };
  function close() {
    setDraft(null); setEditing(false); setError("");
    window.setTimeout(() => trigger.current?.focus(), 0);
  }
  async function save() {
    if (!draft || !canWrite || busy.current || conflict || unavailableSelection || (reversals.length > 0 && !reversalAccepted)) return;
    busy.current = true; setPending(true); setError("");
    // Unavailable links stay unresolved unless this editor explicitly removes them.
    const available = (id: string) => children.some((c) => c.id === id && !c.removedAt);
    const retireIds = edges.filter((d) => (d.dependentId === story.id && !draft.selected.includes(d.blockerId)) || reversals.some((r) => r.id === d.id)).map((d) => d.id);
    const proposed = edges.filter((d) => d.dependentId !== story.id && !retireIds.includes(d.id) && !dependencyNeedsReview(d, children)).map(({ blockerId, dependentId }) => ({ blockerId, dependentId }));
    for (const id of draft.selected) {
      const unresolved = incoming.find((d) => d.blockerId === id && dependencyNeedsReview(d, children));
      if (available(id) && !unresolved) proposed.push({ blockerId: id, dependentId: story.id });
    }
    const body: DependencyProposal = {
      parentId: parent.id, expectedRevision: draft.base.parent.contentRevision ?? 0,
      expectedDependencyRevision: draft.base.parent.dependencyRevision ?? 0,
      children: Object.fromEntries(draft.base.children.map((c) => [c.id, c.contentRevision ?? 0])),
      edges: proposed, retireIds,
    };
    try {
      await action(env.id, "dependencies", body);
      close(); setNotice("Dependencies saved");
      try { await refresh(); } catch { setNotice("Dependencies saved. Refresh the room before editing again."); }
    } catch (e) {
      setError(errorText(e));
      try { await refresh(); } catch { /* Reading authority is handled by the tree. */ }
    } finally { busy.current = false; setPending(false); }
  }
  return <div className="min-w-0 space-y-3" onFocusCapture={(e) => {
    const tray = document.querySelector<HTMLElement>("[data-poker-hand]");
    if (!tray || getComputedStyle(tray).position !== "fixed") return;
    const target = e.target.closest("label") ?? e.target;
    const overlap = target.getBoundingClientRect().bottom - tray.getBoundingClientRect().top;
    if (overlap > -16) window.scrollBy({ top: overlap + 16, behavior: "instant" });
  }} onKeyDown={(e) => {
    if (e.key === "Escape" && draft && !pending) { e.stopPropagation(); close(); }
  }}>
    {!story.removedAt && <button ref={trigger} className={quiet} disabled={!canWrite || pending || locked} aria-label={`Edit Blocked by for ${story.title}`} onClick={() => {
      setDraft({ base: current, selected: [...new Set(incoming.map((d) => d.blockerId))] });
      setEditing(true); setSearch(""); setError(""); setNotice(""); setReversalAccepted(false);
      window.setTimeout(() => firstChoice.current?.focus(), 0);
    }}>Blocked by</button>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {draft && <fieldset className="min-w-0 space-y-3 border-t border-line pt-3" disabled={pending || !canWrite}>
      <legend className="font-semibold">Blocked by siblings for {story.title}</legend>
      <p className="text-sm text-ink-soft">Planning dependency · Completion not checked. Estimates, votes and the active story stay unchanged.</p>
      {candidates.length > 6 && <label className="block text-sm">Search siblings
        <input className={inputClass + " mt-1 min-h-[44px]"} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>}
      <div className="space-y-1">
        {candidates.filter((id) => draft.selected.includes(id) || `${titleOf(id)} ${id}`.toLowerCase().includes(search.toLowerCase())).map((id, index) => {
          const candidate = children.find((c) => c.id === id);
          const unresolved = incoming.find((d) => d.blockerId === id && dependencyNeedsReview(d, children));
          return <label key={id} className="block min-h-[44px] min-w-0 cursor-pointer rounded-chip py-2 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
            <input ref={index === 0 ? firstChoice : undefined} type="checkbox" className="mr-2 inline-block h-5 w-5 align-middle accent-accent" checked={draft.selected.includes(id)} onChange={(e) => {
              setDraft({ ...draft, selected: e.target.checked ? [...draft.selected, id] : draft.selected.filter((s) => s !== id) }); setReversalAccepted(false);
            }} />
            <span className="wrap-anywhere">{candidate?.title || "Unavailable story"}{" "}<span className="block text-xs text-ink-soft"> · ID {id}</span>{candidate?.removedAt ? " · Removed · Needs review" : !candidate ? " · Needs review" : unresolved ? " · Needs review; retained until removed" : ""}</span>
          </label>;
        })}
      </div>
      <div className="space-y-2 text-sm" aria-label="Dependency preview">
        {draft.selected.map((id) => <p key={id}>{story.title} is blocked by {titleOf(id)}{incoming.some((d) => d.blockerId === id && dependencyNeedsReview(d, children)) ? " · Needs review; retained" : ""}</p>)}
        {!draft.selected.length && <p>No sibling dependencies recorded</p>}
        {incoming.filter((d) => !draft.selected.includes(d.blockerId)).map((d) => <p key={d.id}>Remove: {story.title} is blocked by {titleOf(d.blockerId)}</p>)}
        {reversals.map((d) => <p key={d.id}>Remove reverse link: {titleOf(d.dependentId)} is blocked by {story.title}. Add: {story.title} is blocked by {titleOf(d.dependentId)}.</p>)}
      </div>
      {reversals.length > 0 && <label className="flex min-h-[44px] items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={reversalAccepted} onChange={(e) => setReversalAccepted(e.target.checked)} />
        <span>I reviewed the direction reversal and the removal of the old links</span>
      </label>}
      {conflict && <div className="space-y-2 text-sm">
        <p>Latest graph or content changed. Review latest and mine before saving.</p>
        <p>Latest: {incoming.length ? incoming.map((d) => `${story.title} is blocked by ${titleOf(d.blockerId)}`).join("; ") : "No sibling dependencies recorded"}</p>
        <p>Mine: {draft.selected.length ? draft.selected.map((id) => storyIdentity(children.find((c) => c.id === id), id)).join("; ") : "No sibling dependencies recorded"}</p>
        <button className={quiet} aria-label={`Review latest graph and keep choices for ${story.title}`} onClick={() => { setDraft({ ...draft, base: current }); setReversalAccepted(false); setError(""); }}>Review latest and keep choices</button>
      </div>}
      {unavailableSelection && <p role="alert" className="text-sm">Selected sibling unavailable; remove it from your choices before saving. Existing unresolved links stay recorded until explicitly removed.</p>}
      {error && <p role="alert" className="break-words text-sm text-stop">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={primary} disabled={!canWrite || pending || Boolean(conflict) || unavailableSelection || (reversals.length > 0 && !reversalAccepted) || Boolean(story.removedAt)} aria-label={`Save dependencies for ${story.title}`} onClick={() => void save()}>{pending ? "Saving…" : "Save dependencies"}</button>
        <button className={quiet} aria-label={`Cancel dependencies for ${story.title}`} onClick={close}>Cancel</button>
      </div>
    </fieldset>}
    {!draft && <DependencyDetails edges={edges} story={story} siblings={children} locked={locked} onReveal={onReveal} />}
  </div>;
}

function DependencyDetails({ edges, story, siblings: children, locked, onReveal }: { edges: PlanningDependency[]; story: Story; siblings: Story[]; locked: boolean; onReveal: (id: string) => void }) {
  const related = edges.filter((d) => d.blockerId === story.id || d.dependentId === story.id);
  return <div className="space-y-2 text-sm">
    <p className="text-ink-soft">Planning dependency · Completion not checked</p>
    {!related.length && <p>No sibling dependencies recorded</p>}
    <ul className="space-y-1" aria-label={`Dependencies for ${story.title}`}>
      {related.map((d) => {
        const blocked = d.dependentId === story.id;
        const id = blocked ? d.blockerId : d.dependentId;
        const sibling = children.find((c) => c.id === id);
        return <li key={d.id} className="wrap-anywhere">
          {blocked ? "Blocked by" : "Blocks"}{" "}
          {sibling ? <button className={quiet} disabled={locked} aria-label={`Show ${blocked ? "blocker" : "dependent"} ${storyIdentity(sibling, id)}`} onClick={() => onReveal(id)}>{storyIdentity(sibling, id)}</button> : storyIdentity(undefined, id)}
          {dependencyNeedsReview(d, children) && " · Needs review"}
          {sibling?.removedAt && " · Removed"}
        </li>;
      })}
    </ul>
  </div>;
}
