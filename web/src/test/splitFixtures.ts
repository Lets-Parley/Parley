import type { Envelope, PlanningDependency, Story } from "../lib/api";

export const parentStory: Story = {
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

export function childStory(id: string, over: Partial<Story> = {}): Story {
  return {
    ...parentStory,
    id,
    parentId: "parent",
    title: id,
    notes: "",
    ref: "",
    estimate: null,
    planningRole: "proposed",
    position: 1,
    ...over,
  };
}

export function adoptedSplit(children: Story[], over: Partial<Story> = {}): Story[] {
  return [
    { ...parentStory, planningRole: "context", coverage: "full", ...over },
    ...children.map((story) => ({ ...story, planningRole: story.planningRole === "proposed" ? ("planning" as const) : story.planningRole })),
  ];
}

export function edge(blockerId: string, dependentId: string, over: Partial<PlanningDependency> = {}): PlanningDependency {
  return {
    id: `${blockerId}->${dependentId}`,
    parentId: "parent",
    blockerId,
    dependentId,
    reviewState: "planning",
    retiredAt: null,
    ...over,
  };
}

export function splitRoom(
  stories: Story[] = [parentStory, childStory("API"), childStory("UI")],
  over: Partial<Envelope["state"]> = {},
): Envelope {
  return {
    id: "session",
    version: 1,
    endedAt: null,
    facilitatorId: "dana",
    state: {
      stories,
      currentStoryId: "parent",
      roundVersion: 4,
      deck: { name: "fib", values: ["1", "3", "5"], ordinal: true },
      autoReveal: false,
      openVoting: false,
      ...over,
    },
  } as Envelope;
}
