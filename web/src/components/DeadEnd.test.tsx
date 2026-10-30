import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { DeadEnd } from "./DeadEnd";

describe("DeadEnd", () => {
  it("is a main landmark with a headline, a reason and a way home", async () => {
    const { container } = renderApp(<DeadEnd title="Nothing here" why="It moved." />);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Nothing here" })).toBeTruthy();
    expect(screen.getByText("It moved.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your spaces" }).getAttribute("href")).toBe("/");
    await expectNoViolations(container);
  });

  it("names the tab and moves focus to the headline", () => {
    document.title = "Parley";
    renderApp(<DeadEnd title="Nothing here" why="It moved." />);
    expect(document.title).toBe("Nothing here");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Nothing here" }));
  });

  it("can leave out the way home for someone who has no spaces to go back to", () => {
    renderApp(<DeadEnd title="Nothing here" why="It moved." home={false} />);
    expect(screen.queryByRole("link")).toBe(null);
  });
});
