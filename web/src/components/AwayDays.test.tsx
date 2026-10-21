import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { AwayDays } from "./AwayDays";

let ranges: { id: string; startsOn: string; endsOn: string }[] = [];
let failWrites = false;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: { startsOn: string; endsOn: string }) => {
      if (method === "GET") return { ranges };
      if (failWrites) {
        const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
        throw new ApiError(400, "the last day is before the first");
      }
      if (method === "POST" && body) {
        ranges = [...ranges, { id: `r${ranges.length + 1}`, ...body }];
        return {};
      }
      if (method === "DELETE") {
        ranges = ranges.filter((r) => !path.endsWith(`/${r.id}`));
        return null;
      }
      return null;
    }),
  };
});

describe("AwayDays keyboard path", () => {
  afterEach(() => {
    ranges = [];
    failWrites = false;
  });

  // Adding clears both fields, which disables the button that was just
  // pressed, and removing unmounts the button that was just pressed. Either
  // way the browser dropped focus to the top of the page, so a keyboard user
  // was thrown back to the skip link after every change and heard nothing
  // about whether it had worked.
  it("keeps focus in the form and says it worked after adding", async () => {
    renderApp(<AwayDays />);
    await userEvent.type(screen.getByLabelText("First day away"), "2026-10-20");
    await userEvent.type(screen.getByLabelText("Last day away"), "2026-10-21");
    await userEvent.click(screen.getByRole("button", { name: "Add away days" }));
    await screen.findByRole("button", { name: /Remove away days 2026-10-20/ });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("First day away")));
    expect(screen.getByRole("status").textContent).toMatch(/away days added/i);
  });

  it("keeps focus in the form and says it worked after removing", async () => {
    ranges = [{ id: "r1", startsOn: "2026-10-20", endsOn: "2026-10-21" }];
    renderApp(<AwayDays />);
    await userEvent.click(await screen.findByRole("button", { name: /Remove away days 2026-10-20/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Remove away days/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText("First day away"));
    expect(screen.getByRole("status").textContent).toMatch(/away days removed/i);
  });

  // The request disables the button just pressed whether it works or not, so
  // a refused add dropped focus to the top of the page just as a successful
  // one had.
  it("keeps focus in the form and says why after an add is refused", async () => {
    failWrites = true;
    renderApp(<AwayDays />);
    await userEvent.type(screen.getByLabelText("First day away"), "2026-10-20");
    await userEvent.type(screen.getByLabelText("Last day away"), "2026-10-21");
    await userEvent.click(screen.getByRole("button", { name: "Add away days" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/the last day is before the first/));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("First day away")));
    // The fields keep what was typed, so the fix is one edit away.
    expect((screen.getByLabelText("First day away") as HTMLInputElement).value).toBe("2026-10-20");
  });

  it("keeps focus in the form and says why after a remove is refused", async () => {
    ranges = [{ id: "r1", startsOn: "2026-10-20", endsOn: "2026-10-21" }];
    renderApp(<AwayDays />);
    const remove = await screen.findByRole("button", { name: /Remove away days 2026-10-20/ });
    failWrites = true;
    await userEvent.click(remove);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/the last day is before the first/));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("First day away")));
  });
});
