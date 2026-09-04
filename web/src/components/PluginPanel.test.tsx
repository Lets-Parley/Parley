import { render, screen, act } from "@testing-library/react";
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

afterEach(() => vi.useRealTimers());

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

  it("sizes chrome slots smaller than a nested panel", () => {
    panel({ slot: "toolbar" });
    expect(screen.getByTitle("retro plugin toolbar").className.split(/\s+/)).toContain("h-9");
    panel({ slot: "nav" });
    expect(screen.getByTitle("retro plugin nav").className.split(/\s+/)).toContain("h-24");
    panel({ slot: "export-menu" });
    expect(screen.getByTitle("retro plugin export-menu").className.split(/\s+/)).toContain("h-9");
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
});
