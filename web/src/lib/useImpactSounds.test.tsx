import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { render } from "@testing-library/react";
import { notificationAudio } from "./notificationAudio";
import { useImpactSounds } from "./useImpactSounds";

afterEach(() => {
  notificationAudio.enabled = false;
});

describe("useImpactSounds", () => {
  // A child's effects run before its parent's. The table's pile-on is a child
  // effect, so a flag set in the page's own useEffect is still off when a
  // room opens straight onto a revealed dissent.
  it("is armed before any child effect in the same commit reads it", () => {
    let seen: boolean | undefined;
    function Child() {
      useEffect(() => {
        seen = notificationAudio.enabled;
      }, []);
      return null;
    }
    function Page() {
      useImpactSounds(true);
      return <Child />;
    }
    render(<Page />);
    expect(seen).toBe(true);
  });

  it("disarms when turned off and when the page goes", () => {
    const { rerender, unmount } = render(<Probe on />);
    expect(notificationAudio.enabled).toBe(true);
    rerender(<Probe on={false} />);
    expect(notificationAudio.enabled).toBe(false);
    rerender(<Probe on />);
    unmount();
    expect(notificationAudio.enabled).toBe(false);
  });
});

function Probe({ on }: { on: boolean }) {
  useImpactSounds(on);
  return null;
}
