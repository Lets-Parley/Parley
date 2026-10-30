import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import App from "./App";

vi.mock("./pages/OrgDirectory", () => new Promise(() => {}));

afterEach(() => window.history.replaceState(null, "", "/"));

it("announces loading while the next page is downloading", () => {
  window.history.replaceState(null, "", "/o/acme");
  render(<App />);
  expect(screen.getByText("Loading page…").getAttribute("role")).toBe("status");
});

it("escalates a stalled page download to a reload", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "/o/acme");
    render(<App />);
    expect(screen.queryByRole("button", { name: "Reload" })).toBe(null);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
