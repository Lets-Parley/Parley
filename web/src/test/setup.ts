import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom implements neither of these, and both are called during a normal
// render: useTheme resolves the system palette through matchMedia, and the
// dialog element's showModal is a no-op stub here.
// A width query answers "yes" by default, so a test renders at desktop unless
// it says otherwise; anything else (prefers-color-scheme) stays false.
// Installed unconditionally: jsdom's own matchMedia answers `false` to every
// query, which would render the shell at phone width in every test.
{
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
// This stub only flips `open`. It gives you none of the behaviour a real
// <dialog> gets from the platform: afterwards document.activeElement is still
// <body>, matches(":modal") is false, focus moves freely outside the dialog,
// and jsdom fires no `cancel` event so the Escape path is unreachable. The
// stubbed close() dispatches `close` unconditionally.
//
// So do NOT write focus-trap, Escape-dismissal, or inertness assertions in this
// repo — they would pass without testing anything. Those checks are manual and
// are recorded in the PR that changes a dialog.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  // restoreMocks does not cover vi.stubGlobal, so a test that renders at phone
  // width would leave every later test there.
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.useRealTimers();
});
