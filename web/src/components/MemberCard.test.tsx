import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberCard } from "./MemberCard";
import { makePerson, renderApp } from "../test/render";

describe("MemberCard", () => {
  it("does not read a seatless member as sitting at this table", () => {
    // `at` and `activeSessionId` are both undefined here. Comparing them
    // directly makes undefined === undefined true and claims the member is
    // already at a table they have never joined.
    renderApp(
      <MemberCard member={makePerson({ name: "Priya Raman" })} isYou={false} onClose={() => {}} />,
    );
    expect(screen.getByText("not in a session right now")).toBeTruthy();
    expect(screen.getByText("Nothing to join yet")).toBeTruthy();
    expect(screen.queryByText("Already at this table")).toBeNull();
    expect(screen.queryByText("at this table now")).toBeNull();
  });

  it("still reads as seatless when a session is open but the member is not in one", () => {
    renderApp(
      <MemberCard
        member={makePerson({ name: "Priya Raman" })}
        isYou={false}
        activeSessionId="sess-1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Nothing to join yet")).toBeTruthy();
  });

  it("offers a way to go to a member sitting somewhere else", async () => {
    const onClose = vi.fn();
    renderApp(
      <MemberCard
        member={makePerson({ name: "Marcus Okonjo", at: { sessionId: "sess-2", title: "Sprint 12" } })}
        isYou={false}
        activeSessionId="sess-1"
        onClose={onClose}
      />,
    );
    const go = screen.getByRole("button", { name: "Go to Sprint 12" });
    await userEvent.click(go);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers nothing to click when the member is already at this table", () => {
    renderApp(
      <MemberCard
        member={makePerson({ name: "Nina Kowalski", at: { sessionId: "sess-1", title: "Sprint 12" } })}
        isYou={false}
        activeSessionId="sess-1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Already at this table")).toBeTruthy();
    expect(screen.getByText("at this table now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Go to/ })).toBeNull();
  });

  it("never offers to navigate to yourself", () => {
    renderApp(
      <MemberCard
        member={makePerson({ name: "You", at: { sessionId: "sess-2", title: "Sprint 12" } })}
        isYou
        activeSessionId="sess-1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("That's you")).toBeTruthy();
    expect(screen.getByText("you · Sprint 12")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Go to/ })).toBeNull();
  });

  it("is a native dialog named after the member", () => {
    renderApp(<MemberCard member={makePerson({ name: "Dana Whitfield" })} isYou={false} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Dana Whitfield" });
    expect(dialog.tagName).toBe("DIALOG");
  });

  it("strips a bidi override from the dialog name so surrounding chrome stays put", () => {
    renderApp(
      <MemberCard
        member={makePerson({ name: "Alice\u202Ekkad" })}
        isYou={false}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Alicekkad" });
    expect(dialog.getAttribute("aria-label") ?? dialog.textContent).not.toContain("\u202E");
  });

  it("still names the dialog with a legitimate Arabic display name", () => {
    renderApp(
      <MemberCard member={makePerson({ name: "محمد علي" })} isYou={false} onClose={() => {}} />,
    );
    expect(screen.getByRole("dialog", { name: "محمد علي" })).toBeTruthy();
  });

  it("renders the member's name exactly once", () => {
    renderApp(<MemberCard member={makePerson({ name: "Dana Whitfield" })} isYou={false} onClose={() => {}} />);
    expect(screen.getAllByText("Dana Whitfield")).toHaveLength(1);
  });

  // Backdrop-click-to-close is deliberately gone with the hand-rolled backdrop:
  // a native <dialog> does not offer it. Escape and the ✕ are the dismissals.
  it("closes from the ✕", async () => {
    const onClose = vi.fn();
    renderApp(<MemberCard member={makePerson()} isYou={false} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
