import { useLayoutEffect } from "react";
import { notificationAudio } from "./notificationAudio";

/**
 * Arms pile-on and kick impact sounds while `on`.
 *
 * A layout effect on purpose: every layout effect in a commit runs before any
 * passive one, and the table's pile-on is a child's passive effect — which
 * would otherwise run first and find the flag still off.
 */
export function useImpactSounds(on: boolean) {
  useLayoutEffect(() => {
    notificationAudio.enabled = on;
    return () => {
      notificationAudio.enabled = false;
    };
  }, [on]);
}
