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

  it("keeps a persistent lost-connection or removed bar in the flow, covering nothing", () => {
    for (const status of ["stale", "removed"] as const) {
      const { container, unmount } = render(<ConnectionBanner status={status} />);
      expect((container.firstChild as HTMLElement).className).not.toContain("h-0");
      expect(screen.getByRole("status").className).not.toContain("absolute");
      unmount();
    }
  });

  it("floats the brief reconnecting blip over the page instead of pushing it down", () => {
    // In flow it moved the whole room 40px on every blip and again on every recovery.
    const { container } = render(<ConnectionBanner status="reconnecting" />);
    expect((container.firstChild as HTMLElement).className).toContain("h-0");
    expect(screen.getByRole("status").className).toContain("absolute");
  });

  it("announces politely rather than interrupting", () => {
    render(<ConnectionBanner status="stale" />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("offers the one thing a removed member can still do", () => {
    render(<ConnectionBanner status="removed" />);
    const out = screen.getByRole("link", { name: "Back to Parley" });
    expect(out.getAttribute("href")).toBe("/");
  });
});
