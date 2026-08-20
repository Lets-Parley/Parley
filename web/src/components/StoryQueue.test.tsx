import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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

  it("falls back to the ticket ref when a story has no title", () => {
    renderApp(
      <StoryQueue
        sessionId="sess-1"
        stories={[{ id: "s9", title: "", ref: "PAR-142", position: 1, estimate: null }] as unknown as Story[]}
        currentStoryId={null}
        isFacilitator
        onQuickRound={vi.fn()}
        onError={vi.fn()}
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
    // The submit guard is behaviour, not an attribute: a ref with no title has
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
});
