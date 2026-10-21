import type { PlanningDependency, Story } from "./api";

export function storyIdentity(story: Story | undefined, id: string) {
  return `${story?.title || "Unavailable story"} · ID ${id}`;
}
export function dependencyNeedsReview(edge: PlanningDependency, stories: Story[]) {
  return edge.reviewState !== "planning" || [edge.blockerId, edge.dependentId].some((id) => {
    const s = stories.find((s) => s.id === id);
    return !s || Boolean(s.removedAt);
  });
}
