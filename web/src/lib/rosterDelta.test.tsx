import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ConnectionStatus } from "./socket";
import { useRosterDelta } from "./rosterDelta";

function roster(presence: string[], status: ConnectionStatus = "live") {
  return renderHook(
    ({ p, s }: { p: string[]; s: ConnectionStatus }) => useRosterDelta(p, s),
    { initialProps: { p: presence, s: status } },
  );
}

describe("useRosterDelta", () => {
  it("animates nobody on the first envelope after mount", () => {
    expect(roster(["dana", "marcus"]).result.current).toEqual({ joined: [], left: [] });
  });

  it("reports the one id an envelope added", () => {
    const { result, rerender } = roster(["dana"]);
    rerender({ p: ["dana", "priya"], s: "live" });
    expect(result.current).toEqual({ joined: ["priya"], left: [] });
  });

  it("reports a whole burst from a single envelope", () => {
    const { result, rerender } = roster(["dana"]);
    rerender({ p: ["dana", "a", "b", "c", "d", "e", "f"], s: "live" });
    expect(result.current.joined).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("reports who went away", () => {
    const { result, rerender } = roster(["dana", "marcus"]);
    rerender({ p: ["dana"], s: "live" });
    expect(result.current).toEqual({ joined: [], left: ["marcus"] });
  });

  it("says nothing when a repeat envelope changes nothing", () => {
    const { result, rerender } = roster(["dana", "marcus"]);
    rerender({ p: ["dana", "marcus"], s: "live" });
    const settled = result.current;
    rerender({ p: ["marcus", "dana"], s: "live" });
    // Same delta object, so a seat mid-drop is never handed a fresh animation.
    expect(result.current).toBe(settled);
    expect(settled).toEqual({ joined: [], left: [] });
  });

  it("re-seeds across a reconnect instead of animating the whole room", () => {
    const { result, rerender } = roster(["dana"]);
    rerender({ p: ["dana"], s: "reconnecting" });
    // ws.go hands every new socket a full envelope; without a re-seed this
    // reads as the entire room joining after a blip.
    rerender({ p: ["dana", "marcus", "priya"], s: "live" });
    expect(result.current).toEqual({ joined: [], left: [] });
    rerender({ p: ["dana", "marcus", "priya", "sam"], s: "live" });
    expect(result.current.joined).toEqual(["sam"]);
  });

  it("drops a rejoiner in again", () => {
    const { result, rerender } = roster(["dana", "marcus"]);
    rerender({ p: ["dana"], s: "live" });
    expect(result.current.left).toEqual(["marcus"]);
    rerender({ p: ["dana", "marcus"], s: "live" });
    expect(result.current.joined).toEqual(["marcus"]);
  });
});
