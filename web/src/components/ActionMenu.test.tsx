import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { ActionMenu, menuItem } from "./ActionMenu";

function renderMenu(onRun: () => void = () => {}) {
  return renderApp(
    <>
      <ActionMenu label="Room" trigger="⋯" triggerClassName="">
        {(close) => (
          <>
            <button type="button" className={menuItem} onClick={() => { onRun(); close(); }}>
              End session
            </button>
            <a href="/export.csv" className={menuItem}>Export CSV</a>
          </>
        )}
      </ActionMenu>
      <button type="button">Elsewhere</button>
    </>,
  );
}
const trigger = () => screen.getByRole("button", { name: "Room" });
const endSession = () => screen.queryByRole("button", { name: "End session" });

describe("ActionMenu without the popover API", () => {
  it("keeps its actions out of reach until the trigger opens it, and closes after one runs", async () => {
    const ran = vi.fn();
    renderMenu(ran);
    expect(endSession()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Room" })).toBeTruthy();
    await userEvent.click(endSession()!);
    expect(ran).toHaveBeenCalledOnce();
    expect(endSession()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("is a disclosure, not an ARIA menu", async () => {
    renderMenu();
    await userEvent.click(trigger());
    expect(trigger().getAttribute("aria-haspopup")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderMenu();
    await userEvent.click(trigger());
    expect(endSession()).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(endSession()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a press outside, but not on one inside", async () => {
    renderMenu();
    await userEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole("group", { name: "Room" }));
    expect(endSession()).toBeTruthy();
    // Nothing focusable is pressed, so no blur can be what closes it.
    fireEvent.pointerDown(document.body);
    expect(endSession()).toBeNull();
  });

  it("closes when Tab leaves the list", async () => {
    renderMenu();
    await userEvent.click(trigger());
    expect(document.activeElement).toBe(endSession());
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Export CSV" }));
    expect(endSession()).toBeTruthy();
    await userEvent.tab();
    expect(endSession()).toBeNull();
  });

  it("has no accessibility violations while open", async () => {
    const { container } = renderMenu();
    await userEvent.click(trigger());
    await expectNoViolations(container);
  });
});

describe("ActionMenu on the popover API", () => {
  const open = new WeakSet<Element>();
  const matches = Element.prototype.matches;
  const shown = vi.fn();
  const hidden = vi.fn();

  beforeEach(() => {
    shown.mockClear();
    hidden.mockClear();
    Object.assign(HTMLElement.prototype, {
      // jsdom hides any [popover]; a real engine shows it while open.
      showPopover(this: HTMLElement) { open.add(this); this.style.display = "block"; shown(); },
      hidePopover(this: HTMLElement) { open.delete(this); this.style.display = ""; hidden(); },
    });
    Element.prototype.matches = function (this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    } as typeof Element.prototype.matches;
  });
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    Element.prototype.matches = matches;
  });

  it("shows the popover on open and hides it, unmounted, when the trigger toggles it closed", async () => {
    renderMenu();
    await userEvent.click(trigger());
    expect(shown).toHaveBeenCalledOnce();
    expect(screen.getByRole("group", { name: "Room" }).getAttribute("popover")).toBe("auto");
    await userEvent.click(trigger());
    expect(hidden).toHaveBeenCalledOnce();
    expect(endSession()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("unmounts when the platform dismisses it, and Tab out hides it", async () => {
    renderMenu();
    await userEvent.click(trigger());
    const list = screen.getByRole("group", { name: "Room" });
    const toggle = new Event("toggle");
    Object.assign(toggle, { newState: "closed" });
    act(() => { list.dispatchEvent(toggle); });
    expect(endSession()).toBeNull();

    await userEvent.click(trigger());
    await userEvent.tab();
    await userEvent.tab();
    expect(endSession()).toBeNull();
    expect(hidden).toHaveBeenCalled();
  });

  it("has no accessibility violations while open", async () => {
    const { container } = renderMenu();
    await userEvent.click(trigger());
    await expectNoViolations(container);
  });
});
