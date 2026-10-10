import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoryTree } from "./StoryTree";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { action, api, ApiError, type Envelope, type Story } from "../lib/api";
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  action: vi.fn(),
  api: vi.fn(),
}));
const parent: Story = {
  id: "parent",
  title: "Parent",
  notes: "Parent notes",
  ref: "PAR-1",
  estimate: "13",
  position: 0,
  status: "pending",
  votedUserIds: [],
  contentRevision: 1,
  splitRevision: 2,
  dependencyRevision: 0,
};
const child = (id: string): Story => ({
  ...parent,
  id,
  parentId: "parent",
  title: id,
  notes: "",
  ref: "",
  estimate: null,
  planningRole: "proposed",
  position: 1,
});
function env(stories = [parent, child("API"), child("UI")]): Envelope {
  return {
    id: "session",
    version: 1,
    endedAt: null,
    state: {
      stories,
      currentStoryId: "parent",
      roundVersion: 4,
      deck: { name: "fib", values: ["1", "3", "5"], ordinal: true },
      autoReveal: false,
      openVoting: false,
    },
  } as Envelope;
}
function props(envelope = env()) {
  return {
    env: envelope,
    canEdit: true,
    status: "live" as const,
    onDeal: vi.fn(),
    onSetEstimate: vi.fn(),
  };
}
afterEach(() => {
  vi.resetAllMocks();
});
it("creates three title-only children with Enter/Add, ignoring blank, composition and repeat activation", async () => {
  const user = userEvent.setup();
  let stories = [parent];
  let version = 1;
  vi.mocked(api).mockImplementation(async () => ({ ...env(stories), version }));
  vi.mocked(action).mockImplementation(async (_id, _name, body) => {
    const b = body as { title: string; operationId: string };
    stories = [
      ...stories,
      { ...child(b.title), creationOperation: b.operationId },
    ];
    version++;
    return {};
  });
  renderApp(<StoryTree {...props(env([parent]))} />);
  const input = screen.getByRole("textbox", {
    name: "New story title for Parent",
  });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  await user.type(input, "API");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(action).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  await user.type(input, "UI{Enter}");
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  await user.type(input, "Tests");
  await user.click(screen.getByRole("button", { name: "Add story to Parent" }));
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  expect(action).toHaveBeenCalledTimes(3);
  expect(
    new Set(
      vi
        .mocked(action)
        .mock.calls.map((c) => (c[2] as { operationId: string }).operationId),
    ).size,
  ).toBe(3);
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({
    title: "API",
    parentId: "parent",
    notes: "",
  });
});
it("reconciles a lost acknowledgment before retry and retains title while outcome is unknown", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new TypeError("lost response"));
  vi.mocked(api).mockRejectedValue(new TypeError("offline"));
  renderApp(<StoryTree {...props(env([parent]))} />);
  const input = screen.getByRole("textbox", { name: /New story title/ });
  await user.type(input, "API{Enter}");
  await screen.findByText(/Outcome unknown/);
  expect((input as HTMLInputElement).value).toBe("API");
  expect(action).toHaveBeenCalledTimes(1);
  const operation = (
    vi.mocked(action).mock.calls[0][2] as { operationId: string }
  ).operationId;
  vi.mocked(api).mockResolvedValue({
    ...env([parent, { ...child("API"), creationOperation: operation }]),
    version: 2,
  });
  await user.click(screen.getByRole("button", { name: /Check saved story/ }));
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  expect(action).toHaveBeenCalledTimes(1);
});
it("keeps multiline drafts on blur and remote updates, shows latest/mine, and restores focus on Escape", async () => {
  const user = userEvent.setup();
  const p = props();
  const view = renderApp(<StoryTree {...p} />);
  await user.click(screen.getByRole("button", { name: "Expand API" }));
  expect(p.onDeal).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Quick refine API" }));
  const notes = screen.getByRole("textbox", { name: "Notes for API" });
  await user.type(notes, "Mine{Enter}second line");
  await user.tab();
  expect(action).not.toHaveBeenCalled();
  const latest = {
    ...child("API"),
    notes: "Latest remote",
    contentRevision: 2,
  };
  view.rerender(
    <StoryTree
      {...p}
      env={{ ...env([parent, latest, child("UI")]), version: 2 }}
    />,
  );
  expect((notes as HTMLTextAreaElement).value).toBe("Mine\nsecond line");
  expect(screen.getByText(/Latest: API/)).toBeTruthy();
  expect(screen.getByText(/Mine:/)).toBeTruthy();
  fireEvent.keyDown(notes, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Notes for API" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Quick refine API" }),
    ),
  );
});
it("reviews coverage and counting before atomic adoption, cancellation sends no action", async () => {
  const user = userEvent.setup();
  const p = props();
  renderApp(<StoryTree {...p} />);
  await user.click(
    screen.getByRole("button", { name: "Use these stories for Parent" }),
  );
  expect(screen.getByText(/Parent becomes context/)).toBeTruthy();
  expect(screen.getByText(/2 independent planning/)).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Cancel adoption for Parent" }),
  );
  expect(action).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Use these stories for Parent" }),
  );
  await user.click(screen.getByRole("radio", { name: /Scope remains/ }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Remainder story for Parent" }),
    "UI",
  );
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...env(), version: 2 });
  await user.click(
    screen.getByRole("button", {
      name: "Confirm use of these stories for Parent",
    }),
  );
  expect(action).toHaveBeenCalledWith(
    "session",
    "adopt",
    expect.objectContaining({
      parentId: "parent",
      coverage: "remainder",
      remainderId: "UI",
      children: { API: 1, UI: 1 },
      switchToChildren: true,
      expectedRoundVersion: 4,
      expectedCurrentStoryId: "parent",
    }),
  );
});
it("pauses writes on reconnect/role loss, preserves drafts, and redacts revoked reading access", async () => {
  const user = userEvent.setup();
  const p = props();
  const view = renderApp(<StoryTree {...p} />);
  await user.click(screen.getByRole("button", { name: "Expand API" }));
  await user.click(screen.getByRole("button", { name: "Quick refine API" }));
  await user.type(
    screen.getByRole("textbox", { name: "Notes for API" }),
    "private draft",
  );
  view.rerender(<StoryTree {...p} canEdit={false} status="reconnecting" />);
  expect(
    (
      screen.getByRole("button", {
        name: /Save refinement/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByDisplayValue("private draft")).toBeTruthy();
  view.rerender(<StoryTree {...p} status="removed" />);
  expect(screen.queryByText("Parent")).toBeNull();
  expect(screen.queryByDisplayValue("private draft")).toBeNull();
});
it("retains quota-refused input and removed child identity/reference with Undo", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new ApiError(409, "child cap reached"));
  renderApp(
    <StoryTree
      {...props(
        env([parent, { ...child("API"), removedAt: "today", ref: "UP-42" }]),
      )}
    />,
  );
  const input = screen.getByRole("textbox", { name: /New story title/ });
  await user.type(input, "Typed{Enter}");
  await screen.findByText("child cap reached");
  expect((input as HTMLInputElement).value).toBe("Typed");
  expect(screen.getByText(/UP-42/)).toBeTruthy();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...env(), version: 2 });
  await user.click(screen.getByRole("button", { name: "Undo removal of API" }));
  expect(action).toHaveBeenLastCalledWith(
    "session",
    "restore-child",
    expect.objectContaining({ storyId: "API", expectedRevision: 1 }),
  );
});
it("uses a nested semantic list and labeled native controls without axe violations", async () => {
  const view = renderApp(<StoryTree {...props()} />);
  expect(screen.getAllByRole("list").length).toBeGreaterThanOrEqual(2);
  await expectNoViolations(view.container);
});

it("saves multiline refinement explicitly against the active round snapshot", async () => {
  const user = userEvent.setup();
  const current = child("API");
  const p = props({
    ...env(),
    state: {
      ...env().state,
      currentStoryId: "API",
      stories: [parent, current, child("UI")],
    },
  });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...p.env, version: 2 });
  renderApp(<StoryTree {...p} />);
  await user.click(screen.getByRole("button", { name: "Expand API" }));
  await user.click(screen.getByRole("button", { name: "Quick refine API" }));
  await user.type(
    screen.getByRole("textbox", { name: "Notes for API" }),
    "First{Enter}second",
  );
  await user.click(
    screen.getByRole("button", {
      name: "Save refinement for API and restart round",
    }),
  );
  expect(action).toHaveBeenCalledWith(
    "session",
    "story",
    expect.objectContaining({
      storyId: "API",
      notes: "First\nsecond",
      scopeRestart: true,
      expectedRevision: 1,
      expectedCurrentStoryId: "API",
      expectedRoundVersion: 4,
    }),
  );
});
it("refreshes authority on reconnect and keeps the local draft when facilitation changed", async () => {
  const user = userEvent.setup();
  const p = props({ ...env(), facilitatorId: "old" });
  const view = renderApp(<StoryTree {...p} />);
  await user.type(
    screen.getByRole("textbox", { name: /New story title/ }),
    "My draft",
  );
  view.rerender(<StoryTree {...p} status="reconnecting" />);
  vi.mocked(api).mockResolvedValue({
    ...p.env,
    version: 2,
    facilitatorId: "new",
  });
  view.rerender(<StoryTree {...p} status="live" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(
    (
      screen.getByRole("button", {
        name: "Add story to Parent",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByDisplayValue("My draft")).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
});
it("keeps an unknown creation identity stable when refreshed absence permits retry", async () => {
  const user = userEvent.setup();
  const p = props(env([parent]));
  vi.mocked(action)
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValue({});
  vi.mocked(api).mockResolvedValue(p.env);
  renderApp(<StoryTree {...p} />);
  await user.type(
    screen.getByRole("textbox", { name: /New story title/ }),
    "API{Enter}",
  );
  await screen.findByText(/Retry uses the same identity/);
  expect(
    (
      screen.getByRole("textbox", {
        name: /New story title/,
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Add story to Parent" }));
  expect(action).toHaveBeenCalledTimes(2);
  expect(vi.mocked(action).mock.calls[0][1]).toBe("child");
  expect(
    (vi.mocked(action).mock.calls[0][2] as { operationId: string }).operationId,
  ).toBe(
    (vi.mocked(action).mock.calls[1][2] as { operationId: string }).operationId,
  );
});
it("confirms removal with affected links and returns focus to the surviving add control", async () => {
  const user = userEvent.setup();
  const p = props();
  p.env.state.dependencies = [
    {
      id: "edge",
      parentId: "parent",
      blockerId: "API",
      dependentId: "UI",
      reviewState: "planning",
      retiredAt: null,
    },
  ];
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({
    ...env([parent, { ...child("API"), removedAt: "today" }, child("UI")]),
    version: 2,
  });
  renderApp(<StoryTree {...p} />);
  await user.click(screen.getByRole("button", { name: "Expand API" }));
  await user.click(screen.getByRole("button", { name: "Remove API" }));
  expect(action).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Confirm removal of API" }),
  );
  expect(action).toHaveBeenCalledWith(
    "session",
    "remove-child",
    expect.objectContaining({
      storyId: "API",
      affectedDependencies: ["edge"],
      expectedDependencyRevision: 0,
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Undo removal of API" }),
    ).toBeTruthy(),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: /New story title/ }),
  );
});
it("keeps ended-room trees readable while refusing writes and naming the normal reopen path", async () => {
  renderApp(<StoryTree {...props({ ...env(), endedAt: "today" })} />);
  expect(screen.getByText(/Reopen it using the room controls/)).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Use these stories for Parent",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(action).not.toHaveBeenCalled();
});
