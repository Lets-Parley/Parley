import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("opens itself modally on mount", () => {
    render(<Modal title="Reset the round">body</Modal>);
    const dialog = screen.getByRole("dialog");
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });

  it("opens itself with showModal, not show", () => {
    // The distinction is invisible to every other assertion here — the jsdom
    // stub renders show() and showModal() identically — but only showModal()
    // makes the rest of the page inert and traps focus.
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    try {
      render(<Modal title="Reset the round">body</Modal>);
      expect(showModal).toHaveBeenCalled();
    } finally {
      showModal.mockRestore();
    }
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

  it("takes its accessible name from its title", () => {
    render(<Modal title="Reset the round">body</Modal>);
    expect(screen.getByRole("dialog", { name: "Reset the round" })).toBeTruthy();
  });

  it("offers a close affordance when it is dismissable", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Reset the round" onClose={onClose}>
        body
      </Modal>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no close affordance when it cannot be dismissed", () => {
    render(<Modal title="What should we call you?">body</Modal>);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("returns focus to whatever opened it when it goes away", () => {
    // Verified in a real browser: unmounting the <dialog> drops focus to
    // <body> rather than restoring it, so the Modal restores it itself.
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<Modal title="Reset the round" onClose={() => {}}>body</Modal>);
    // The stub's showModal does not move focus, so move it by hand — otherwise
    // the opener never loses focus and the assertion below tests nothing.
    (screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).focus();
    expect(document.activeElement).not.toBe(opener);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("returns focus to the opener even when its effect is mounted twice", () => {
    // React remounts every effect in StrictMode — mount, unmount, mount —
    // without tearing the dialog's DOM node down. Two things that only a real
    // <dialog> does make that sequence bite, so both are modelled here: a
    // second showModal() on an open dialog throws InvalidStateError, and
    // showModal() pulls focus inside the dialog and makes the rest of the page
    // inert. Between them, a naive effect records the close button as the
    // "opener" and restores focus to a node that is about to be removed. The
    // real browser walk is in the PR that added this; the assertion here pins
    // the effect's idempotency, which needs no layout.
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, "showModal")
      .mockImplementation(function (this: HTMLDialogElement) {
        if (this.open) throw new Error("InvalidStateError: dialog is already open");
        this.open = true;
        this.querySelector("button")?.focus();
      });
    // Inertness: while a modal dialog is open, focus() outside it does nothing.
    const realFocus = HTMLElement.prototype.focus;
    const focus = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function (this: HTMLElement) {
        const dialog = document.querySelector("dialog");
        if (dialog?.open && !dialog.contains(this)) return;
        realFocus.call(this);
      });
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    try {
      const view = render(
        <StrictMode>
          <Modal title="Reset the round" onClose={() => {}}>
            body
          </Modal>
        </StrictMode>,
      );
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(opener);
      view.unmount();
      expect(document.activeElement).toBe(opener);
    } finally {
      showModal.mockRestore();
      focus.mockRestore();
      opener.remove();
    }
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
