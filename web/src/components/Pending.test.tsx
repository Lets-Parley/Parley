import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Pending } from "./Pending";

afterEach(() => vi.useRealTimers());

describe("Pending", () => {
  it("escalates to a reload after ten seconds", () => {
    vi.useFakeTimers();
    render(<Pending>Finding the table…</Pending>);
    expect(screen.getByText("Finding the table…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBe(null);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/still loading/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
