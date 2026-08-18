import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("says nothing while the socket is live", () => {
    const { container } = render(<ConnectionBanner status="live" />);
    expect(container.firstChild).toBeNull();
  });

  it("reassures while reconnecting, and offers no retry yet", () => {
    render(<ConnectionBanner status="reconnecting" onRetry={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("your vote is safe");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the failure and what it means for the board once stale", () => {
    render(<ConnectionBanner status="stale" />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Connection lost");
    expect(text).toContain("Votes may be out of date");
  });

  it("offers the one action when there is something to do", async () => {
    const onRetry = vi.fn();
    render(<ConnectionBanner status="stale" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows no retry button when no handler was supplied", () => {
    render(<ConnectionBanner status="stale" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces politely rather than interrupting", () => {
    render(<ConnectionBanner status="stale" />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
});
