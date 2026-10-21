import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { FanHarness } from "../test/FanHarness";
import { adoptedSplit, childStory, edge, parentStory, splitRoom } from "../test/splitFixtures";
import { action, api, ApiError, type Envelope, type Story } from "../lib/api";
import { SplitStrip } from "./StoryTree";
import { splitFanOf } from "../lib/splitFan";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  action: vi.fn(),
  api: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

const composer = () => screen.getByRole("textbox", { name: "Name a story, then press Enter" }) as HTMLInputElement;
const cards = () => within(screen.getByRole("list", { name: "Stories in this split" })).getAllByRole("listitem");
const cardOf = (title: string) => cards().find((card) => within(card).queryByText(title)) as HTMLElement;
const actionNames = () => vi.mocked(action).mock.calls.map((call) => call[1]);

function serveCreations(initial: Story[] = [parentStory]) {
  let stories = initial;
  let version = 1;
  vi.mocked(api).mockImplementation(async () => ({ ...splitRoom(stories), version }));
  vi.mocked(action).mockImplementation(async (_session, name, body) => {
    if (name === "leftover") {
      const flagged = (body as { storyId: string }).storyId;
      stories = stories.map((story) => (story.parentId ? { ...story, isRemainder: story.id === flagged } : story));
      version += 1;
      return {};
    }
    if (name !== "child") return {};
    const creation = body as { title: string; operationId: string };
    stories = [...stories, childStory(creation.title, { creationOperation: creation.operationId })];
    version += 1;
    return { storyId: creation.title, contentRevision: 1, splitRevision: 2 + stories.length };
  });
}

it("deals a card per Enter, keeps the input focused and empty, and ignores blank, composing and repeated Enters", async () => {
  const user = userEvent.setup();
  serveCreations();
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  const input = composer();
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  await user.type(input, "API");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(action).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe(""));
  expect(document.activeElement).toBe(input);
  await user.type(input, "UI{Enter}");
  await waitFor(() => expect(input.value).toBe(""));
  await user.type(input, "Tests");
  await user.click(screen.getByRole("button", { name: "Add story to Parent" }));
  await waitFor(() => expect(actionNames()).toEqual(["child", "child", "child"]));
  await waitFor(() => expect(cards().filter((card) => card.dataset.storyId).length).toBe(3));
  expect(input.value).toBe("");
  expect(new Set(vi.mocked(action).mock.calls.map((call) => (call[2] as { operationId: string }).operationId)).size).toBe(3);
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ title: "API", parentId: "parent", notes: "" });
  expect(cards().filter((card) => card.dataset.storyId).map((card) => card.dataset.storyId)).toEqual(["API", "UI", "Tests"]);
});

it("loses nothing typed while an earlier title is still on its way to the server", async () => {
  const user = userEvent.setup();
  let stories = [parentStory];
  const acknowledgments: (() => void)[] = [];
  vi.mocked(api).mockImplementation(async () => ({ ...splitRoom(stories), version: stories.length }));
  vi.mocked(action).mockImplementation(
    (_session, _name, body) =>
      new Promise((resolve) => {
        const creation = body as { title: string; operationId: string };
        acknowledgments.push(() => {
          stories = [...stories, childStory(creation.title, { creationOperation: creation.operationId })];
          resolve({ storyId: creation.title, contentRevision: 1, splitRevision: 1 + stories.length });
        });
      }),
  );
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  const input = composer();
  await user.type(input, "First{Enter}");
  expect(input.readOnly).toBe(false);
  expect(input.value).toBe("");
  await user.type(input, "Second{Enter}Thi");
  expect(input.value).toBe("Thi");
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Adding “First” · 1 more waiting")).toBeTruthy();
  expect(document.activeElement).toBe(input);
  acknowledgments[0]();
  await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  await user.type(input, "rd{Enter}");
  acknowledgments[1]();
  await waitFor(() => expect(action).toHaveBeenCalledTimes(3));
  acknowledgments[2]();
  await waitFor(() => expect(cards().filter((card) => card.dataset.storyId).map((card) => card.dataset.storyId)).toEqual(["First", "Second", "Third"]));
  expect(vi.mocked(action).mock.calls.map((call) => (call[2] as { title: string }).title)).toEqual(["First", "Second", "Third"]);
  expect(document.activeElement).toBe(input);
});

it("puts a refused title back in the input and keeps what was typed after it waiting", async () => {
  const user = userEvent.setup();
  let refuse: (problem: Error) => void = () => {};
  vi.mocked(action).mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  await user.type(composer(), "Too long a story{Enter}Next one");
  refuse(new ApiError(400, "title is too long"));
  await screen.findByText("title is too long");
  expect(composer().value).toBe("Too long a story");
  expect(composer().readOnly).toBe(false);
  expect(screen.getByText("1 more waiting")).toBeTruthy();
});

it("deals every line of a pasted list in order, each under its own identity", async () => {
  serveCreations();
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  fireEvent.paste(composer(), {
    clipboardData: { getData: () => "- Throttle per key\n2. Shared counter\n\n* 429 with Retry-After\n" },
  });
  await waitFor(() => expect(action).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(composer().value).toBe(""));
  const sent = vi.mocked(action).mock.calls.map((call) => call[2] as { title: string; operationId: string; expectedSplitRevision: number });
  expect(sent.map((creation) => creation.title)).toEqual(["Throttle per key", "Shared counter", "429 with Retry-After"]);
  expect(new Set(sent.map((creation) => creation.operationId)).size).toBe(3);
  expect(sent.map((creation) => creation.expectedSplitRevision)).toEqual([2, 4, 5]);
});

it("holds the title while the outcome is unknown and reconciles before any retry", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new TypeError("lost response"));
  vi.mocked(api).mockRejectedValue(new TypeError("offline"));
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  await user.type(composer(), "API{Enter}");
  await screen.findByText("We could not tell whether that story saved. Check before trying again.");
  expect(composer().value).toBe("API");
  await user.type(composer(), "{Enter}");
  expect(action).toHaveBeenCalledTimes(1);
  const operationId = (vi.mocked(action).mock.calls[0][2] as { operationId: string }).operationId;
  vi.mocked(api).mockResolvedValue({
    ...splitRoom([parentStory, childStory("API", { creationOperation: operationId })]),
    version: 2,
  });
  await user.click(screen.getByRole("button", { name: "Check saved story" }));
  await waitFor(() => expect(composer().value).toBe(""));
  expect(action).toHaveBeenCalledTimes(1);
});

it("retries under the same identity when the refreshed room does not have the story", async () => {
  const user = userEvent.setup();
  const room = splitRoom([parentStory]);
  vi.mocked(action).mockRejectedValueOnce(new TypeError("response lost")).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue(room);
  renderApp(<FanHarness room={room} isComposerRequested />);
  await user.type(composer(), "API{Enter}");
  await screen.findByText("That story did not save. Press Enter to try again; it will not be added twice.");
  expect(composer().readOnly).toBe(true);
  await user.click(screen.getByRole("button", { name: "Add story to Parent" }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  const [first, second] = vi.mocked(action).mock.calls.map((call) => (call[2] as { operationId: string }).operationId);
  expect(first).toBe(second);
});

it("keeps refused text in the input and restores a removed story with Undo", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new ApiError(409, "child cap reached"));
  renderApp(
    <FanHarness room={splitRoom([parentStory, childStory("UI"), childStory("API", { removedAt: "today", ref: "UP-42" })])} />,
  );
  await user.type(composer(), "Typed{Enter}");
  await screen.findByText("child cap reached");
  expect(composer().value).toBe("Typed");
  expect(screen.getByText(/UP-42/)).toBeTruthy();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 2 });
  await user.click(screen.getByRole("button", { name: "Undo removal of API" }));
  expect(action).toHaveBeenLastCalledWith(
    "session",
    "restore-child",
    expect.objectContaining({ storyId: "API", expectedRevision: 1, expectedSplitRevision: 2 }),
  );
});

it("commits as soon as there are two stories, with nothing to answer first", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  const adopted = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: null, roundVersion: 5 });
  vi.mocked(api).mockResolvedValue({ ...adopted, version: 2 });
  renderApp(<FanHarness room={splitRoom()} />);
  expect((screen.getByRole("button", { name: "Split into 2 stories" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("textbox", { name: "What is left over?" })).toBeNull();
  expect(cards().map((card) => card.dataset.storyId)).toEqual(["API", "UI"]);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  await waitFor(() => expect(actionNames()).toEqual(["adopt", "select"]));
  expect(vi.mocked(action).mock.calls[0][2]).toEqual({
    parentId: "parent",
    expectedRevision: 1,
    expectedSplitRevision: 2,
    children: { API: 1, UI: 1 },
    coverage: "full",
    switchToChildren: true,
    expectedCurrentStoryId: "parent",
    expectedRoundVersion: 4,
  });
  expect(vi.mocked(action).mock.calls[1][2]).toEqual({ storyId: "API", expectedCurrentStoryId: "", expectedRoundVersion: 5 });
});

it("commits two stories from the keyboard with nothing to answer first", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "other" }), version: 2 });
  renderApp(<FanHarness room={splitRoom(undefined, { currentStoryId: "other" })} />);
  composer().focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(actionNames()).toEqual(["adopt"]));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ coverage: "full" });
});

it("names what is left over from a quiet control and commits it as the remainder, from the keyboard", async () => {
  const user = userEvent.setup();
  serveCreations([parentStory, childStory("API"), childStory("UI")]);
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Name what’s left over" }));
  await user.type(screen.getByRole("textbox", { name: "What is left over?" }), "Docs{Enter}");
  await waitFor(() => expect(within(cardOf("Docs")).getByText("Leftover scope")).toBeTruthy());
  expect(vi.mocked(action).mock.calls.find((call) => call[1] === "leftover")![2]).toEqual({
    parentId: "parent",
    storyId: "Docs",
    expectedSplitRevision: 6,
  });
  expect(document.activeElement).toBe(composer());
  expect(screen.queryByRole("button", { name: "Name what’s left over" })).toBeNull();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(actionNames()).toContain("adopt"));
  const adoption = vi.mocked(action).mock.calls.find((call) => call[1] === "adopt")![2];
  expect(adoption).toMatchObject({ coverage: "remainder", remainderId: "Docs", children: { API: 1, UI: 1, Docs: 1 } });
});

it("lets the leftover story go back to being an ordinary story before the split", async () => {
  const user = userEvent.setup();
  serveCreations([parentStory, childStory("API"), childStory("UI")]);
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Name what’s left over" }));
  await user.type(screen.getByRole("textbox", { name: "What is left over?" }), "Docs{Enter}");
  await user.click(await screen.findByRole("button", { name: "Docs is not left over" }));
  await waitFor(() => expect(within(cardOf("Docs")).queryByText("Leftover scope")).toBeNull());
  expect(vi.mocked(action).mock.calls.filter((call) => call[1] === "leftover")[1][2]).toMatchObject({ parentId: "parent", storyId: "" });
  expect(screen.getByRole("button", { name: "Name what’s left over" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Split into 3 stories" }));
  await waitFor(() => expect(actionNames()).toContain("adopt"));
  const adoption = vi.mocked(action).mock.calls.find((call) => call[1] === "adopt")![2] as Record<string, unknown>;
  expect(adoption.coverage).toBe("full");
  expect("remainderId" in adoption).toBe(false);
});

it("backs out of naming what is left over with Escape, keeping the split ready to commit", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Name what’s left over" }));
  await user.type(screen.getByRole("textbox", { name: "What is left over?" }), "Half{Escape}");
  expect(screen.queryByRole("textbox", { name: "What is left over?" })).toBeNull();
  expect(document.activeElement).toBe(composer());
  expect((screen.getByRole("button", { name: "Split into 2 stories" }) as HTMLButtonElement).disabled).toBe(false);
  expect(action).not.toHaveBeenCalled();
});

it("leaves a committed split's table alone when another story is on it", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "other" }), version: 2 });
  renderApp(<FanHarness room={splitRoom(undefined, { currentStoryId: "other" })} />);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  await waitFor(() => expect(action).toHaveBeenCalled());
  expect(actionNames()).toEqual(["adopt"]);
});

it("cancels a draft by removing its cards, without ever adopting", async () => {
  const user = userEvent.setup();
  const onComposerClose = vi.fn();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api)
    .mockResolvedValueOnce({ ...splitRoom([{ ...parentStory, splitRevision: 3 }, childStory("API", { removedAt: "now" }), childStory("UI")]), version: 2 })
    .mockResolvedValue({ ...splitRoom([{ ...parentStory, splitRevision: 4 }, childStory("API", { removedAt: "now" }), childStory("UI", { removedAt: "now" })]), version: 3 });
  renderApp(<FanHarness room={splitRoom()} onComposerClose={onComposerClose} />);
  await user.type(composer(), "half a thought");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  const question = screen.getByRole("group", { name: "Discard these drafts?" });
  expect(within(question).getByText("Discard these 2 draft stories?")).toBeTruthy();
  expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Keep drafting" }));
  expect(action).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("group", { name: "Discard these drafts?" })).toBeNull();
  expect(action).not.toHaveBeenCalled();
  expect(composer().value).toBe("half a thought");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Discard drafts" }));
  await waitFor(() => expect(onComposerClose).toHaveBeenCalled());
  expect(actionNames()).toEqual(["remove-child", "remove-child"]);
  expect(vi.mocked(action).mock.calls[1][2]).toMatchObject({ storyId: "UI", expectedSplitRevision: 3 });
  expect(composer().value).toBe("");
});

it("renames by explicit Save only: blur and remote updates keep the draft, and a conflict offers latest or mine", async () => {
  const user = userEvent.setup();
  const view = renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Rename or add notes to API" }));
  const notes = screen.getByRole("textbox", { name: "Notes for API" }) as HTMLTextAreaElement;
  await user.type(notes, "Mine{Enter}second line");
  await user.tab();
  await user.click(document.body);
  expect(action).not.toHaveBeenCalled();
  const latest = childStory("API", { notes: "Latest remote", contentRevision: 2 });
  view.rerender(<FanHarness room={{ ...splitRoom([parentStory, latest, childStory("UI")]), version: 2 }} />);
  expect(notes.value).toBe("Mine\nsecond line");
  expect(screen.getByText(/Latest: API · Latest remote/)).toBeTruthy();
  expect(screen.getByText(/Mine: API/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save changes to API" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 3 });
  await user.click(screen.getByRole("button", { name: "Save changes to API" }));
  expect(action).toHaveBeenCalledWith(
    "session",
    "story",
    expect.objectContaining({ storyId: "API", notes: "Mine\nsecond line", expectedRevision: 2, scopeRestart: false }),
  );
});

it("cancels a rename with Escape and hands focus back to the control that opened it", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={splitRoom()} />);
  const trigger = screen.getByRole("button", { name: "Rename or add notes to API" });
  await user.click(trigger);
  await user.type(screen.getByRole("textbox", { name: "Title for API" }), " v2");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Title for API" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename or add notes to API" })));
  expect(action).not.toHaveBeenCalled();
});

it("saves a rename of the story on the table against the round it was opened in", async () => {
  const user = userEvent.setup();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...room, version: 2 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for API" }));
  await user.click(screen.getByRole("button", { name: "Rename or add notes" }));
  expect(screen.getByText(/restarts this story's round/)).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "Notes for API" }), "First{Enter}second");
  await user.click(screen.getByRole("button", { name: "Save changes to API" }));
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

it("confirms removing a linked story, names its links, and returns focus to the input", async () => {
  const user = userEvent.setup();
  const room = splitRoom(undefined, { dependencies: [edge("API", "UI")] });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({
    ...splitRoom([parentStory, childStory("API", { removedAt: "today" }), childStory("UI")]),
    version: 2,
  });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "Remove API" }));
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByText(/Its link stays on record for review/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep API" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing API" }));
  expect(action).toHaveBeenCalledWith(
    "session",
    "remove-child",
    expect.objectContaining({ storyId: "API", affectedDependencies: ["API->UI"], expectedDependencyRevision: 0 }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Undo removal of API" })).toBeTruthy());
  await waitFor(() => expect(document.activeElement).toBe(composer()));
});

it("removes an unlinked draft card at once", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 1 });
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Remove UI" }));
  expect(action).toHaveBeenCalledWith("session", "remove-child", expect.objectContaining({ storyId: "UI", affectedDependencies: [] }));
});

it("shows a participant the same cards with no control anywhere, and passes axe", async () => {
  const room = splitRoom(
    adoptedSplit([childStory("API", { estimate: "3", estimateProvenance: "poker" }), childStory("UI"), childStory("Docs", { estimate: "5", estimateNeedsReview: true })]),
    { currentStoryId: "UI", dependencies: [edge("API", "UI")] },
  );
  const view = renderApp(<FanHarness room={room} canEdit={false} />);
  const list = screen.getByRole("list", { name: "Stories in this split" });
  expect(list.tagName).toBe("OL");
  expect(within(list).queryAllByRole("button")).toEqual([]);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText("Anything left over?")).toBeNull();
  expect(screen.queryByText(/facilitator/i)).toBeNull();
  expect(within(cardOf("API")).getByText("1 of 3")).toBeTruthy();
  expect(within(cardOf("API")).getByText("Estimate 3,")).toBeTruthy();
  expect(cardOf("UI").getAttribute("aria-current")).toBe("true");
  expect(within(cardOf("UI")).getByText("On the table")).toBeTruthy();
  expect(within(cardOf("UI")).getByText("waits on API")).toBeTruthy();
  expect(within(cardOf("Docs")).getByText("Needs review")).toBeTruthy();
  expect(cardOf("API").getAttribute("aria-current")).toBeNull();
  await expectNoViolations(view.container);
});

it("gives the facilitator native, named controls on every card and passes axe", async () => {
  const view = renderApp(<FanHarness room={splitRoom(undefined, { dependencies: [edge("API", "UI")] })} />);
  for (const name of ["Set what API is blocked by", "Rename or add notes to API", "Remove API", "Name what’s left over", "Add story to Parent"]) {
    expect(screen.getByRole("button", { name }).tagName).toBe("BUTTON");
  }
  await expectNoViolations(view.container);
});

it("counts only committed stories, in one plain sentence, while a draft is open", () => {
  const stories = [
    ...adoptedSplit([childStory("API", { estimate: "3" }), childStory("UI", { estimate: "5" }), childStory("Auth")]),
    childStory("Late idea", { estimate: "8", estimateNeedsReview: true }),
  ];
  renderApp(<FanHarness room={splitRoom(stories, { currentStoryId: null })} canEdit={false} />);
  expect(screen.getByText("3 stories. 2 estimated, 1 not estimated.")).toBeTruthy();
  expect(within(cardOf("Late idea")).getByText("Draft")).toBeTruthy();
  expect(within(cardOf("Auth")).getByText("Not estimated")).toBeTruthy();
  expect(within(cardOf("Auth")).getByText("3 of 3")).toBeTruthy();
});

it("keeps typed text through a reconnect and a lost chair, offers no write, and disappears for a removed seat", async () => {
  const user = userEvent.setup();
  const view = renderApp(<FanHarness room={splitRoom()} />);
  await user.type(composer(), "My draft");
  view.rerender(<FanHarness room={splitRoom()} canEdit={false} status="reconnecting" />);
  expect(composer().value).toBe("My draft");
  expect(composer().readOnly).toBe(true);
  expect(screen.getByText(/Connection paused\. Your text is kept\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Split into/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add story to Parent" })).toBeNull();
  fireEvent.keyDown(composer(), { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  view.rerender(<FanHarness room={splitRoom()} canEdit={false} status="live" />);
  expect(screen.getByText(/no longer facilitating\. Your text is kept\./)).toBeTruthy();
  view.rerender(<FanHarness room={splitRoom()} status="removed" />);
  expect(screen.queryByDisplayValue("My draft")).toBeNull();
  expect(screen.queryByText("API")).toBeNull();
});

it("stops writing until a failed refresh is retried", async () => {
  const user = userEvent.setup();
  const onRetryRefresh = vi.fn();
  renderApp(<FanHarness room={splitRoom()} refreshError="Refresh the room before writing again." onRetryRefresh={onRetryRefresh} />);
  expect(screen.queryByRole("button", { name: "Remove API" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh room" }));
  expect(onRetryRefresh).toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});

it("announces arrivals once, batched, in a polite live region", async () => {
  const view = renderApp(<FanHarness room={splitRoom()} canEdit={false} />);
  const region = () => view.container.querySelector('section [role="status"]') as HTMLElement;
  expect(region().getAttribute("aria-live")).toBe("polite");
  expect(region().textContent).toBe("");
  view.rerender(
    <FanHarness room={{ ...splitRoom([parentStory, childStory("API"), childStory("UI"), childStory("Docs"), childStory("Auth")]), version: 2 }} canEdit={false} />,
  );
  await waitFor(() => expect(region().textContent).toBe("Added Docs, Auth. 4 stories so far."));
});

it("announces an accepted estimate but says nothing after a reconnect", async () => {
  const waiting = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" });
  const estimated = { ...splitRoom(adoptedSplit([childStory("API", { estimate: "5" }), childStory("UI")]), { currentStoryId: "API" }), version: 2 };
  const view = renderApp(<FanHarness room={waiting} canEdit={false} />);
  const region = () => view.container.querySelector('section [role="status"]') as HTMLElement;
  view.rerender(<FanHarness room={estimated} canEdit={false} />);
  await waitFor(() => expect(region().textContent).toBe("API estimated 5."));
  view.rerender(<FanHarness room={estimated} canEdit={false} status="reconnecting" />);
  view.rerender(
    <FanHarness
      room={{ ...splitRoom(adoptedSplit([childStory("API", { estimate: "5" }), childStory("UI", { estimate: "3" })]), { currentStoryId: "API" }), version: 3 }}
      canEdit={false}
      status="live"
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(region().textContent).toBe("API estimated 5.");
});

it("puts each story's own receipt on its card and never claims more than was created", async () => {
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), { currentStoryId: null });
  vi.mocked(api).mockImplementation(async (_verb, path) => {
    if (String(path).endsWith("/publication/connection")) return { available: true, binding: { Destination: "acme/api" }, writeConsent: true };
    if (String(path).endsWith("/publication/reviews")) return [{ id: "latest", parentId: "parent" }, { id: "other", parentId: "elsewhere" }, { id: "old", parentId: "parent" }];
    if (String(path).endsWith("/reviews/latest/receipts")) {
      return [
        { key: "a", kind: "create", state: "confirmed", childId: "API", remoteId: "41", attempts: 1 },
        { key: "b", kind: "create", state: "failed", childId: "UI", attempts: 2 },
        { key: "c", kind: "estimate", state: "confirmed", childId: "UI", attempts: 1 },
      ];
    }
    throw new Error(`unexpected read of ${path}`);
  });
  renderApp(<FanHarness room={room} canPublish />);
  await screen.findByText("1 of 3 created · 1 not created on GitHub");
  expect(within(cardOf("API")).getByText("#41")).toBeTruthy();
  expect(within(cardOf("UI")).getByText("Not created")).toBeTruthy();
  expect(within(cardOf("Docs")).queryByText(/Created|Not created|Pending/)).toBeNull();
  expect(screen.getByRole("button", { name: "Publish splits to GitHub" })).toBeTruthy();
});

it("offers publishing only where the instance has it switched on", async () => {
  const room = committedRoom([childStory("API"), childStory("UI")]);
  vi.mocked(api).mockResolvedValue({ available: false, binding: null, writeConsent: false });
  const withoutPublishing = renderApp(<FanHarness room={room} canPublish />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Publish splits to GitHub" })).toBeNull();
  withoutPublishing.unmount();

  vi.mocked(api).mockResolvedValue({ available: true, binding: null, writeConsent: false });
  renderApp(<FanHarness room={room} canPublish />);
  expect(await screen.findByRole("button", { name: "Publish splits to GitHub" })).toBeTruthy();
});

it("reads no receipts for anyone who cannot publish", () => {
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: null });
  renderApp(<FanHarness room={room} canEdit={false} />);
  expect(api).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Publish splits to GitHub" })).toBeNull();
});

it("deals and sets estimates through the room, not on its own", async () => {
  const user = userEvent.setup();
  const onDeal = vi.fn();
  const onSetEstimate = vi.fn();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" });
  renderApp(<FanHarness room={room} onDeal={onDeal} onSetEstimate={onSetEstimate} estimateCards={["3", "5", "8"]} />);
  expect(screen.queryByRole("button", { name: "Deal API" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Deal UI" }));
  expect(onDeal).toHaveBeenCalledWith(expect.objectContaining({ id: "UI" }));
  await user.click(screen.getByRole("button", { name: "Set estimate for UI" }));
  await user.click(screen.getByRole("button", { name: "Estimate UI at 5" }));
  expect(onSetEstimate).toHaveBeenCalledWith(expect.objectContaining({ id: "UI" }), "5");
  expect(screen.queryByRole("button", { name: "Estimate UI at 5" })).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

it("asks before setting an estimate on the story whose round is live, and says the round ends", async () => {
  const user = userEvent.setup();
  const onSetEstimate = vi.fn();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" });
  const view = renderApp(<FanHarness room={room} onSetEstimate={onSetEstimate} estimateCards={["3", "5", "8"]} />);
  await user.click(screen.getByRole("button", { name: "Set estimate for API" }));
  await user.click(screen.getByRole("button", { name: "Estimate API at 8" }));
  expect(onSetEstimate).not.toHaveBeenCalled();
  const question = screen.getByRole("group", { name: "Set 8 while this round is live?" });
  expect(within(question).getByText("It is recorded as Facilitator-set. The round on API ends and its votes are discarded.")).toBeTruthy();
  expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Keep voting" }));
  await expectNoViolations(view.container);
  await user.click(within(question).getByRole("button", { name: "Keep voting" }));
  expect(screen.queryByRole("group", { name: "Set 8 while this round is live?" })).toBeNull();
  expect(onSetEstimate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Set estimate for API" }));
  await user.click(screen.getByRole("button", { name: "Estimate API at 5" }));
  await user.click(screen.getByRole("button", { name: "Confirm estimating API at 5" }));
  expect(onSetEstimate).toHaveBeenCalledWith(expect.objectContaining({ id: "API" }), "5");
  expect(screen.queryByRole("group", { name: "Set 5 while this round is live?" })).toBeNull();
});

it("sets an estimate at once on the story on the table when its round is already revealed", async () => {
  const user = userEvent.setup();
  const onSetEstimate = vi.fn();
  const room = { ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" }), revealed: true };
  renderApp(<FanHarness room={room} onSetEstimate={onSetEstimate} estimateCards={["3", "5", "8"]} />);
  await user.click(screen.getByRole("button", { name: "Set estimate for API" }));
  await user.click(screen.getByRole("button", { name: "Estimate API at 8" }));
  expect(onSetEstimate).toHaveBeenCalledWith(expect.objectContaining({ id: "API" }), "8");
});

it("shows a refused estimate on the card it was set on", async () => {
  const user = userEvent.setup();
  const onSetEstimate = vi.fn().mockResolvedValue("story or split changed; review latest and your input before saving");
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: null });
  renderApp(<FanHarness room={room} onSetEstimate={onSetEstimate} estimateCards={["3", "5", "8"]} />);
  await user.click(screen.getByRole("button", { name: "Set estimate for UI" }));
  await user.click(screen.getByRole("button", { name: "Estimate UI at 5" }));
  expect((await within(cardOf("UI")).findByRole("alert")).textContent).toBe("story or split changed; review latest and your input before saving");
});

it("says the round ends before removing the story on the table, and sends the round it saw", async () => {
  const user = userEvent.setup();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), { currentStoryId: "API" });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...room, version: 2 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for API" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  expect(action).not.toHaveBeenCalled();
  expect(within(cardOf("API")).getByText("Remove this story? The round on API ends. Its votes are kept.")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep API" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing API" }));
  expect(action).toHaveBeenCalledWith(
    "session",
    "remove-child",
    expect.objectContaining({ storyId: "API", endRound: true, expectedCurrentStoryId: "API", expectedRoundVersion: 4 }),
  );
});

it("removes a story that is not on the table without touching the round", async () => {
  const user = userEvent.setup();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), { currentStoryId: "API" });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...room, version: 2 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for UI" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  expect(within(cardOf("UI")).queryByText(/The round on/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Confirm removing UI" }));
  expect(vi.mocked(action).mock.calls[0][2]).not.toHaveProperty("endRound");
});

it("keeps a room that has ended readable and write-free", () => {
  const room: Envelope = { ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: null }), endedAt: "today" };
  renderApp(<FanHarness room={room} canEdit={false} />);
  expect(screen.getByText("2 stories. 0 estimated, 2 not estimated.")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toEqual([]);
});

const blankCard = () => document.querySelector<HTMLElement>(".fan-card.is-ghost");

it("writes the story being typed onto the next card, as a picture only, and each story takes that card's place", async () => {
  const user = userEvent.setup();
  serveCreations();
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  expect(screen.getByRole("list", { name: "Stories in this split" })).toBeTruthy();
  expect(blankCard()?.getAttribute("aria-hidden")).toBe("true");
  expect(blankCard()?.dataset.fanItem).toBe("ghost:0");
  await user.type(composer(), "API");
  expect(within(blankCard() as HTMLElement).getByText("API")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Stories in this split" })).queryAllByRole("listitem")).toEqual([]);
  await user.type(composer(), "{Enter}");
  await waitFor(() => expect(cardOf("API").dataset.fanHeir).toBe("ghost:0"));
  expect(blankCard()?.dataset.fanItem).toBe("ghost:1");
  expect(blankCard()?.textContent).toBe("from PAR-1");
  expect(document.activeElement).toBe(composer());
});

it("shows no blank card to anyone who cannot write", () => {
  renderApp(<FanHarness room={splitRoom()} canEdit={false} />);
  expect(blankCard()).toBeNull();
});

it("says how far a draft is from a split in plain words", () => {
  const empty = renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested />);
  expect(screen.getByText("Two stories make a split")).toBeTruthy();
  empty.unmount();
  renderApp(<FanHarness room={splitRoom([parentStory, childStory("API")])} />);
  expect(screen.getByText("One more story makes a split")).toBeTruthy();
});

it("tells someone watching that the ticket is being split, and stops once it is", () => {
  const watching = renderApp(<FanHarness room={splitRoom([parentStory])} canEdit={false} />);
  expect(screen.getByText("This ticket is being split. Stories land here as they are named.")).toBeTruthy();
  watching.unmount();
  const drafting = renderApp(<FanHarness room={splitRoom()} canEdit={false} />);
  expect(screen.getByText("Still being split. Nothing is counted until the split is made.")).toBeTruthy();
  drafting.unmount();
  renderApp(<FanHarness room={splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" })} canEdit={false} />);
  expect(screen.queryByText(/being split/)).toBeNull();
});

it("marks each waits-on chip with the link it stands for, so the line it names can be traced", () => {
  renderApp(<FanHarness room={splitRoom(undefined, { dependencies: [edge("API", "UI")] })} />);
  expect(within(cardOf("UI")).getByText("waits on API").dataset.edgeId).toBe("API->UI");
});

const committedRoom = (children: Story[] = [childStory("API", { estimate: "3" }), childStory("UI")], over: Partial<Envelope["state"]> = {}) =>
  splitRoom(adoptedSplit(children), { currentStoryId: null, ...over });
const undoneRoom = (room: Envelope): Envelope => ({
  ...room,
  version: room.version + 1,
  state: {
    ...room.state,
    currentStoryId: null,
    stories: room.state.stories.map((story) =>
      story.parentId
        ? { ...story, planningRole: "proposed" as const, estimateNeedsReview: story.estimate != null }
        : { ...story, planningRole: "planning" as const, coverage: null, contentRevision: 2, splitRevision: 3 },
    ),
  },
});
const undoTrigger = () => screen.queryByRole("button", { name: "Undo split" });
const undoPanel = () => screen.getByRole("group", { name: "Undo this split?" });

it("undoes a committed split from a quiet strip action, after saying what happens, and keeps the same cards as drafts", async () => {
  const user = userEvent.setup();
  const room = committedRoom();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue(undoneRoom(room));
  const onUndone = vi.fn();
  const view = renderApp(<FanHarness room={room} onUndone={onUndone} />);
  const cardBefore = cardOf("API");
  await user.click(undoTrigger()!);
  expect(action).not.toHaveBeenCalled();
  expect(
    within(undoPanel()).getByText(
      "PAR-1 becomes one story again. The 2 stories are kept as drafts you can come back to. Estimates set on them are kept and marked for review.",
    ),
  ).toBeTruthy();
  const confirm = within(undoPanel()).getByRole("button", { name: "Undo split" });
  expect(document.activeElement).toBe(within(undoPanel()).getByRole("button", { name: "Keep the split" }));
  await expectNoViolations(view.container);
  await user.click(confirm);
  expect(action).toHaveBeenCalledWith("session", "undo-split", {
    parentId: "parent",
    expectedRevision: 1,
    expectedSplitRevision: 2,
    children: { API: 1, UI: 1 },
  });
  await waitFor(() => expect(screen.getByRole("list", { name: "Stories in this split" }).dataset.phase).toBe("drafting"));
  expect(cardOf("API")).toBe(cardBefore);
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  expect(undoTrigger()).toBeNull();
  expect(onUndone).toHaveBeenCalledWith(2);
  await screen.findByText("Split undone. PAR-1 is one story again. 2 draft stories are kept.");
});

it("says the round ends when one of the stories is on the table, and sends the round it saw", async () => {
  const user = userEvent.setup();
  const room = committedRoom(undefined, { currentStoryId: "UI" });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue(undoneRoom(room));
  renderApp(<FanHarness room={room} />);
  await user.click(undoTrigger()!);
  expect(within(undoPanel()).getByText("The round on UI ends. Its votes are kept.")).toBeTruthy();
  await user.click(within(undoPanel()).getByRole("button", { name: "Undo split" }));
  expect(action).toHaveBeenCalledWith("session", "undo-split", {
    parentId: "parent",
    expectedRevision: 1,
    expectedSplitRevision: 2,
    children: { API: 1, UI: 1 },
    endRound: true,
    expectedCurrentStoryId: "UI",
    expectedRoundVersion: 4,
  });
});

it("leaves the split alone on Escape or Keep, and hands focus back to the strip action", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={committedRoom()} />);
  await user.click(undoTrigger()!);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(undoTrigger()));
  await user.keyboard("{Enter}");
  await user.click(within(undoPanel()).getByRole("button", { name: "Keep the split" }));
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(undoTrigger()));
  expect(action).not.toHaveBeenCalled();
});

it("shows a refusal that is not about the tracker where the question was asked, and keeps offering Undo split", async () => {
  const user = userEvent.setup();
  const room = committedRoom();
  vi.mocked(action).mockRejectedValue(new ApiError(409, "story or split changed; review latest and your input before saving"));
  vi.mocked(api).mockResolvedValue(room);
  renderApp(<FanHarness room={room} />);
  await user.click(undoTrigger()!);
  await user.click(within(undoPanel()).getByRole("button", { name: "Undo split" }));
  const refusal = await within(undoPanel()).findByRole("alert");
  expect(refusal.textContent).toBe("Story or split changed; review latest and your input before saving.");
  expect(within(undoPanel()).queryByRole("button", { name: "Undo split" })).toBeNull();
  const close = within(undoPanel()).getByRole("button", { name: "Close" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  expect(screen.getByRole("list", { name: "Stories in this split" }).dataset.phase).toBe("planning");
  await user.click(close);
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(undoTrigger()));
});

it.each([
  [
    "this split has stories already created in the tracker, so it cannot be undone here",
    "Some of these stories were already created in the tracker. Parley never deletes a tracker issue, so this split stays as it is.",
  ],
  [
    "this split has stories that may already be created in the tracker, so it cannot be undone here",
    "A story from this split may already have reached the tracker. It cannot be undone until the receipt says the story was not created.",
  ],
])("explains a tracker refusal in plain words and stops offering Undo split until the split changes: %s", async (serverMessage, plainWords) => {
  const user = userEvent.setup();
  const room = committedRoom();
  vi.mocked(action).mockRejectedValue(new ApiError(409, serverMessage));
  vi.mocked(api).mockResolvedValue(room);
  const view = renderApp(<FanHarness room={room} />);
  await user.click(undoTrigger()!);
  await user.click(within(undoPanel()).getByRole("button", { name: "Undo split" }));
  const refusal = await within(undoPanel()).findByRole("alert");
  expect(refusal.textContent).toBe(plainWords);
  await user.click(within(undoPanel()).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  expect(undoTrigger()).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Stories split from Parent" })));
  await user.click(screen.getByRole("button", { name: "More for API" }));
  expect(screen.queryByRole("button", { name: "Undo split instead" })).toBeNull();
  const changed = { ...room, version: 5, state: { ...room.state, stories: room.state.stories.map((story) => (story.parentId ? story : { ...story, splitRevision: 9 })) } };
  view.rerender(<FanHarness room={changed} />);
  expect(undoTrigger()).toBeTruthy();
});

it("closes the question when the split is undone somewhere else, and does not ask it again when the split is made again", async () => {
  const user = userEvent.setup();
  const room = committedRoom();
  const view = renderApp(<FanHarness room={room} />);
  await user.click(undoTrigger()!);
  expect(undoPanel()).toBeTruthy();
  view.rerender(<FanHarness room={undoneRoom(room)} />);
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
  view.rerender(<FanHarness room={{ ...room, version: 9 }} />);
  await waitFor(() => expect(undoTrigger()).toBeTruthy());
  expect(screen.queryByRole("group", { name: "Undo this split?" })).toBeNull();
});

it.each(["confirmed", "unknown"])("does not offer Undo split once a %s creation receipt is in view", async (state) => {
  const room = committedRoom([childStory("API"), childStory("UI")]);
  vi.mocked(api).mockImplementation(async (_verb, path) => {
    if (String(path).endsWith("/publication/connection")) return { available: true, binding: { Destination: "acme/api" }, writeConsent: true };
    if (String(path).endsWith("/publication/reviews")) return [{ id: "latest", parentId: "parent" }];
    if (String(path).endsWith("/reviews/latest/receipts")) return [{ key: "a", kind: "create", state, childId: "API", attempts: 1 }];
    throw new Error(`unexpected read of ${path}`);
  });
  renderApp(<FanHarness room={room} canPublish />);
  expect(undoTrigger()).toBeTruthy();
  await waitFor(() => expect(undoTrigger()).toBeNull());
  await userEvent.setup().click(screen.getByRole("button", { name: "More for API" }));
  expect(screen.getByText("A split keeps at least two stories.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Undo split instead" })).toBeNull();
});

it.each([
  ["failed", "Not created"],
  ["pending", "Pending"],
])("keeps offering Undo split when the only creation receipt is %s, which the server does not refuse", async (state, label) => {
  vi.mocked(api).mockImplementation(async (_verb, path) => {
    if (String(path).endsWith("/publication/connection")) return { available: true, binding: { Destination: "acme/api" }, writeConsent: true };
    if (String(path).endsWith("/publication/reviews")) return [{ id: "latest", parentId: "parent" }];
    return [{ key: "a", kind: "create", state, childId: "API", attempts: 1 }];
  });
  renderApp(<FanHarness room={committedRoom([childStory("API"), childStory("UI")])} canPublish />);
  await within(cardOf("API")).findByText(label);
  expect(undoTrigger()).toBeTruthy();
});

it("never offers Undo split to a participant, on a draft, or in a room that cannot be written", () => {
  const participant = renderApp(<FanHarness room={committedRoom()} canEdit={false} />);
  expect(undoTrigger()).toBeNull();
  participant.unmount();
  const drafting = renderApp(<FanHarness room={splitRoom()} />);
  expect(undoTrigger()).toBeNull();
  drafting.unmount();
  renderApp(<FanHarness room={committedRoom()} refreshError="Room refresh failed." />);
  expect(undoTrigger()).toBeNull();
});

it("explains why a two-story split cannot lose a story and points to Undo split instead of offering Remove", async () => {
  const user = userEvent.setup();
  const view = renderApp(<FanHarness room={committedRoom()} />);
  await user.click(screen.getByRole("button", { name: "More for API" }));
  expect(screen.queryByRole("button", { name: "Remove from the split" })).toBeNull();
  expect(screen.getByText("A split keeps at least two stories.")).toBeTruthy();
  await expectNoViolations(view.container);
  await user.click(screen.getByRole("button", { name: "Undo split instead" }));
  expect(undoPanel()).toBeTruthy();
  expect(document.activeElement).toBe(within(undoPanel()).getByRole("button", { name: "Keep the split" }));
  expect(action).not.toHaveBeenCalled();
});

it("still offers Remove while a split has more than two stories, except on its leftover story", async () => {
  const user = userEvent.setup();
  const room = splitRoom(
    adoptedSplit([childStory("API"), childStory("UI"), childStory("Rest", { isRemainder: true })], { coverage: "remainder" }),
    { currentStoryId: null },
  );
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for API" }));
  expect(screen.getByRole("button", { name: "Remove from the split" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "More for Rest" }));
  expect(screen.queryByRole("button", { name: "Remove from the split" })).toBeNull();
  expect(screen.getByText("A split keeps its leftover story.")).toBeTruthy();
});

it("removes a single draft on Cancel without asking", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom([parentStory, childStory("API", { removedAt: "now" })]), version: 2 });
  renderApp(<FanHarness room={splitRoom([parentStory, childStory("API")])} />);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Discard these drafts?" })).toBeNull();
  await waitFor(() => expect(actionNames()).toEqual(["remove-child"]));
});

it("does not commit the split on Ctrl and Enter from the rename fields, and keeps what was typed there", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Rename or add notes to API" }));
  const titleField = screen.getByRole("textbox", { name: "Title for API" }) as HTMLInputElement;
  await user.type(titleField, " v2{Control>}{Enter}{/Control}");
  await user.type(screen.getByRole("textbox", { name: "Notes for API" }), "note{Control>}{Enter}{/Control}");
  expect(action).not.toHaveBeenCalled();
  expect(titleField.value).toBe("API v2");
});

it("adds the leftover on Ctrl and Enter from its field instead of committing without it", async () => {
  const user = userEvent.setup();
  serveCreations([parentStory, childStory("API"), childStory("UI")]);
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Name what’s left over" }));
  await user.type(screen.getByRole("textbox", { name: "What is left over?" }), "Docs{Control>}{Enter}{/Control}");
  await waitFor(() => expect(within(cardOf("Docs")).getByText("Leftover scope")).toBeTruthy());
  expect(actionNames()).toEqual(["child", "leftover"]);
});

it("keeps a named leftover through a remount, shows it to everyone, and commits it as the remainder", async () => {
  const user = userEvent.setup();
  const room = splitRoom([parentStory, childStory("API"), childStory("UI"), childStory("Docs", { isRemainder: true })]);
  const watching = renderApp(<FanHarness room={room} canEdit={false} />);
  expect(within(cardOf("Docs")).getByText("Leftover scope")).toBeTruthy();
  watching.unmount();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...room, version: 2 });
  renderApp(<FanHarness room={room} />);
  expect(within(cardOf("Docs")).getByText("Leftover scope")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Docs is not left over" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Split into 3 stories" }));
  await waitFor(() => expect(actionNames()).toContain("adopt"));
  expect(vi.mocked(action).mock.calls.find((call) => call[1] === "adopt")![2]).toMatchObject({ coverage: "remainder", remainderId: "Docs" });
});

it("says plainly when a leftover story was added but could not be marked, and marks it on the next Enter without adding it twice", async () => {
  const user = userEvent.setup();
  let stories = [parentStory, childStory("API"), childStory("UI")];
  let isLeftoverRefused = true;
  vi.mocked(api).mockImplementation(async () => ({ ...splitRoom(stories), version: stories.length }));
  vi.mocked(action).mockImplementation(async (_session, name, body) => {
    if (name === "child") {
      const creation = body as { title: string; operationId: string };
      stories = [...stories, childStory(creation.title, { creationOperation: creation.operationId })];
      return { storyId: creation.title, contentRevision: 1, splitRevision: 3 };
    }
    if (name === "leftover" && isLeftoverRefused) throw new ApiError(409, "story or split changed; review latest and your input before saving");
    return {};
  });
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Name what’s left over" }));
  const field = screen.getByRole("textbox", { name: "What is left over?" });
  await user.type(field, "Docs{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "“Docs” was added as a story, but is not marked as left over yet. Press Enter to mark it.",
  );
  isLeftoverRefused = false;
  await user.type(field, "{Enter}");
  await waitFor(() => expect(actionNames()).toEqual(["child", "leftover", "leftover"]));
});

it("deals nothing after a commit when the first story still holds votes, shows no error, and puts focus on that story's card, not on its Deal", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  const voted = [childStory("API", { votedUserIds: ["mel"] }), childStory("UI")];
  const adopted = splitRoom(adoptedSplit(voted), { currentStoryId: null, roundVersion: 5 });
  vi.mocked(api).mockResolvedValue({ ...adopted, version: 2 });
  renderApp(<FanHarness room={splitRoom([parentStory, ...voted])} onDeal={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deal API" }).closest("li")));
  expect(actionNames()).toEqual(["adopt"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("confirms the stories again by itself after a committed story is removed, so nothing is left to review", async () => {
  const user = userEvent.setup();
  const children = [childStory("API"), childStory("UI"), childStory("Docs")];
  const room = splitRoom(adoptedSplit(children), { currentStoryId: null });
  const removed = splitRoom(
    adoptedSplit([children[0], children[1], { ...children[2], removedAt: "now", contentRevision: 2 }], { coverage: "needs-review", contentRevision: 2, splitRevision: 3 }),
    { currentStoryId: null },
  );
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api)
    .mockResolvedValueOnce({ ...removed, version: 2 })
    .mockResolvedValue({ ...splitRoom(adoptedSplit([children[0], children[1], { ...children[2], removedAt: "now" }]), { currentStoryId: null }), version: 3 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing Docs" }));
  await waitFor(() => expect(actionNames()).toEqual(["remove-child", "adopt"]));
  expect(vi.mocked(action).mock.calls[1][2]).toMatchObject({
    parentId: "parent",
    coverage: "full",
    expectedRevision: 2,
    expectedSplitRevision: 3,
    children: { API: 1, UI: 1 },
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm these stories" })).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
});

it("offers a quiet way to confirm the stories when that could not be done, without calling it an error or a leftover", async () => {
  const user = userEvent.setup();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI")], { coverage: "needs-review" }), { currentStoryId: null });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: null }), version: 2 });
  renderApp(<FanHarness room={room} />);
  expect(screen.queryByText(/leftover/i)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Confirm these stories" }));
  expect(action).toHaveBeenCalledWith("session", "adopt", expect.objectContaining({ coverage: "full", children: { API: 1, UI: 1 } }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm these stories" })).toBeNull());
});

it("keeps a named leftover for review after a change, with one optional control that confirms the same leftover", async () => {
  const user = userEvent.setup();
  const children = [childStory("API"), childStory("UI"), childStory("Rest", { isRemainder: true })];
  const room = splitRoom(adoptedSplit(children, { coverage: "needs-review" }), { currentStoryId: null });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit(children, { coverage: "remainder" }), { currentStoryId: null }), version: 2 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "Keep Rest as the leftover" }));
  expect(action).toHaveBeenCalledWith("session", "adopt", expect.objectContaining({ coverage: "remainder", remainderId: "Rest" }));
});

it("does not confirm stories by itself while drafts are open under the split, since that would commit them", async () => {
  const user = userEvent.setup();
  const stories = [...adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), childStory("Draft")];
  const afterRemoval = stories.map((story) =>
    story.id === "Docs" ? { ...story, removedAt: "now" } : story.id === "parent" ? { ...story, coverage: "needs-review" as const } : story,
  );
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(afterRemoval, { currentStoryId: null }), version: 2 });
  renderApp(<FanHarness room={splitRoom(stories, { currentStoryId: null })} />);
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing Docs" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Undo removal of Docs" })).toBeTruthy());
  expect(actionNames()).toEqual(["remove-child"]);
  expect(screen.queryByRole("button", { name: "Confirm these stories" })).toBeNull();
});

it("hands focus back to the card's own control when a removal is declined or fails in a committed split", async () => {
  const user = userEvent.setup();
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), { currentStoryId: null });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.click(screen.getByRole("button", { name: "Keep Docs" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for Docs" })));
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for Docs" })));
  vi.mocked(action).mockRejectedValue(new ApiError(409, "story or split changed; review latest and your input before saving"));
  vi.mocked(api).mockResolvedValue({ ...room, version: 2 });
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing Docs" }));
  await within(cardOf("Docs")).findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for Docs" })));
});

it("lands focus on the split itself after a committed story is removed and no input exists", async () => {
  const user = userEvent.setup();
  const children = [childStory("API"), childStory("UI"), childStory("Docs")];
  const room = splitRoom(adoptedSplit(children), { currentStoryId: null });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({
    ...splitRoom(adoptedSplit([children[0], children[1], { ...children[2], removedAt: "now" }]), { currentStoryId: null }),
    version: 2,
  });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await user.click(screen.getByRole("button", { name: "Confirm removing Docs" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Stories split from Parent" })));
});

it("keeps a removed story restorable while a round is live on another story", () => {
  const children = [childStory("API"), childStory("UI"), childStory("Docs", { removedAt: "now" })];
  renderApp(<FanHarness room={splitRoom(adoptedSplit(children), { currentStoryId: "API" })} />);
  expect(screen.getByRole("button", { name: "Undo removal of Docs" })).toBeTruthy();
});

it("clears typed text on Escape, then goes back to the table on the next one, and never removes a story", async () => {
  const user = userEvent.setup();
  const onBackToTable = vi.fn();
  renderApp(<FanHarness room={splitRoom()} onBackToTable={onBackToTable} />);
  await user.type(composer(), "half{Escape}");
  expect(composer().value).toBe("");
  expect(onBackToTable).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(onBackToTable).toHaveBeenCalledTimes(1);
  expect(action).not.toHaveBeenCalled();
  expect(cards().filter((card) => card.dataset.storyId).length).toBe(2);
});

it("holds a blocked-by tick where it was put until the server answers", async () => {
  const user = userEvent.setup();
  let answer: (value: unknown) => void = () => {};
  vi.mocked(action).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  vi.mocked(api).mockResolvedValue({ ...splitRoom(undefined, { dependencies: [edge("API", "UI")] }), version: 2 });
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  const choice = screen.getByRole("checkbox", { name: "API" }) as HTMLInputElement;
  await user.click(choice);
  expect(choice.checked).toBe(true);
  answer({});
  await waitFor(() => expect(within(cardOf("UI")).getByText("waits on API")).toBeTruthy());
  expect((screen.getByRole("checkbox", { name: "API" }) as HTMLInputElement).checked).toBe(true);
});

it("names the estimate control by the word it shows", () => {
  const room = splitRoom(adoptedSplit([childStory("API", { estimate: "3" }), childStory("UI")]), { currentStoryId: null });
  renderApp(<FanHarness room={room} onSetEstimate={vi.fn()} estimateCards={["3", "5"]} />);
  expect(within(cardOf("API")).getByRole("button", { name: "Change estimate for API" })).toBeTruthy();
  expect(within(cardOf("UI")).getByRole("button", { name: "Set estimate for UI" })).toBeTruthy();
});

it("says a story that did not save in plain words", async () => {
  const user = userEvent.setup();
  const room = splitRoom([parentStory]);
  vi.mocked(action).mockRejectedValue(new TypeError("response lost"));
  vi.mocked(api).mockResolvedValue(room);
  renderApp(<FanHarness room={room} isComposerRequested />);
  await user.type(composer(), "API{Enter}");
  expect((await screen.findByRole("alert")).textContent).not.toMatch(/identity|refreshed room/i);
});

it("deals the first story in split order that is not settled after a commit, one that needs review before a later unestimated one", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  const stories = [childStory("API", { estimate: "3", estimateNeedsReview: true }), childStory("UI")];
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit(stories), { currentStoryId: null, roundVersion: 5 }), version: 2 });
  renderApp(<FanHarness room={splitRoom([parentStory, ...stories])} onDeal={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  await waitFor(() => expect(actionNames()).toEqual(["adopt", "select"]));
  expect(vi.mocked(action).mock.calls[1][2]).toMatchObject({ storyId: "API" });
});

it("does not call a rename a conflict when only revisions moved, and saves against the latest ones", async () => {
  const user = userEvent.setup();
  const view = renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Rename or add notes to API" }));
  await user.type(screen.getByRole("textbox", { name: "Title for API" }), " v2");
  const moved = childStory("API", { contentRevision: 2, planningRole: "planning" });
  view.rerender(<FanHarness room={{ ...splitRoom(adoptedSplit([moved, childStory("UI")]), { currentStoryId: null, roundVersion: 9 }), version: 2 }} />);
  expect(screen.queryByText("This story changed while you were editing.")).toBeNull();
  const save = screen.getByRole("button", { name: "Save changes to API" }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 3 });
  await user.click(save);
  expect(action).toHaveBeenCalledWith(
    "session",
    "story",
    expect.objectContaining({ storyId: "API", title: "API v2", expectedRevision: 2, expectedCurrentStoryId: "", expectedRoundVersion: 9 }),
  );
});

it("saves a rename on Enter in its Title field", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 2 });
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Rename or add notes to API" }));
  await user.type(screen.getByRole("textbox", { name: "Title for API" }), " v2{Enter}");
  await waitFor(() => expect(action).toHaveBeenCalledWith("session", "story", expect.objectContaining({ storyId: "API", title: "API v2" })));
});

it("leaves the split view on Escape from an empty input when there is no draft to keep", async () => {
  const user = userEvent.setup();
  const onComposerClose = vi.fn();
  renderApp(<FanHarness room={splitRoom([parentStory])} isComposerRequested onComposerClose={onComposerClose} />);
  await user.type(composer(), "{Escape}");
  expect(onComposerClose).toHaveBeenCalledTimes(1);
  expect(action).not.toHaveBeenCalled();
});

it("takes the split as made when the answer to the commit was lost but the room shows it committed", async () => {
  const user = userEvent.setup();
  const onComposerClose = vi.fn();
  vi.mocked(action).mockRejectedValue(new TypeError("lost response"));
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit([childStory("API"), childStory("UI")]), { currentStoryId: "API" }), version: 2 });
  renderApp(<FanHarness room={splitRoom()} onComposerClose={onComposerClose} />);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  await waitFor(() => expect(onComposerClose).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(actionNames()).toEqual(["adopt"]);
});

it("says a raw server failure in plain words, and clears the message when the room reconnects", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new ApiError(500, "internal error"));
  vi.mocked(api).mockResolvedValue({ ...splitRoom(), version: 1 });
  const view = renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Split into 2 stories" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The server had a problem and that may not have gone through. Check the room, then try again.",
  );
  view.rerender(<FanHarness room={splitRoom()} status="reconnecting" />);
  view.rerender(<FanHarness room={splitRoom()} status="live" />);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("asks before a commit that would end the round on the committed ticket itself, with keeping the round focused", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  const stories = [...adoptedSplit([childStory("API"), childStory("UI")]), childStory("New")];
  vi.mocked(api).mockResolvedValue({ ...splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("New")]), { currentStoryId: null }), version: 2 });
  renderApp(<FanHarness room={splitRoom(stories, { currentStoryId: "parent" })} />);
  await user.click(screen.getByRole("button", { name: "Split into 3 stories" }));
  expect(action).not.toHaveBeenCalled();
  const question = screen.getByRole("group", { name: "End the round on PAR-1?" });
  expect(question.textContent).toContain("Its votes are kept");
  await waitFor(() => expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Keep the round" })));
  await user.click(within(question).getByRole("button", { name: "Split and end the round" }));
  await waitFor(() => expect(actionNames()[0]).toBe("adopt"));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({ switchToChildren: true, expectedCurrentStoryId: "parent", expectedRoundVersion: 4 });
});

it("brings the undo question, the discard question and a card's question into view when they open below the fold", async () => {
  const user = userEvent.setup();
  const scrolled = vi.fn();
  const originalScrollBy = window.scrollBy;
  window.scrollBy = scrolled as unknown as typeof window.scrollBy;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isQuestion = this.getAttribute("role") === "group";
    const top = isQuestion ? window.innerHeight - 20 : this.tagName === "BUTTON" ? 300 : 0;
    const height = isQuestion ? 120 : this.tagName === "BUTTON" ? 44 : 0;
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  const view = renderApp(<FanHarness room={splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), { currentStoryId: "API" })} estimateCards={["1", "3"]} onSetEstimate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Undo split" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 112 }), { timeout: 2000 });
  scrolled.mockClear();
  await user.click(screen.getByRole("button", { name: "Keep the split" }));
  await user.click(screen.getByRole("button", { name: "Set estimate for API" }));
  await user.click(screen.getByRole("button", { name: "Estimate API at 3" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 112 }), { timeout: 2000 });
  scrolled.mockClear();
  await user.click(screen.getByRole("button", { name: "Keep voting" }));
  await user.click(screen.getByRole("button", { name: "More for Docs" }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 112 }), { timeout: 2000 });
  scrolled.mockClear();
  view.unmount();
  renderApp(<FanHarness room={splitRoom()} />);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 112 }), { timeout: 2000 });
  rectSpy.mockRestore();
  window.scrollBy = originalScrollBy;
});

it("shows a ticket's estimate with the number set apart from the words around it", () => {
  renderApp(<SplitStrip fan={splitFanOf(splitRoom(adoptedSplit([childStory("API"), childStory("UI")], { estimate: "3.5", estimateProvenance: "story-total" })).state, "parent")!} />);
  expect(screen.getByText("3.5").className).toContain("font-mono");
  expect(screen.getByText(/Story total/)).toBeTruthy();
});

it("keeps a very long story name short inside the remove and estimate questions", async () => {
  const user = userEvent.setup();
  const long = "L".repeat(120);
  renderApp(<FanHarness room={splitRoom(adoptedSplit([childStory(long), childStory("UI"), childStory("Docs")]), { currentStoryId: long })} estimateCards={["1", "3"]} onSetEstimate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: `Set estimate for ${long}` }));
  await user.click(screen.getByRole("button", { name: `Estimate ${long} at 3` }));
  const estimateQuestion = screen.getByRole("group", { name: "Set 3 while this round is live?" });
  expect(estimateQuestion.textContent).toContain("L".repeat(47) + "…");
  expect(estimateQuestion.textContent).not.toContain(long);
  await user.click(screen.getByRole("button", { name: "Keep voting" }));
  await user.click(screen.getByRole("button", { name: `More for ${long}` }));
  await user.click(screen.getByRole("button", { name: "Remove from the split" }));
  const removeQuestion = screen.getByRole("group", { name: `Remove ${long}?` });
  expect(removeQuestion.textContent).toContain("L".repeat(47) + "…");
  expect(removeQuestion.textContent).not.toContain(long);
});
