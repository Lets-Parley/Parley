import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { FanHarness } from "../test/FanHarness";
import { adoptedSplit, childStory, edge, parentStory, splitRoom } from "../test/splitFixtures";
import { action, api } from "../lib/api";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  action: vi.fn(),
  api: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

const cards = () => within(screen.getByRole("list", { name: "Stories in this split" })).getAllByRole("listitem");
const cardOf = (title: string) => cards().find((card) => card.dataset.storyId === title) as HTMLElement;
const order = () => cards().map((card) => card.dataset.storyId).filter(Boolean);
const menuFor = (title: string) => screen.getByRole("group", { name: `${title} is blocked by` });

function fourStories(over: Parameters<typeof splitRoom>[1] = {}) {
  return splitRoom([parentStory, childStory("API", { estimate: "5" }), childStory("UI"), childStory("Docs"), childStory("Auth")], over);
}

it("links a sibling the moment it is ticked, sending the whole graph and reordering nothing", async () => {
  const user = userEvent.setup();
  const room = fourStories({ dependencies: [edge("Docs", "Auth")] });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...fourStories({ dependencies: [edge("Docs", "Auth"), edge("API", "UI")] }), version: 2 });
  renderApp(<FanHarness room={room} />);
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  const menu = menuFor("UI");
  expect(within(menu).getByText("Planning dependency · Completion not checked")).toBeTruthy();
  expect(within(menu).queryByRole("checkbox", { name: /UI/ })).toBeNull();
  await user.click(within(menu).getByRole("checkbox", { name: "API" }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith("session", "dependencies", {
    parentId: "parent",
    expectedRevision: 1,
    expectedDependencyRevision: 0,
    children: { API: 1, UI: 1, Docs: 1, Auth: 1 },
    edges: [
      { blockerId: "Docs", dependentId: "Auth" },
      { blockerId: "API", dependentId: "UI" },
    ],
    retireIds: [],
  });
  await waitFor(() => expect(within(cardOf("UI")).getByText("waits on API")).toBeTruthy());
  expect((within(menuFor("UI")).getByRole("checkbox", { name: "API" }) as HTMLInputElement).checked).toBe(true);
  expect(order()).toEqual(["API", "UI", "Docs", "Auth"]);
});

it("unlinks by unticking, leaving every other link in place", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...fourStories({ dependencies: [edge("Docs", "Auth"), edge("Docs", "UI")] }), version: 2 });
  renderApp(<FanHarness room={fourStories({ dependencies: [edge("Docs", "Auth"), edge("API", "UI"), edge("Docs", "UI")] })} />);
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  await user.click(within(menuFor("UI")).getByRole("checkbox", { name: "API" }));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({
    edges: [
      { blockerId: "Docs", dependentId: "Auth" },
      { blockerId: "Docs", dependentId: "UI" },
    ],
    retireIds: [],
  });
  await waitFor(() => expect(within(cardOf("UI")).queryByText("waits on API")).toBeNull());
});

it("refuses a choice that would close a loop, and says why to a keyboard", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={fourStories({ dependencies: [edge("API", "UI"), edge("UI", "Docs")] })} />);
  await user.click(screen.getByRole("button", { name: "Set what API is blocked by" }));
  const menu = menuFor("API");
  for (const blocked of ["UI", "Docs"]) {
    const choice = within(menu).getByRole("checkbox", { name: new RegExp(`^${blocked}`) }) as HTMLInputElement;
    expect(choice.getAttribute("aria-disabled")).toBe("true");
    expect(choice.disabled).toBe(false);
    expect(document.getElementById(choice.getAttribute("aria-describedby")!)!.textContent).toBe("It already waits on this story");
    await user.click(choice);
    expect(choice.checked).toBe(false);
  }
  expect(within(menu).getByRole("checkbox", { name: "Auth" }).getAttribute("aria-disabled")).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

it("closes on Escape and gives focus back to the card's own control", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={fourStories()} />);
  const trigger = screen.getByRole("button", { name: "Set what Docs is blocked by" });
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(menuFor("Docs"));
  expect(within(menuFor("Docs")).getAllByRole("checkbox").includes(document.activeElement as HTMLElement)).toBe(false);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("group", { name: "Docs is blocked by" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(action).not.toHaveBeenCalled();
});

it("closes when something outside the card is pressed", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={fourStories()} />);
  await user.click(screen.getByRole("button", { name: "Set what Docs is blocked by" }));
  fireEvent.pointerDown(cardOf("API"));
  expect(screen.queryByRole("group", { name: "Docs is blocked by" })).toBeNull();
});

it("leaves focus on whatever was pressed outside the card instead of pulling it back to the menu's control", async () => {
  const user = userEvent.setup();
  renderApp(<FanHarness room={fourStories()} />);
  await user.click(screen.getByRole("button", { name: "Set what Docs is blocked by" }));
  const pressed = screen.getByRole("textbox", { name: "Name a story, then press Enter" });
  await user.click(pressed);
  expect(screen.queryByRole("group", { name: "Docs is blocked by" })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.activeElement).toBe(pressed);
});

it("never reads an unavailable blocker as ready, and drops it only when it is unticked", async () => {
  const user = userEvent.setup();
  const stories = [parentStory, childStory("API", { removedAt: "today" }), childStory("UI"), childStory("Docs")];
  const room = splitRoom(stories, {
    dependencies: [edge("API", "UI", { reviewState: "blocker-removed-review" }), edge("Docs", "UI")],
  });
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(stories, { dependencies: [edge("Docs", "UI")] }), version: 2 });
  renderApp(<FanHarness room={room} />);
  const stale = within(cardOf("UI")).getByText("waits on API · needs review");
  expect(stale.className).toContain("is-unavailable");
  expect(within(cardOf("UI")).getByText("waits on Docs").className).not.toContain("is-unavailable");
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  await user.click(within(menuFor("UI")).getByRole("checkbox", { name: /^API/ }));
  expect(action).toHaveBeenCalledWith(
    "session",
    "dependencies",
    expect.objectContaining({ edges: [{ blockerId: "Docs", dependentId: "UI" }], retireIds: ["API->UI"] }),
  );
});

it("keeps an unresolved link on record when a different one changes", async () => {
  const user = userEvent.setup();
  const stories = [parentStory, childStory("API", { removedAt: "today" }), childStory("UI"), childStory("Docs")];
  vi.mocked(action).mockResolvedValue({});
  vi.mocked(api).mockResolvedValue({ ...splitRoom(stories), version: 1 });
  renderApp(<FanHarness room={splitRoom(stories, { dependencies: [edge("API", "UI", { reviewState: "blocker-removed-review" })] })} />);
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  await user.click(within(menuFor("UI")).getByRole("checkbox", { name: "Docs" }));
  expect(vi.mocked(action).mock.calls[0][2]).toMatchObject({
    children: { API: 1, UI: 1, Docs: 1 },
    edges: [{ blockerId: "Docs", dependentId: "UI" }],
    retireIds: [],
  });
});

it("shows a refused save inside the menu and leaves the tick as the server has it", async () => {
  const user = userEvent.setup();
  vi.mocked(action).mockRejectedValue(new Error("story or split changed; review latest and your input before saving"));
  vi.mocked(api).mockResolvedValue({ ...fourStories(), version: 1 });
  renderApp(<FanHarness room={fourStories()} />);
  await user.click(screen.getByRole("button", { name: "Set what UI is blocked by" }));
  await user.click(within(menuFor("UI")).getByRole("checkbox", { name: "API" }));
  expect((await within(menuFor("UI")).findByRole("alert")).textContent).toContain("story or split changed");
  expect((within(menuFor("UI")).getByRole("checkbox", { name: "API" }) as HTMLInputElement).checked).toBe(false);
});

it("writes every dependency as words on the waiting card, for a reader with no lines to follow", async () => {
  const room = splitRoom(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]), {
    currentStoryId: "API",
    dependencies: [edge("API", "Docs"), edge("UI", "Docs")],
  });
  const view = renderApp(<FanHarness room={room} canEdit={false} />);
  const chips = within(cardOf("Docs")).getAllByRole("listitem").map((chip) => chip.textContent);
  expect(chips).toEqual(["waits on API", "waits on UI"]);
  expect(within(cardOf("API")).queryByText(/waits on/)).toBeNull();
  await expectNoViolations(view.container);
});

it("passes axe with the menu open", async () => {
  const user = userEvent.setup();
  const view = renderApp(<FanHarness room={fourStories({ dependencies: [edge("API", "UI")] })} />);
  await user.click(screen.getByRole("button", { name: "Set what API is blocked by" }));
  await expectNoViolations(view.container);
});
