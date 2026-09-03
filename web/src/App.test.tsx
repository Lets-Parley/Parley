import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import App from "./App";
import beacon from "./themes/beacon.theme.json";
import { parseThemePack } from "./lib/theme";

/**
 * The pipeline end to end, at the level a user meets it: a pack sitting in
 * storage themes the running app with no screen and no reload, and clearing it
 * hands the page back to the built-in tokens. Asserted here rather than on the
 * hook, because a hook nothing mounts themes nothing.
 */
describe("theme packs reach the app", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  });

  it("applies an installed pack to the running app", async () => {
    localStorage.setItem("parley:theme-pack", JSON.stringify(beacon));
    render(<App />);
    const parsed = parseThemePack(beacon);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--color-felt")).toBe(
        parsed.pack.modes.light!.felt,
      ),
    );
  });

  it("leaves the built-in tokens alone when nothing is installed", async () => {
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--color-felt")).toBe(""),
    );
  });
});
