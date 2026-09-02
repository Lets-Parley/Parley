import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Commitments, type Commitment } from "./Commitments";
import { renderApp } from "../test/render";

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
};

describe("a row that leaves while it holds focus", () => {
  it("hands focus to the add box when a carried-over row is dropped by a broadcast", async () => {
    const user = userEvent.setup();
    const { rerender } = renderApp(<Commitments {...props} commitments={[commitment()]} />);

    await user.click(screen.getByRole("button", { name: "Yes" }));
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
