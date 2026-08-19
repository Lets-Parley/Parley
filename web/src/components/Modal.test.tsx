import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("opens itself modally on mount", () => {
    render(<Modal title="Reset the round">body</Modal>);
    const dialog = screen.getByRole("dialog");
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });

  it("shows its title and children", () => {
    render(<Modal title="Reset the round">Are you sure?</Modal>);
    expect(screen.getByRole("heading", { name: "Reset the round" })).toBeTruthy();
    expect(screen.getByText("Are you sure?")).toBeTruthy();
  });

  it("reports a dismissal to the caller", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Reset the round" onClose={onClose}>
        body
      </Modal>,
    );
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    expect(onClose).toHaveBeenCalled();
  });

  it("survives having no close handler", () => {
    render(<Modal title="Reset the round">body</Modal>);
    expect(() => (screen.getByRole("dialog") as HTMLDialogElement).close()).not.toThrow();
  });

  it("caps its width to the viewport so a wide modal cannot overflow a phone", () => {
    render(
      <Modal title="Reset the round" width="40rem">
        body
      </Modal>,
    );
    expect(screen.getByRole("dialog").style.width).toContain("92vw");
  });
});
