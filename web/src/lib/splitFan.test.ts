import { describe, expect, it } from "vitest";
import { adoptedSplit, childStory, edge, parentStory, splitRoom } from "../test/splitFixtures";
import type { Story } from "./api";
import {
  adoptionRequest,
  blockReason,
  canBeSplit,
  canRefreshTotal,
  isParentEstimateDue,
  nextStoryToEstimate,
  parentDeclineRequest,
  parentTotalRequest,
  provenanceText,
  storyTotal,
  canDealWithoutReview,
  canReconfirmCoverage,
  countSentence,
  coverageStanding,
  estimateCounts,
  estimateCountsText,
  focusedParentId,
  leftoverRequest,
  mayExistInTracker,
  pastedTitles,
  publicationSentence,
  recordedLeftoverId,
  removalRefusal,
  removalRequest,
  splitFanOf,
  splitStateText,
  undoSplitRequest,
  undoSplitSentence,
  briefNameOf,
} from "./splitFan";

const other: Story = { ...parentStory, id: "other", title: "Other ticket", ref: "PAR-2" };

function fanOf(stories: Story[], dependencies = [] as ReturnType<typeof edge>[]) {
  return splitFanOf(splitRoom(stories, { dependencies }).state, "parent")!;
}

describe("which split the room looks at", () => {
  it("shows none in an ordinary round", () => {
    expect(focusedParentId(splitRoom([parentStory, other]).state, null)).toBeNull();
  });
  it("follows the story on the table to its parent", () => {
    const state = splitRoom([parentStory, childStory("API"), other], { currentStoryId: "API" }).state;
    expect(focusedParentId(state, null)).toBe("parent");
  });
  it("leaves a split alone while an unrelated story is on the table", () => {
    const state = splitRoom([parentStory, childStory("API"), other], { currentStoryId: "other" }).state;
    expect(focusedParentId(state, null)).toBeNull();
    expect(focusedParentId(state, "parent")).toBe("parent");
  });
  it("keeps the unfinished split in view when nothing is on the table", () => {
    const done = { ...other, planningRole: "context" as const };
    const state = splitRoom(
      [...adoptedSplit([childStory("API"), childStory("UI")]), done, childStory("Done", { parentId: "other", planningRole: "planning", estimate: "3" })],
      { currentStoryId: null },
    ).state;
    expect(focusedParentId(state, null)).toBe("parent");
  });
  it("forgets a split whose every card was removed", () => {
    const state = splitRoom([parentStory, childStory("API", { removedAt: "now" })]).state;
    expect(focusedParentId(state, null)).toBeNull();
  });
  it("lets only a top-level story that is still there be split", () => {
    expect(canBeSplit(parentStory)).toBe(true);
    expect(canBeSplit(childStory("API"))).toBe(false);
    expect(canBeSplit({ ...parentStory, removedAt: "now" })).toBe(false);
    expect(canBeSplit(undefined)).toBe(false);
  });
});

describe("what may wait on what", () => {
  const stories = [parentStory, childStory("A"), childStory("B"), childStory("C"), childStory("D")];
  it("refuses a story waiting on itself", () => {
    expect(blockReason(fanOf(stories), "A", "A")).toBe("A story cannot wait on itself");
  });
  it("refuses a loop at any distance", () => {
    const fan = fanOf(stories, [edge("A", "B"), edge("B", "C")]);
    expect(blockReason(fan, "A", "B")).toBe("It already waits on this story");
    expect(blockReason(fan, "A", "C")).toBe("It already waits on this story");
    expect(blockReason(fan, "D", "A")).toBe("");
    expect(blockReason(fan, "C", "A")).toBe("");
  });
  it("does not count a link under review as a path", () => {
    const fan = fanOf(stories, [edge("A", "B", { reviewState: "review-needed" })]);
    expect(blockReason(fan, "A", "B")).toBe("");
  });
});

describe("the count sentence", () => {
  it("counts stories, not points", () => {
    const fan = fanOf(adoptedSplit([childStory("A", { estimate: "3" }), childStory("B", { estimate: "8" }), childStory("C", { estimate: "5" }), childStory("D")]));
    expect(countSentence(fan)).toBe("4 stories. 3 estimated, 1 not estimated.");
  });
  it("names an estimate that needs review apart from both", () => {
    const fan = fanOf(adoptedSplit([childStory("A", { estimate: "3" }), childStory("B", { estimate: "8", estimateNeedsReview: true })]));
    expect(countSentence(fan)).toBe("2 stories. 1 estimated, 0 not estimated, 1 to review.");
  });
  it("says where the split stands", () => {
    expect(splitStateText(fanOf([parentStory, childStory("A")]))).toBe("Splitting");
    expect(splitStateText(fanOf([...adoptedSplit([childStory("A"), childStory("B")]), childStory("C")]))).toBe(
      "Split into 2 stories · 1 more drafted",
    );
    expect(splitStateText(fanOf(adoptedSplit([childStory("A"), childStory("B", { isRemainder: true })], { coverage: "needs-review" })))).toBe(
      "Split into 2 stories · leftover needs review",
    );
  });
  it("never claims a leftover needs review when no story is the leftover", () => {
    const unconfirmed = fanOf(adoptedSplit([childStory("A"), childStory("B")], { coverage: "needs-review" }));
    expect(splitStateText(unconfirmed)).toBe("Split into 2 stories · not confirmed since it changed");
    expect(coverageStanding(unconfirmed)).toBe("unconfirmed");
    expect(canReconfirmCoverage(unconfirmed)).toBe(true);
    const withDraft = fanOf([...adoptedSplit([childStory("A"), childStory("B")], { coverage: "needs-review" }), childStory("C")]);
    expect(splitStateText(withDraft)).toBe("Split into 2 stories · 1 more drafted");
    expect(canReconfirmCoverage(withDraft)).toBe(false);
    expect(coverageStanding(fanOf(adoptedSplit([childStory("A"), childStory("B")])))).toBe("confirmed");
  });
  it("counts stories to review in the same words wherever the split is summarized", () => {
    const stories = [childStory("A", { estimate: "3" }), childStory("B", { estimate: "5", estimateNeedsReview: true }), childStory("C")];
    expect(estimateCountsText(estimateCounts(stories))).toBe("1 estimated, 1 not estimated, 1 to review");
    expect(countSentence(fanOf(adoptedSplit(stories)))).toBe("3 stories. 1 estimated, 1 not estimated, 1 to review.");
  });
  it("deals a story after a commit only when no earlier votes would need a fresh round", () => {
    expect(canDealWithoutReview(childStory("A"))).toBe(true);
    expect(canDealWithoutReview(childStory("A", { votedUserIds: ["mel"] }))).toBe(false);
  });
});

describe("the leftover story a split already names", () => {
  it("is none for a draft and for a split that covered everything", () => {
    expect(recordedLeftoverId(fanOf([parentStory, childStory("A")]))).toBeNull();
    expect(recordedLeftoverId(fanOf(adoptedSplit([childStory("A"), childStory("B")])))).toBeNull();
  });
  it("is the story the committed split flagged, and not one that was removed", () => {
    const withRemainder = adoptedSplit([childStory("A"), childStory("B", { isRemainder: true })], { coverage: "remainder" });
    expect(recordedLeftoverId(fanOf(withRemainder))).toBe("B");
    const removedRemainder = adoptedSplit([childStory("A"), childStory("B", { isRemainder: true, removedAt: "today" })], { coverage: "remainder" });
    expect(recordedLeftoverId(fanOf(removedRemainder))).toBeNull();
  });
});

describe("what a commit sends about leftover scope", () => {
  const round = { currentStoryId: null, roundVersion: 3 };
  it("is full coverage unless an active story is recorded as the leftover", () => {
    const fan = fanOf([parentStory, childStory("A"), childStory("B")]);
    expect(adoptionRequest(fan, round)).toMatchObject({ coverage: "full" });
    expect("remainderId" in adoptionRequest(fan, round)).toBe(false);
    const named = fanOf([parentStory, childStory("A"), childStory("B", { isRemainder: true })]);
    expect(adoptionRequest(named, round)).toMatchObject({ coverage: "remainder", remainderId: "B" });
    const removed = fanOf([parentStory, childStory("A"), childStory("B", { isRemainder: true, removedAt: "today" })]);
    expect(adoptionRequest(removed, round)).toMatchObject({ coverage: "full" });
  });
  it("names or clears the leftover against the split revision it saw", () => {
    const fan = fanOf([parentStory, childStory("A"), childStory("B")]);
    expect(leftoverRequest(fan, "B")).toEqual({ parentId: "parent", storyId: "B", expectedSplitRevision: 2 });
    expect(leftoverRequest(fan, "", 5)).toEqual({ parentId: "parent", storyId: "", expectedSplitRevision: 5 });
  });
});

describe("pasted lists", () => {
  it("takes one title per line and drops list markers and blanks", () => {
    expect(pastedTitles("- One\n* Two\r\n3. Three\n\n  [ ] Four\n4) Five\nSix - not a marker")).toEqual([
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six - not a marker",
    ]);
  });
  it("leaves a single line to the input", () => {
    expect(pastedTitles("Just one")).toEqual(["Just one"]);
  });
});

describe("the publication summary", () => {
  const fan = fanOf(adoptedSplit([childStory("A"), childStory("B"), childStory("C"), childStory("D")]));
  const created = (childId: string, state: string) => ({ kind: "create", state, childId });
  it("says how many were created out of how many", () => {
    const receipts = [created("A", "confirmed"), created("B", "confirmed"), created("C", "confirmed"), created("D", "pending")];
    expect(publicationSentence(fan, receipts)).toBe("3 of 4 created");
  });
  it("keeps failed and unknown apart from created", () => {
    const receipts = [created("A", "confirmed"), created("B", "failed"), created("C", "unknown")];
    expect(publicationSentence(fan, receipts)).toBe("1 of 4 created · 1 not created · 1 unknown");
  });
  it("does not count another step's receipt as a created story", () => {
    expect(publicationSentence(fan, [{ kind: "estimate", state: "confirmed", childId: "A" }])).toBe("0 of 4 created");
  });
});

describe("undoing a split", () => {
  const round = { currentStoryId: null, roundVersion: 4 };
  it("names the parent revisions it saw and touches the round only when one of its stories is on the table", () => {
    const fan = fanOf(adoptedSplit([childStory("API"), childStory("UI")]));
    const seen = { parentId: "parent", expectedRevision: 1, expectedSplitRevision: 2, children: { API: 1, UI: 1 } };
    expect(undoSplitRequest(fan, round)).toEqual(seen);
    expect(undoSplitRequest(fan, { currentStoryId: "other", roundVersion: 4 })).toEqual(seen);
    expect(undoSplitRequest(fan, { currentStoryId: "UI", roundVersion: 4 })).toEqual({
      parentId: "parent",
      expectedRevision: 1,
      expectedSplitRevision: 2,
      children: { API: 1, UI: 1 },
      endRound: true,
      expectedCurrentStoryId: "UI",
      expectedRoundVersion: 4,
    });
  });
  it("says what happens in the room's own words, and mentions estimates only when there are some", () => {
    expect(undoSplitSentence(fanOf(adoptedSplit([childStory("API"), childStory("UI")])))).toBe(
      "PAR-1 becomes one story again. The 2 stories are kept as drafts you can come back to.",
    );
    expect(undoSplitSentence(fanOf(adoptedSplit([childStory("API", { estimate: "3" }), childStory("UI"), childStory("Docs")], { ref: "" })))).toBe(
      "Parent becomes one story again. The 3 stories are kept as drafts you can come back to. Estimates set on them are kept and marked for review.",
    );
  });
  it("treats a story as possibly in the tracker unless its creation is known not to have happened", () => {
    const receipt = (state: string, kind = "create") => [{ kind, state, childId: "API" }];
    for (const state of ["unknown", "confirmed"]) expect(mayExistInTracker(receipt(state))).toBe(true);
    for (const state of ["pending", "failed", "local-only", "waiting-for-issues"]) expect(mayExistInTracker(receipt(state))).toBe(false);
    expect(mayExistInTracker(receipt("confirmed", "estimate"))).toBe(false);
    expect(mayExistInTracker([])).toBe(false);
  });
  it("names the round a removal ends only when the removed story is the one on the table", () => {
    const fan = fanOf(adoptedSplit([childStory("API"), childStory("UI"), childStory("Docs")]));
    expect(removalRequest(fan, fan.planning[0], { currentStoryId: "API", roundVersion: 7 })).toMatchObject({
      storyId: "API",
      endRound: true,
      expectedCurrentStoryId: "API",
      expectedRoundVersion: 7,
    });
    expect(removalRequest(fan, fan.planning[1], { currentStoryId: "API", roundVersion: 7 })).not.toHaveProperty("endRound");
    expect(removalRequest(fan, fan.planning[0])).not.toHaveProperty("endRound");
  });
  it("refuses removal only where the server would: the last two committed stories and the leftover story", () => {
    const pair = fanOf([...adoptedSplit([childStory("API"), childStory("UI")]), childStory("Late")]);
    expect(removalRefusal(pair, pair.planning[0])).toBe("A split keeps at least two stories.");
    expect(removalRefusal(pair, pair.drafted[0])).toBe("");
    const trio = fanOf(adoptedSplit([childStory("API"), childStory("UI"), childStory("Rest", { isRemainder: true })]));
    expect(removalRefusal(trio, trio.planning[0])).toBe("");
    expect(removalRefusal(trio, trio.planning[2])).toBe("A split keeps its leftover story.");
    const draft = fanOf([parentStory, childStory("API"), childStory("UI")]);
    expect(removalRefusal(draft, draft.children[0])).toBe("");
  });
});

describe("estimating a committed split story by story", () => {
  const settled = (id: string, estimate: string, over: Partial<Story> = {}) => childStory(id, { estimate, ...over });
  it("moves to the next story of the same split that has no current estimate, in order, wrapping past settled ones", () => {
    const fan = fanOf(adoptedSplit([settled("A", "3"), childStory("B"), settled("C", "5"), childStory("D"), childStory("E", { estimate: "8", estimateNeedsReview: true })]));
    expect(nextStoryToEstimate(fan, "A")?.id).toBe("B");
    expect(nextStoryToEstimate(fan, "B")?.id).toBe("D");
    expect(nextStoryToEstimate(fan, "D")?.id).toBe("E");
    expect(nextStoryToEstimate(fan, "E")?.id).toBe("B");
    expect(nextStoryToEstimate(fan, null)?.id).toBe("B");
  });
  it("never offers the story it starts from while another is open, and offers nothing once all are settled", () => {
    const fan = fanOf(adoptedSplit([childStory("A"), settled("B", "3")]));
    expect(nextStoryToEstimate(fan, "A")).toBeUndefined();
    expect(nextStoryToEstimate(fan, "B")?.id).toBe("A");
    expect(nextStoryToEstimate(fanOf(adoptedSplit([settled("A", "1"), settled("B", "3")])), "A")).toBeUndefined();
  });
  it("skips removed stories and drafts added under the committed split", () => {
    const stories = adoptedSplit([settled("A", "3"), childStory("Gone", { removedAt: "2026-10-10" }), childStory("B")]);
    stories.push(childStory("Draft"));
    expect(nextStoryToEstimate(fanOf(stories), "A")?.id).toBe("B");
    expect(nextStoryToEstimate(fanOf(stories), "B")).toBeUndefined();
  });
});

describe("the total of a committed split", () => {
  const numeric = { name: "fibonacci", values: ["½", "1", "2", "3", "5", "8"], ordinal: false };
  const settled = (id: string, estimate: string, over: Partial<Story> = {}) => childStory(id, { estimate, ...over });
  it("adds the stories exactly, counts the half card as 0.5 and drops trailing zeros", () => {
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "3"), settled("B", "5"), settled("C", "8")])), numeric)).toBe("16");
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "½"), settled("B", "8")])), numeric)).toBe("8.5");
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "½"), settled("B", "½")])), numeric)).toBe("1");
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "0.1"), settled("B", "0.2")])), numeric)).toBe("0.3");
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "½")])), numeric)).toBe("0.5");
  });
  it("has no total while a story is unestimated, needs review, or is not a number, or the deck is not numeric", () => {
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "3"), childStory("B")])), numeric)).toBeNull();
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "3"), settled("B", "5", { estimateNeedsReview: true })])), numeric)).toBeNull();
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "3"), settled("B", "M")])), numeric)).toBeNull();
    expect(storyTotal(fanOf(adoptedSplit([settled("A", "3"), settled("B", "5")])), { ...numeric, ordinal: true })).toBeNull();
    expect(storyTotal(fanOf([parentStory, childStory("A", { estimate: "3" }), childStory("B", { estimate: "5" })]), numeric)).toBeNull();
  });
  it("leaves removed stories and new drafts out of the total", () => {
    const stories = adoptedSplit([settled("A", "3"), settled("B", "5"), settled("Gone", "8", { removedAt: "2026-10-10" })]);
    stories.push(childStory("Draft", { estimate: "13" }));
    expect(storyTotal(fanOf(stories), numeric)).toBe("8");
  });
});

describe("asking about the parent of a finished split", () => {
  const settled = (id: string, estimate: string, over: Partial<Story> = {}) => childStory(id, { estimate, ...over });
  const finished = (over: Partial<Story> = {}) => fanOf(adoptedSplit([settled("A", "3"), settled("B", "5")], { estimate: null, ...over }));
  it("is due once every story is settled and the question was not answered for this split revision", () => {
    expect(isParentEstimateDue(finished())).toBe(true);
    expect(isParentEstimateDue(finished({ parentEstimateAnsweredRevision: 1 }))).toBe(true);
    expect(isParentEstimateDue(finished({ parentEstimateAnsweredRevision: 2 }))).toBe(false);
    expect(isParentEstimateDue(finished({ estimate: "8", estimateProvenance: "story-total" }))).toBe(false);
    expect(isParentEstimateDue(fanOf(adoptedSplit([settled("A", "3"), childStory("B")], { estimate: null })))).toBe(false);
    expect(isParentEstimateDue(fanOf([{ ...parentStory, estimate: null }, settled("A", "3"), settled("B", "5")]))).toBe(false);
  });
  it("offers to refresh only a total that needs review and can be added up again", () => {
    const numeric = { name: "fibonacci", values: ["3", "5"], ordinal: false };
    expect(canRefreshTotal(finished({ estimate: "5", estimateProvenance: "story-total", estimateNeedsReview: true }), numeric)).toBe(true);
    expect(canRefreshTotal(finished({ estimate: "8", estimateProvenance: "story-total" }), numeric)).toBe(false);
    expect(canRefreshTotal(finished({ estimate: "8", estimateProvenance: "poker", estimateNeedsReview: true }), numeric)).toBe(false);
  });
  it("sends the total it showed with every revision it saw, and a decline with the split revision alone", () => {
    const fan = finished();
    expect(parentTotalRequest(fan, "8")).toEqual({
      parentId: "parent",
      answer: "total",
      expectedRevision: 1,
      expectedSplitRevision: 2,
      expectedTotal: "8",
      children: { A: 1, B: 1 },
    });
    expect(parentDeclineRequest(fan)).toEqual({ parentId: "parent", answer: "none", expectedSplitRevision: 2 });
  });
  it("names every provenance, including a total", () => {
    expect(provenanceText("story-total")).toBe("Story total");
    expect(provenanceText("poker")).toBe("Poker");
    expect(provenanceText("facilitator-set")).toBe("Facilitator-set");
    expect(provenanceText("historical")).toBe("Historical");
    expect(provenanceText(null)).toBe("Historical");
  });
});

it("shortens a long name for a question's sentence and leaves a short one alone", () => {
  expect(briefNameOf("Cart API")).toBe("Cart API");
  const long = "A".repeat(120);
  expect(briefNameOf(long)).toBe("A".repeat(47) + "…");
  expect(briefNameOf(long).length).toBe(48);
});
