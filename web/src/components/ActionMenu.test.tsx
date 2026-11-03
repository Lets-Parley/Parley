import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { ActionMenu, menuItem } from "./ActionMenu";

it("keeps its actions out of reach until the trigger opens it, and closes after one runs", async () => {
  let ran = 0;
  renderApp(
    <ActionMenu label="Room" trigger="⋯" triggerClassName="">
      {(close) => (
        <button role="menuitem" className={menuItem} onClick={() => { ran++; close(); }}>
          End session
        </button>
      )}
    </ActionMenu>,
  );
  expect(screen.queryByRole("menuitem", { name: "End session" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Room" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "End session" }));
  expect(ran).toBe(1);
  expect(screen.queryByRole("menuitem", { name: "End session" })).toBeNull();
});
