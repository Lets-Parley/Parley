import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoryTree } from "./StoryTree";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { action, api, ApiError, type DependencyProposal, type Envelope, type PlanningDependency, type Story } from "../lib/api";
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), action: vi.fn(), api: vi.fn() }));
const parent: Story = { id: "parent", title: "Project", notes: "", ref: "", estimate: "13", position: 0, status: "pending", votedUserIds: [], contentRevision: 1, dependencyRevision: 1, planningRole: "context" };
const child = (id: string, estimate: string | null = null): Story => ({ ...parent, id, title: id, parentId: parent.id, estimate, planningRole: "planning" });
const edge = (blockerId: string, dependentId = "UI", extra = {}): PlanningDependency => ({ id: `${blockerId}-${dependentId}`, parentId: parent.id, blockerId, dependentId, reviewState: "planning", retiredAt: null, ...extra });
function env(stories = [parent, child("API", "3"), child("UI", "5"), child("Permissions")], dependencies: PlanningDependency[] = []): Envelope {
  return { id: "session", version: 1, endedAt: null, state: { stories, dependencies, currentStoryId: "UI", roundVersion: 4, deck: { name: "fib", values: ["3", "5"], ordinal: true }, autoReveal: false, openVoting: false } } as Envelope;
}
const props = (envelope = env()) => ({ env: envelope, canEdit: true, status: "live" as const, onDeal: vi.fn(), onSetEstimate: vi.fn() });
afterEach(() => vi.resetAllMocks());
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Expand UI" }));
  await user.click(screen.getByRole("button", { name: "Edit Blocked by for UI" }));
}
it("saves multiple siblings, reopens and removes with estimates and shared selection unchanged", async () => {
  const user = userEvent.setup(); const p = props(); let saved = p.env;
  vi.mocked(action).mockImplementation(async (_, name, body) => {
    expect(name).toBe("dependencies"); const b = body as DependencyProposal;
    saved = { ...saved, version: saved.version + 1, state: { ...saved.state, dependencies: b.edges.map((e) => edge(e.blockerId, e.dependentId)), stories: saved.state.stories.map((s) => s.id === parent.id ? { ...s, dependencyRevision: (s.dependencyRevision ?? 0) + 1 } : s) } }; return {};
  });
  vi.mocked(api).mockImplementation(async () => saved);
  renderApp(<StoryTree {...p} />); await open(user);
  expect(screen.queryByRole("checkbox", { name: /^UI/ })).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  await user.click(screen.getByRole("checkbox", { name: "Permissions · ID Permissions" }));
  expect(screen.getByText("UI is blocked by API")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" }));
  await screen.findByText("Dependencies saved");
  expect(screen.getByText(/Blocked by 2 stories/)).toBeTruthy();
  expect(vi.mocked(action).mock.calls[0][2]).toEqual({ parentId: "parent", expectedRevision: 1, expectedDependencyRevision: 1, children: { API: 1, UI: 1, Permissions: 1 }, edges: [{ blockerId: "API", dependentId: "UI" }, { blockerId: "Permissions", dependentId: "UI" }], retireIds: [] });
  await user.click(screen.getByRole("button", { name: "Edit Blocked by for UI" }));
  expect((screen.getByRole("checkbox", { name: "API · ID API" }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  expect(screen.getByText("Remove: UI is blocked by API")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  expect(saved.state.stories.slice(1).map((s) => [s.estimate, s.parentId])).toEqual([["3", "parent"], ["5", "parent"], [null, "parent"]]);
  expect(saved.state.currentStoryId).toBe("UI"); expect(saved.state.roundVersion).toBe(4);
  expect(p.onDeal).not.toHaveBeenCalled(); expect(p.onSetEstimate).not.toHaveBeenCalled();
});
it("Escape restores focus and reciprocal navigation expands locally without Deal", async () => {
  const user = userEvent.setup(); const p = props(env(undefined, [edge("API")]));
  renderApp(<StoryTree {...p} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  fireEvent.keyDown(screen.getByRole("checkbox", { name: "API · ID API" }), { key: "Escape" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Blocked by for UI" })));
  await user.click(screen.getByRole("button", { name: "Show blocker API · ID API" }));
  expect(screen.getByRole("button", { name: "Collapse API" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show dependent UI · ID UI" })).toBeTruthy();
  expect(p.onDeal).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
});
it("distinguishes duplicate titles and requires direction reversal review", async () => {
  const user = userEvent.setup();
  renderApp(<StoryTree {...props(env([parent, { ...child("a"), title: "Same" }, { ...child("b"), title: "Same" }, child("UI")], [edge("UI", "a")]))} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "Same · ID a" }));
  expect(screen.getByRole("checkbox", { name: "Same · ID b" })).toBeTruthy();
  expect(screen.getByText("UI is blocked by Same · ID a")).toBeTruthy();
  expect(screen.getByText(/Remove reverse link: Same · ID a is blocked by UI/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save dependencies for UI" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: /I reviewed the direction reversal/ }));
  vi.mocked(action).mockResolvedValue({}); vi.mocked(api).mockResolvedValue({ ...env(), version: 2 });
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" }));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ edges: [{ blockerId: "a", dependentId: "UI" }], retireIds: ["UI-a"] });
});
it.each(["dependency cycle: API → UI → Permissions → API", "split revision conflict; review latest graph and content", "dependency endpoint is not an active sibling"])("retains choices after rejection: %s", async (reason) => {
  const user = userEvent.setup(); const p = props();
  vi.mocked(action).mockRejectedValue(new ApiError(409, reason));
  vi.mocked(api).mockResolvedValue({ ...p.env, version: 2, state: { ...p.env.state, stories: p.env.state.stories.map((s) => s.id === "API" ? { ...s, title: "Renamed API", contentRevision: 2 } : s) } });
  renderApp(<StoryTree {...p} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" })); await screen.findByText(reason);
  expect((screen.getByRole("checkbox", { name: "Renamed API · ID API" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Latest graph or content changed/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save dependencies for UI" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Review latest graph and keep choices for UI" }));
  expect((screen.getByRole("button", { name: "Save dependencies for UI" }) as HTMLButtonElement).disabled).toBe(false);
});
it("preserves removed and unavailable links as review-needed until explicitly retired", async () => {
  const user = userEvent.setup(); const p = props(env([parent, { ...child("API"), removedAt: "today" }, child("UI")], [edge("API", "UI", { reviewState: "blocker-removed-review" }), edge("missing", "UI", { reviewState: "review-needed" })]));
  vi.mocked(action).mockResolvedValue({}); vi.mocked(api).mockResolvedValue({ ...p.env, version: 2 });
  renderApp(<StoryTree {...p} />); await open(user);
  expect(screen.getAllByText(/Needs review/).length).toBeGreaterThan(0); expect(screen.queryByText(/Ready|unblocked/i)).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: /API · ID API.*Removed/ }));
  await user.click(screen.getByRole("checkbox", { name: /Unavailable story · ID missing/ }));
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" }));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ edges: [], retireIds: ["API-UI", "missing-UI"] });
});
it("passes axe, pauses drafts on authority loss and redacts revoked access", async () => {
  const user = userEvent.setup(); const p = props(); const view = renderApp(<StoryTree {...p} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" })); await expectNoViolations(view.container);
  view.rerender(<StoryTree {...p} canEdit={false} status="reconnecting" />);
  expect((screen.getByRole("checkbox", { name: "API · ID API" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Save dependencies for UI" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<StoryTree {...p} status="removed" />); expect(screen.queryByRole("checkbox")).toBeNull();
});
it("preserves other dependents and refuses a newly unavailable selection until reviewed and removed", async () => {
  const user = userEvent.setup(); const p = props(env(undefined, [edge("API", "Permissions")]));
  const view = renderApp(<StoryTree {...p} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  view.rerender(<StoryTree {...p} env={{ ...p.env, version: 2, state: { ...p.env.state, stories: p.env.state.stories.filter((s) => s.id !== "API") } }} />);
  await user.click(screen.getByRole("button", { name: "Review latest graph and keep choices for UI" }));
  expect((screen.getByRole("button", { name: "Save dependencies for UI" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Selected sibling unavailable; remove/)).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
});
it("saves the full graph without dropping an unrelated dependent", async () => {
  const user = userEvent.setup(); const p = props(env(undefined, [edge("API", "Permissions")]));
  vi.mocked(action).mockResolvedValue({}); vi.mocked(api).mockResolvedValue(p.env);
  renderApp(<StoryTree {...p} />); await open(user);
  await user.click(screen.getByRole("checkbox", { name: "API · ID API" }));
  await user.click(screen.getByRole("button", { name: "Save dependencies for UI" }));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ edges: [{ blockerId: "API", dependentId: "Permissions" }, { blockerId: "API", dependentId: "UI" }] });
});
it("keeps the focused sibling label above the fixed voting hand", async () => {
  const user = userEvent.setup(); let offset = 0;
  const tray = document.createElement("div"); tray.dataset.pokerHand = ""; tray.style.position = "fixed"; document.body.append(tray);
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this === tray ? new DOMRect(0, 540, 320, 220) : this.tagName === "LABEL" ? new DOMRect(0, 500 - offset, 200, 80) : new DOMRect();
  });
  const scroll = vi.spyOn(window, "scrollBy").mockImplementation(((options: ScrollToOptions | number) => { if (typeof options === "object") offset += options.top ?? 0; }) as typeof window.scrollBy);
  try {
    renderApp(<StoryTree {...props()} />); await open(user);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("INPUT"));
    const label = document.activeElement!.closest("label")!;
    expect(label.getBoundingClientRect().bottom).toBeLessThan(tray.getBoundingClientRect().top);
  } finally { geometry.mockRestore(); scroll.mockRestore(); tray.remove(); }
});
