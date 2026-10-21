import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoryQueue } from "./StoryQueue";
import { renderApp } from "../test/render";
import type { Story } from "../lib/api";

const stories = [
  { id: "s1", title: "Set up CI", ref: "P-1", position: 1, estimate: null },
  { id: "s2", title: "Ship the deck", ref: "P-2", position: 2, estimate: null },
  { id: "s3", title: "Retire the cron", ref: "P-3", position: 3, estimate: "5" },
] as unknown as Story[];

function renderQueue() {
  renderApp(
    <StoryQueue
      sessionId="sess-1"
      stories={stories}
      currentStoryId={null}
      isFacilitator
      onQuickRound={vi.fn()}
      fail={null}
      onFail={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

describe("StoryQueue", () => {
  it("labels the queue landmark with its own heading", () => {
    renderQueue();
    expect(screen.getByRole("complementary", { name: /Story queue/ })).toBeTruthy();
  });

  it("gives every Deal button a distinct accessible name", () => {
    renderQueue();
    expect(screen.getByRole("button", { name: "Deal Set up CI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deal Ship the deck" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deal" })).toBeNull();
  });

  it("sizes reorder controls for touch", () => {
    renderQueue();
    const up = screen.getByRole("button", { name: "Move Set up CI up" });
    expect(up.className).toContain("touch-hit");
  });

  it("gives the agreed-estimate chip a real accessible name", () => {
    renderQueue();
    expect(screen.getByRole("img", { name: "Agreed estimate 5" })).toBeTruthy();
  });

  it("falls back to the ticket ref when a story has no title", () => {
    renderApp(
      <StoryQueue
        sessionId="sess-1"
        stories={[{ id: "s9", title: "", ref: "PAR-142", position: 1, estimate: null }] as unknown as Story[]}
        currentStoryId={null}
        isFacilitator
        onQuickRound={vi.fn()}
        fail={null}
        onFail={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Deal PAR-142" })).toBeTruthy();
  });

  it("enables the composer submit when only the ticket ref is filled in", async () => {
    renderQueue();
    await userEvent.click(screen.getByRole("button", { name: "+ Ticket" }));
    const submit = screen.getByRole("button", { name: "Add to queue" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText(/Ticket, e.g./), "PAR-142");
    expect(submit.disabled).toBe(false);
  });

  it("adds a ref-only ticket to the queue", async () => {
    // The submit guard is behavior, not an attribute: a ref with no title has
    // to actually reach the server. Asserting on `disabled` alone leaves the
    // guard free to be an && and nobody notices.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    renderQueue();
    await userEvent.click(screen.getByRole("button", { name: "+ Ticket" }));
    await userEvent.type(screen.getByPlaceholderText(/Ticket, e.g./), "PAR-142");
    await userEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/stories");
    expect(JSON.parse(init.body as string)).toMatchObject({ ref: "PAR-142", title: "" });
    fetchSpy.mockRestore();
  });

  it("keeps a failed queue action's reason inside the queue, dismissable", async () => {
    // It used to be routed up to one shared line between the results panel and
    // the hand — a different column from the button that failed.
    const onDismiss = vi.fn();
    const retry = vi.fn().mockResolvedValue(undefined);
    renderApp(
      <StoryQueue
        sessionId="sess-1"
        stories={stories}
        currentStoryId={null}
        isFacilitator
        onQuickRound={vi.fn()}
        fail={{ msg: "Could not deal that story.", retry }}
        onFail={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Could not deal that story.")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: /Story queue/ }).contains(alert)).toBe(true);

    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers Try again for a real failed Deal, driven through StoryQueue's own run", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "Could not deal that story." }), { status: 500 }));
    let failArgs: [string, (() => Promise<unknown>) | undefined] | null = null;
    renderApp(
      <StoryQueue
        sessionId="sess-1"
        stories={stories}
        currentStoryId={null}
        isFacilitator
        onQuickRound={vi.fn()}
        fail={null}
        onFail={(msg, retry) => {
          failArgs = [msg, retry];
        }}
        onDismiss={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Deal Set up CI" }));
    expect(failArgs).not.toBeNull();
    const [msg, retry] = failArgs!;
    expect(msg).toBe("Could not deal that story.");
    expect(retry).toBeTypeOf("function");
    fetchSpy.mockRestore();
  });

  it("does not offer Try again for a failed ticket creation, since retrying can duplicate it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "Could not add the ticket." }), { status: 500 }));
    let failArgs: [string, (() => Promise<unknown>) | undefined] | null = null;
    renderApp(
      <StoryQueue
        sessionId="sess-1"
        stories={stories}
        currentStoryId={null}
        isFacilitator
        onQuickRound={vi.fn()}
        fail={null}
        onFail={(msg, retry) => {
          failArgs = [msg, retry];
        }}
        onDismiss={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "+ Ticket" }));
    await userEvent.type(screen.getByPlaceholderText(/Ticket, e.g./), "PAR-142");
    await userEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    expect(failArgs).not.toBeNull();
    const [msg, retry] = failArgs!;
    expect(msg).toBe("Could not add the ticket.");
    expect(retry).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("keeps brass off the agreed-estimate chip", () => {
    // Brass means authority — the facilitator, and only the facilitator. An
    // agreed estimate is `settled`, a decision at rest.
    renderQueue();
    const chip = screen.getByRole("img", { name: /Agreed estimate/ });
    expect(chip.className).toContain("border-settled");
    expect(chip.className).not.toContain("brass");
  });

  describe("a story whose drafts are set aside", () => {
    const parkedParent = { id: "p", title: "Checkout redesign", ref: "PAR-150", position: 1, estimate: null, planningRole: "planning", draftsParked: true };
    const everyStory = [
      parkedParent,
      { id: "a", title: "Cart API", ref: "", position: 2, estimate: null, parentId: "p", planningRole: "proposed" },
      { id: "b", title: "Payment form", ref: "", position: 3, estimate: null, parentId: "p", planningRole: "proposed" },
      { id: "gone", title: "Dropped", ref: "", position: 4, estimate: null, parentId: "p", planningRole: "proposed", removedAt: "2026-10-10" },
    ] as unknown as Story[];
    function renderParked(isFacilitator: boolean, onContinueSplit = vi.fn(), onDeal = vi.fn()) {
      renderApp(
        <StoryQueue
          sessionId="sess-1"
          stories={[parkedParent] as unknown as Story[]}
          allStories={everyStory}
          currentStoryId={null}
          isFacilitator={isFacilitator}
          onQuickRound={vi.fn()}
          onDeal={onDeal}
          onContinueSplit={onContinueSplit}
          fail={null}
          onFail={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      return { onContinueSplit, onDeal };
    }

    it("reads as an ordinary story with a quiet way back to its drafts for the facilitator", async () => {
      const { onContinueSplit, onDeal } = renderParked(true);
      const queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(within(queue).queryByText(/splitting/i)).toBeNull();
      expect(within(queue).queryByText(/not counted until the split/)).toBeNull();
      expect(within(queue).queryByRole("button", { name: /Show the split/ })).toBeNull();
      await userEvent.click(within(queue).getByRole("button", { name: "Deal Checkout redesign" }));
      expect(onDeal).toHaveBeenCalledWith(parkedParent);
      const drafts = within(queue).getByRole("button", { name: "Continue splitting Checkout redesign, 2 draft stories" });
      expect(drafts.textContent).toBe("2 draft stories");
      await userEvent.click(drafts);
      expect(onContinueSplit).toHaveBeenCalledWith(parkedParent);
    });

    it("can always be dealt from the queue, also when its estimate needs review", async () => {
      const reviewed = { ...parkedParent, estimate: "16", estimateProvenance: "story-total", estimateNeedsReview: true, splitRevision: 7 };
      const onDeal = vi.fn();
      renderApp(
        <StoryQueue
          sessionId="sess-1"
          stories={[reviewed] as unknown as Story[]}
          allStories={[reviewed, ...everyStory.slice(1)] as unknown as Story[]}
          currentStoryId={null}
          isFacilitator
          onQuickRound={vi.fn()}
          onDeal={onDeal}
          onContinueSplit={vi.fn()}
          fail={null}
          onFail={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      const queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(within(queue).getByText("Needs review · previous 16")).toBeTruthy();
      const deal = within(queue).getByRole("button", { name: "Deal Checkout redesign" });
      expect(deal.hasAttribute("data-queue-deal")).toBe(true);
      await userEvent.click(deal);
      expect(onDeal).toHaveBeenCalledWith(reviewed);
    });

    it("shows a participant the count and nothing to press", () => {
      renderParked(false);
      const queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(within(queue).getByText("2 draft stories")).toBeTruthy();
      expect(within(queue).queryByRole("button", { name: /draft stor/ })).toBeNull();
      expect(within(queue).queryByText(/splitting/i)).toBeNull();
    });

    it("keeps today's wording for a split that is being drafted and was never set aside", () => {
      renderApp(
        <StoryQueue
          sessionId="sess-1"
          stories={[{ ...parkedParent, draftsParked: false }] as unknown as Story[]}
          allStories={[{ ...parkedParent, draftsParked: false }, ...everyStory.slice(1)] as unknown as Story[]}
          currentStoryId={null}
          isFacilitator
          onQuickRound={vi.fn()}
          fail={null}
          onFail={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByText(/PAR-150 · splitting/)).toBeTruthy();
      expect(screen.getByText("2 drafted · not counted until the split")).toBeTruthy();
    });

    it("shows a story whose drafts were all discarded as an ordinary row, with a quiet way to its removed stories for the facilitator alone", async () => {
      const canceled = { ...parkedParent, draftsParked: false };
      const discarded = everyStory.slice(1).map((story) => ({ ...story, removedAt: "2026-10-10" })) as Story[];
      const onShowSplit = vi.fn();
      const props = {
        sessionId: "sess-1",
        stories: [canceled] as unknown as Story[],
        allStories: [canceled, ...discarded] as unknown as Story[],
        currentStoryId: null,
        onQuickRound: vi.fn(),
        onDeal: vi.fn(),
        onShowSplit,
        fail: null,
        onFail: vi.fn(),
        onDismiss: vi.fn(),
      };
      const seat = renderApp(<StoryQueue {...props} isFacilitator={false} />);
      let queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(within(queue).queryByText(/splitting|drafted/i)).toBeNull();
      expect(within(queue).queryByRole("button", { name: /removed stor/ })).toBeNull();
      seat.unmount();
      renderApp(<StoryQueue {...props} isFacilitator />);
      queue = screen.getByRole("complementary", { name: /Story queue/ });
      expect(within(queue).queryByText(/splitting|drafted/i)).toBeNull();
      expect(within(queue).getByRole("button", { name: "Deal Checkout redesign" })).toBeTruthy();
      await userEvent.click(within(queue).getByRole("button", { name: "Show the 3 removed stories of Checkout redesign" }));
      expect(onShowSplit).toHaveBeenCalledWith(canceled);
    });

    it("counts a committed split in the same words the split view uses", () => {
      const committed = { ...parkedParent, draftsParked: false, planningRole: "context" };
      const children = [
        { id: "a", title: "Cart API", ref: "", position: 2, estimate: "3", parentId: "p", planningRole: "planning" },
        { id: "b", title: "Payment form", ref: "", position: 3, estimate: "5", estimateNeedsReview: true, parentId: "p", planningRole: "planning" },
        { id: "c", title: "Receipts", ref: "", position: 4, estimate: null, parentId: "p", planningRole: "planning" },
      ];
      renderApp(
        <StoryQueue
          sessionId="sess-1"
          stories={children as unknown as Story[]}
          allStories={[committed, ...children] as unknown as Story[]}
          currentStoryId={null}
          isFacilitator
          onQuickRound={vi.fn()}
          fail={null}
          onFail={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByText("1 estimated, 1 not estimated, 1 to review")).toBeTruthy();
    });
  });
});

describe("a committed ticket in the queue", () => {
  const parent = { id: "p", title: "Checkout", ref: "PAR-150", position: 1, estimate: "13", estimateProvenance: "story-total", planningRole: "context", votedUserIds: [] } as unknown as Story;
  const children = [
    { id: "a", title: "Cart", ref: "", position: 2, estimate: "5", parentId: "p", planningRole: "planning", votedUserIds: [] },
    { id: "b", title: "Payment", ref: "", position: 3, estimate: "8", parentId: "p", planningRole: "planning", votedUserIds: [] },
  ] as unknown as Story[];
  function renderCommitted(currentStoryId: string | null, over: Partial<Story> = {}) {
    const ticket = { ...parent, ...over };
    renderApp(
      <StoryQueue sessionId="sess-1" stories={children} allStories={[ticket, ...children]} currentStoryId={currentStoryId} isFacilitator={false} onQuickRound={vi.fn()} fail={null} onFail={vi.fn()} onDismiss={vi.fn()} />,
    );
    return screen.getByRole("complementary", { name: /Story queue/ });
  }
  it("shows the ticket's own estimate with where it came from", () => {
    expect(within(renderCommitted(null)).getByText((_, node) => node?.textContent === "Ticket: 13 · Story total")).toBeTruthy();
  });
  it("says so when the total is out of date", () => {
    expect(within(renderCommitted(null, { estimateNeedsReview: true })).getByText((_, node) => node?.textContent === "Ticket: Needs review · previous 13")).toBeTruthy();
  });
  it("says the ticket is on the table when it is the one being estimated", () => {
    expect(within(renderCommitted("p", { estimate: null })).getByText("On the table: Checkout")).toBeTruthy();
  });
});
