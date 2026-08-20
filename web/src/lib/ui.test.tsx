import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { ToastProvider, useCountdown, useTheme, useToast } from "./ui";

const root = () => document.documentElement;

describe("useTheme", () => {
  it("starts on the system palette with no attribute pinned", () => {
    const { result } = renderHook(() => useTheme());
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(result.current.isDark).toBe(false);
  });

  it("follows the system preference when nothing is stored", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("reads a stored choice on mount", () => {
    localStorage.setItem("parley:theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a stored value that is not a palette", () => {
    localStorage.setItem("parley:theme", "sepia");
    renderHook(() => useTheme());
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("cycles all three ways round, so system is reachable again", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");

    act(() => result.current.cycle());
    expect(result.current.theme).toBe("light");
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("parley:theme")).toBe("light");

    act(() => result.current.cycle());
    expect(result.current.theme).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");

    // The one the old two-state toggle could never get back to.
    act(() => result.current.cycle());
    expect(result.current.theme).toBe("system");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("parley:theme")).toBeNull();
  });

  it("still works when storage throws, as in private mode", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);
    act(() => result.current.cycle());
    expect(root().getAttribute("data-theme")).toBe("light");
  });
});

describe("useCountdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Each decrement schedules the next one, and the new timer is only
  // registered once React has committed — so a single multi-second jump
  // collapses the chain. Stepping a second at a time is what the browser does.
  async function seconds(n: number) {
    for (let i = 0; i < n; i++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    }
  }

  it("passes null straight through", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBeNull();
  });

  it("drains one second at a time", async () => {
    const { result } = renderHook(() => useCountdown(3));
    expect(result.current).toBe(3);
    await seconds(1);
    expect(result.current).toBe(2);
    await seconds(2);
    expect(result.current).toBe(0);
  });

  it("stops at zero instead of going negative", async () => {
    const { result } = renderHook(() => useCountdown(1));
    await seconds(5);
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resyncs when a new frame supplies a different starting point", async () => {
    const { result, rerender } = renderHook(({ n }) => useCountdown(n), {
      initialProps: { n: 10 as number | null },
    });
    await seconds(2);
    expect(result.current).toBe(8);
    rerender({ n: 45 });
    expect(result.current).toBe(45);
  });

  it("goes quiet when the countdown is withdrawn", () => {
    const { result, rerender } = renderHook(({ n }) => useCountdown(n), {
      initialProps: { n: 10 as number | null },
    });
    rerender({ n: null });
    expect(result.current).toBeNull();
  });
});

function Say({ msg }: { msg: string }) {
  const say = useToast();
  return <button onClick={() => say(msg)}>say</button>;
}

describe("ToastProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const click = async () =>
    act(async () => {
      screen.getByRole("button", { name: "say" }).click();
    });

  it("announces politely and clears itself", async () => {
    render(
      <ToastProvider>
        <Say msg="You're the facilitator now" />
      </ToastProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();

    await click();
    const toast = screen.getByRole("status");
    expect(toast.textContent).toBe("You're the facilitator now");
    expect(toast.getAttribute("aria-live")).toBe("polite");

    await act(async () => void (await vi.advanceTimersByTimeAsync(3400)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows one toast at a time and restarts the clock on the next message", async () => {
    render(
      <ToastProvider>
        <Say msg="Saved" />
      </ToastProvider>,
    );
    await click();
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    await click();
    // The first timer must have been cleared: at 3000+1000 the original
    // deadline has passed, but the second message owns the toast now.
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(screen.getAllByRole("status")).toHaveLength(1);

    await act(async () => void (await vi.advanceTimersByTimeAsync(2400)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves no timer behind on unmount", async () => {
    const { unmount } = render(
      <ToastProvider>
        <Say msg="Saved" />
      </ToastProvider>,
    );
    await click();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a no-op outside a provider rather than a crash", () => {
    render(<Say msg="nowhere" />);
    expect(() => screen.getByRole("button", { name: "say" }).click()).not.toThrow();
  });
});
