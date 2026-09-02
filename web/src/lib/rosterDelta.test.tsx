import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ConnectionStatus } from "./socket";
import { useRosterDelta } from "./rosterDelta";

function roster(presence: string[], status: ConnectionStatus = "live", meId = "__nobody__") {
  return renderHook(
    ({ p, s }: { p: string[]; s: ConnectionStatus }) => useRosterDelta(p, s, meId),
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

  // The page loads over HTTP and renders you seated before the socket has
  // registered you. Presence therefore gains your OWN id on a later envelope,
  // by which time the socket is live and the differ has a baseline — so the
  // seat you are already sitting in reads as a newcomer and falls into it.
  it("never drops the viewer into the seat they are already in", () => {
    const { result, rerender } = roster(["marcus"], "reconnecting", "dana");
    rerender({ p: ["marcus"], s: "live" });
    rerender({ p: ["marcus", "dana"], s: "live" });
    expect(result.current).toEqual({ joined: [], left: [] });
  });

  it("still drops in a real joiner arriving in the same burst as the viewer", () => {
    const { result, rerender } = roster(["marcus"], "reconnecting", "dana");
    rerender({ p: ["marcus"], s: "live" });
    // hub.go merges presence changes inside 1500ms, so the viewer's own
    // registration and somebody else's arrival land as one diff.
    rerender({ p: ["marcus", "dana", "priya"], s: "live" });
    expect(result.current.joined).toEqual(["priya"]);
  });

  it("leaves the departed half alone when the viewer goes quiet", () => {
    const { result, rerender } = roster(["dana", "marcus"], "live", "dana");
    rerender({ p: ["marcus"], s: "live" });
    expect(result.current.left).toEqual(["dana"]);
  });

  it("does not re-drop the viewer's own seat when their presence lapses and returns", () => {
    const { result, rerender } = roster(["dana", "marcus"], "live", "dana");
    rerender({ p: ["marcus"], s: "live" });
    rerender({ p: ["marcus", "dana"], s: "live" });
    expect(result.current.joined).toEqual([]);
  });
});
