import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  onUndo: async () => true,
};

describe("a row that leaves while it holds focus", () => {
  it("wraps a long unbroken commitment and asks a short question", () => {
    renderApp(<Commitments {...props} commitments={[commitment({ text: "z".repeat(150) })]} />);
    expect(screen.getByText("z".repeat(150)).className).toMatch(/wrap-anywhere/);
    expect(screen.getByLabelText("Add a commitment").getAttribute("placeholder")).toBe("What will you get done?");
  });

  it("D-046: leaves Done outlined until it is chosen", () => {
    renderApp(<Commitments {...props} commitments={[commitment()]} />);
    const done = screen.getByRole("button", { name: "Done" });
    expect(done.className).not.toMatch(/(^|\s)bg-go/);
    expect(done.className).toMatch(/hover:bg-go/);
  });

  it("keeps Remove out of the row until the commitment actions are opened", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => true);
    renderApp(<Commitments {...props} onRemove={onRemove} commitments={[commitment()]} />);
    const actions = screen.getByRole("button", { name: "Commitment actions" });
    const description = document.getElementById(actions.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Ship the migration");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    await user.click(actions);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove" }));
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Commitment actions" }));
    expect(onRemove).not.toHaveBeenCalled();
  });

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

    await user.click(screen.getByRole("button", { name: "Commitment actions" }));
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

    await user.click(screen.getByRole("button", { name: "Commitment actions" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("follow-through", () => {
  it("answers a carried-over commitment with done, still on it or dropped, as one labeled group", () => {
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

  it("holds a dropped receipt across the broadcast and undoes that exact closure", async () => {
    const user = userEvent.setup();
    const closedAt = "2026-11-18T12:00:00Z";
    let finishDrop!: (receipt: { closedAt: string }) => void;
    const onDrop = vi.fn(() => new Promise<{ closedAt: string }>((resolve) => { finishDrop = resolve; }));
    const onUndo = vi.fn(async () => true);
    const { rerender } = renderApp(
      <Commitments {...props} onDrop={onDrop} onUndo={onUndo} commitments={[commitment()]} />,
    );
    await user.click(screen.getByRole("button", { name: "Dropped" }));
    rerender(<Commitments {...props} onDrop={onDrop} onUndo={onUndo} commitments={[]} />);
    expect(screen.getByText("Ship the migration")).toBeTruthy();
    await act(async () => finishDrop({ closedAt }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledWith("c1", closedAt);
    rerender(<Commitments {...props} onDrop={onDrop} onUndo={onUndo} commitments={[commitment()]} />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("expires an undo receipt after five seconds and returns focus to the add field", async () => {
    vi.useFakeTimers();
    try {
      const withReceipt = { ...props, onAnswer: async () => ({ closedAt: "2026-11-18T12:00:00Z" }) };
      const { rerender } = renderApp(<Commitments {...withReceipt} commitments={[commitment()]} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
      rerender(<Commitments {...withReceipt} commitments={[]} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
      screen.getByRole("button", { name: "Undo" }).focus();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText("Add a commitment"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = renderApp(
      <Commitments {...props} onDrop={async () => true} commitments={[commitment()]} />,
    );
    await expectNoViolations(container);
  });
});
