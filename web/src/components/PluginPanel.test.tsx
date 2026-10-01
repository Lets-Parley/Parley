import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Envelope } from "../lib/api";
import { CrashBreaker, PLUGIN_SANDBOX, pluginFramePath } from "../lib/pluginBridge";
import { PluginPanel } from "./PluginPanel";

const env = {
  id: "s1",
  kind: "poker",
  title: "Sprint 42",
  phase: "voting",
  revealed: false,
  version: 1,
  facilitatorId: "u1",
  facilitatorConnected: true,
  endedAt: null,
  presence: [],
  spaceSlug: "alpha-squad",
  orgSlug: "default",
  participants: [],
  serverTime: "2026-01-01T00:00:00Z",
  state: {
    deck: { name: "d", values: [], ordinal: false },
    autoReveal: false,
    openVoting: false,
    currentStoryId: null,
    stories: [],
  },
} as unknown as Envelope;

function panel(over: Record<string, unknown> = {}) {
  return render(
    <PluginPanel
      name="retro"
      version="1.0.0"
      grants={["session:read"]}
      env={env}
      onAction={() => Promise.resolve()}
      {...over}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("PluginPanel", () => {
  it("sandboxes the frame without allow-same-origin", () => {
    panel();
    const frame = screen.getByTitle("retro plugin panel");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // Spelled out rather than implied: allow-same-origin would hand the frame
    // this document's cookies and undo every other guard here.
    expect(PLUGIN_SANDBOX).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("points the frame at the framed route, not at the app", () => {
    panel();
    expect(screen.getByTitle("retro plugin panel").getAttribute("src")).toBe("/plugin-ui/retro/1.0.0");
    expect(pluginFramePath("a/b", "1.0")).toBe("/plugin-ui/a%2Fb/1.0");
  });

  it("sandboxes toolbar and nav chrome without allow-same-origin", () => {
    panel({ slot: "toolbar" });
    const toolbar = screen.getByTitle("retro plugin toolbar");
    expect(toolbar.getAttribute("sandbox")).toBe("allow-scripts");
    expect(toolbar.getAttribute("sandbox")).not.toContain("allow-same-origin");
    panel({ slot: "nav" });
    const nav = screen.getByTitle("retro plugin nav");
    expect(nav.getAttribute("sandbox")).toBe("allow-scripts");
    expect(nav.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("sizes chrome slots smaller than a nested panel", () => {
    panel({ slot: "toolbar" });
    const toolbar = screen.getByTitle("retro plugin toolbar").className.split(/\s+/);
    expect(toolbar).toContain("h-9");
    expect(toolbar).not.toContain("h-64");
    panel({ slot: "nav" });
    const nav = screen.getByTitle("retro plugin nav").className.split(/\s+/);
    expect(nav).toContain("h-24");
    expect(nav).not.toContain("h-64");
    panel({ slot: "export-menu" });
    const exportMenu = screen.getByTitle("retro plugin export-menu").className.split(/\s+/);
    expect(exportMenu).toContain("h-9");
    expect(exportMenu).not.toContain("h-64");
  });

  it("sizes a nested panel to h-64 and a full-room slot to fill the chrome", () => {
    panel();
    expect(screen.getByTitle("retro plugin panel").className.split(/\s+/)).toContain("h-64");
    panel({ slot: "room" });
    const room = screen.getAllByTitle("retro plugin panel").at(-1)!;
    expect(room.className.split(/\s+/)).not.toContain("h-64");
    expect(room.className.split(/\s+/)).toContain("h-full");
    expect(screen.getByLabelText(/retro room/i).className).toContain("h-[calc(100dvh-3.5rem)]");
  });

  it("marks the frame inert while a host modal is open, and clears it after", () => {
    const view = panel({ modalOpen: false });
    const frame = screen.getByTitle("retro plugin panel");
    expect(frame.hasAttribute("inert")).toBe(false);
    view.rerender(
      <PluginPanel
        name="retro"
        version="1.0.0"
        grants={["session:read"]}
        env={env}
        onAction={() => Promise.resolve()}
        modalOpen
      />,
    );
    expect(frame.hasAttribute("inert")).toBe(true);
    view.rerender(
      <PluginPanel
        name="retro"
        version="1.0.0"
        grants={["session:read"]}
        env={env}
        onAction={() => Promise.resolve()}
        modalOpen={false}
      />,
    );
    expect(frame.hasAttribute("inert")).toBe(false);
  });

  it("renders an explicit card, never a blank rectangle, when the handshake times out", () => {
    vi.useFakeTimers();
    panel();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("retro did not start")).toBeTruthy();
  });

  it("stops loading a plugin whose breaker has tripped", () => {
    const breaker = new CrashBreaker(1, 60_000);
    breaker.crashed();
    panel({ breaker });
    expect(screen.getByText("retro is switched off")).toBeTruthy();
    // The frame is not in the document at all: a tripped breaker means the
    // plugin is not loaded, not that it is loaded and hidden.
    expect(screen.queryByTitle("retro plugin panel")).toBeNull();
  });

  it("loads the plugin again when the reader asks it to", async () => {
    const user = userEvent.setup();
    const breaker = new CrashBreaker(1, 60_000);
    breaker.crashed();
    panel({ breaker });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByTitle("retro plugin panel")).toBeTruthy();
  });

  // The frame keeps its state across a theme change: the same element, the
  // same port, one handshake — only a second tokens message.
  it("re-sends the tokens and scheme over the same port when the host theme changes", async () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "light");
    root.style.setProperty("--color-ink", "#101010");
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    panel();
    const frame = screen.getByTitle("retro plugin panel") as HTMLIFrameElement;
    const handshakes = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    fireEvent.load(frame);
    expect(posted.mock.calls.map((c) => c[0])).toEqual([
      '{"type":"tokens","tokens":{"ink":"#101010"},"scheme":"light"}',
    ]);

    root.style.setProperty("--color-ink", "#f0f0f0");
    root.setAttribute("data-theme", "dark");
    await waitFor(() => expect(posted.mock.calls.length).toBe(2));
    expect(posted.mock.calls[1][0]).toBe('{"type":"tokens","tokens":{"ink":"#f0f0f0"},"scheme":"dark"}');
    expect(handshakes).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("retro plugin panel")).toBe(frame);
  });

  const ownRoom = { ...env, kind: "acme-retro", plugin: { name: "retro", version: "1.0.0", grants: [] } } as unknown as Envelope;

  it("pushes a changed viewer id into a frame that is already open", async () => {
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    const view = panel({ env: ownRoom, selfId: "u1" });
    const states = () =>
      posted.mock.calls
        .map((c) => JSON.parse(String(c[0])) as { type: string; state?: { selfId: string } })
        .filter((m) => m.type === "state")
        .map((m) => m.state!.selfId);
    await waitFor(() => expect(states()).toEqual(["u1"]));
    view.rerender(
      <PluginPanel name="retro" version="1.0.0" grants={["session:read"]} env={ownRoom} selfId="u2" onAction={() => Promise.resolve()} />,
    );
    await waitFor(() => expect(states()).toEqual(["u1", "u2"]));
  });

  it("re-sends when a theme pack rewrites the root's inline style and data-theme does not move", async () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "dark");
    root.style.setProperty("--color-surface", "#111111");
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    panel();
    fireEvent.load(screen.getByTitle("retro plugin panel"));
    root.style.setProperty("--color-surface", "#1d2b3a");
    await waitFor(() => expect(posted.mock.calls.length).toBe(2));
    expect(posted.mock.calls.map((c) => c[0])).toEqual([
      '{"type":"tokens","tokens":{"surface":"#111111"},"scheme":"dark"}',
      '{"type":"tokens","tokens":{"surface":"#1d2b3a"},"scheme":"dark"}',
    ]);
  });

  /** jsdom has no matchMedia; this one is flipped by hand. */
  function stubMatchMedia() {
    const listeners = new Set<() => void>();
    const mql = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("matchMedia", (query: string) => {
      expect(query).toBe("(prefers-color-scheme: dark)");
      return mql;
    });
    return {
      listeners,
      flip(dark: boolean) {
        mql.matches = dark;
        for (const fn of [...listeners]) fn();
      },
    };
  }

  it("follows the OS scheme when no theme is pinned", () => {
    const os = stubMatchMedia();
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    panel();
    fireEvent.load(screen.getByTitle("retro plugin panel"));
    os.flip(true);
    expect(posted.mock.calls.map((c) => c[0])).toEqual([
      '{"type":"tokens","tokens":{},"scheme":"light"}',
      '{"type":"tokens","tokens":{},"scheme":"dark"}',
    ]);
    vi.unstubAllGlobals();
  });

  it("stops watching the theme once the panel is gone", async () => {
    const os = stubMatchMedia();
    const view = panel();
    fireEvent.load(screen.getByTitle("retro plugin panel"));
    expect(os.listeners.size).toBe(1);
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    view.unmount();
    expect(os.listeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.setProperty("--color-ink", "#f0f0f0");
    // Long enough for a MutationObserver that was still attached to fire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("survives a theme change before the frame has loaded and hands it the current theme once", async () => {
    const root = document.documentElement;
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    panel();
    const frame = screen.getByTitle("retro plugin panel") as HTMLIFrameElement;
    const handshakes = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    root.style.setProperty("--color-ink", "#f0f0f0");
    root.setAttribute("data-theme", "dark");
    await waitFor(() => expect(posted.mock.calls.length).toBe(1));
    fireEvent.load(frame);
    expect(handshakes).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls.map((c) => c[0])).toEqual(['{"type":"tokens","tokens":{"ink":"#f0f0f0"},"scheme":"dark"}']);
  });

  it("posts no state and no viewer id into a frame in a standup room", async () => {
    const standup = { ...env, kind: "standup", phase: "open", state: { entries: [] } } as unknown as Envelope;
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    panel({ env: standup, selfId: "u1" });
    fireEvent.load(screen.getByTitle("retro plugin panel"));
    // Longer than the push interval, so a view that was built would have landed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(posted.mock.calls.map((c) => c[0])).toEqual(['{"type":"tokens","tokens":{},"scheme":"light"}']);
  });
});
