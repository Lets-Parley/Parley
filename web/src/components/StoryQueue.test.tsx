import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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
      onError={vi.fn()}
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

  it("gives the agreed-estimate chip a real accessible name", () => {
    renderQueue();
    expect(screen.getByRole("img", { name: "Agreed estimate 5" })).toBeTruthy();
  });
});
