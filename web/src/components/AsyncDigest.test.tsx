import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { AsyncDigest } from "./AsyncDigest";
import { makePerson, renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import type { StandupEntry } from "../pages/StandupRoom";

function entry(over: Partial<StandupEntry>): StandupEntry {
  return {
    userId: "dana",
    yesterday: "",
    today: "",
    blockers: "",
    position: 1,
    skipped: false,
    ready: false,
    postedAt: "2026-09-22T09:05:00Z",
    ...over,
  };
}

const people = [
  makePerson({ userId: "dana", name: "Dana Whitfield" }),
  makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
  makePerson({ userId: "priya", name: "Priya Raman" }),
  makePerson({ userId: "sam", name: "Sam Watcher", spectator: true }),
];

const entries = [
  entry({ userId: "dana", today: "ship the digest\nthen the docs", position: 1 }),
  entry({ userId: "marcus", today: "review", blockers: "waiting on staging", position: 2, postedAt: "2026-09-22T18:40:00Z" }),
];

describe("AsyncDigest", () => {
  it("orders blockers, then updates, then answered and not yet", () => {
    renderApp(<AsyncDigest entries={entries} participants={people} ended={false} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Blockers", "Updates", "Answered", "Not yet"]);

    const blockers = screen.getByRole("region", { name: "Blockers" });
    expect(blockers.textContent).toContain("Marcus Okonjo");
    expect(blockers.textContent).toContain("waiting on staging");
    expect(blockers.textContent).not.toContain("Dana Whitfield");

    // Collapsed to the first line until opened.
    const dana = screen.getByText("Dana Whitfield", { selector: "summary span" }).closest("details")!;
    expect(dana.open).toBe(false);
    const summary = within(dana).getByText("ship the digest");
    expect(summary.closest("summary")).toBeTruthy();
    expect(summary.textContent).not.toContain("then the docs");

    // Spectators are not waited on; nobody gets a count or red styling.
    const notYet = screen.getByRole("region", { name: "Not yet" });
    expect(notYet.textContent).toContain("Priya Raman");
    expect(notYet.textContent).not.toContain("Sam Watcher");
    expect(notYet.innerHTML).not.toMatch(/text-stop/);
    expect(notYet.textContent).not.toMatch(/\d/);
    expect(screen.getByRole("region", { name: "Answered" }).textContent).toContain("Dana Whitfield");
  });

  it("shows a late answer's posted time like any other", () => {
    renderApp(<AsyncDigest entries={entries} participants={people} ended={false} />);
    const times = document.querySelectorAll("time");
    expect([...times].map((t) => t.getAttribute("datetime"))).toEqual([
      "2026-09-22T09:05:00Z",
      "2026-09-22T18:40:00Z",
    ]);
    for (const t of times) expect(t.textContent).toMatch(/^posted /);
  });

  it("keeps entries only once the standup has ended", () => {
    renderApp(<AsyncDigest entries={entries} participants={people} ended />);
    expect(screen.queryByRole("heading", { name: "Not yet" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Answered" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Updates" })).toBeTruthy();
  });

  it("says so when nobody has answered", () => {
    renderApp(<AsyncDigest entries={[]} participants={people} ended={false} />);
    expect(screen.getByText(/no updates yet/i)).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = renderApp(<AsyncDigest entries={entries} participants={people} ended={false} />);
    await expectNoViolations(container);
  });
});
