import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Commitments, type Commitment } from "./Commitments";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";

const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c1",
  userId: "u1",
  text: "Ship the migration",
  carried: 1,
  stuck: false,
  openedHere: false,
  ...over,
});

const props = {
  meId: "u1",
  onAdd: async () => true,
  onAnswer: async () => true,
  onRemove: async () => true,
  onDrop: async () => true,
};

describe("a row that leaves while it holds focus", () => {
  it("hands focus to the add box when a carried-over row is dropped by a broadcast", async () => {
    const user = userEvent.setup();
    const { rerender } = renderApp(<Commitments {...props} commitments={[commitment()]} />);

    await user.click(screen.getByRole("button", { name: "Done" }));
    // The row keeps focus while it is held for its let-go beat.
    expect(document.activeElement).not.toBe(document.body);

    // The broadcast drops it, and the let-go beat finishes: the row goes.
    rerender(<Commitments {...props} commitments={[]} />);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Add a commitment")),
    );
  });

  it("hands focus to the add box when a taken-on-now row is dropped after a confirmed Remove", async () => {
    const user = userEvent.setup();
    const { rerender } = renderApp(
      <Commitments {...props} commitments={[commitment({ openedHere: true })]} />,
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));
    expect(document.activeElement).not.toBe(document.body);

    rerender(<Commitments {...props} commitments={[]} />);

    expect(document.activeElement).toBe(screen.getByLabelText("Add a commitment"));
  });
});

describe("a confirmed remove", () => {
  it("does not leave Remove it live for a second delete while the row is still on screen", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => true);
    renderApp(<Commitments {...props} onRemove={onRemove} commitments={[commitment()]} />);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("follow-through", () => {
  it("answers a carried-over commitment with done, still on it or dropped, as one labelled group", () => {
    renderApp(<Commitments {...props} onDrop={async () => true} commitments={[commitment()]} />);
    const group = screen.getByRole("group", { name: "How did it go?" });
    const names = within(group).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Done", "Still on it", "Dropped"]);
  });

  it("drops from the keyboard, and says dropped rather than landed", async () => {
    const user = userEvent.setup();
    const onDrop = vi.fn(async () => true);
    const onAnswer = vi.fn(async () => true);
    renderApp(
      <Commitments {...props} onAnswer={onAnswer} onDrop={onDrop} commitments={[commitment()]} />,
    );
    screen.getByRole("button", { name: "Dropped" }).focus();
    await user.keyboard("{Enter}");
    expect(onDrop).toHaveBeenCalledWith("c1");
    expect(onAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Dropped.")).toBeTruthy());
    expect(screen.queryByText(/landed/i)).toBeNull();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderApp(
      <Commitments {...props} onDrop={async () => true} commitments={[commitment()]} />,
    );
    await expectNoViolations(container);
  });
});
