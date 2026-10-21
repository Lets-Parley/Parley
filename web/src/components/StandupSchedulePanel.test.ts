import { afterEach, describe, expect, it } from "vitest";
import { supportedZones } from "./StandupSchedulePanel";

// supportedZones() backs the ZONES constant, which StandupSchedulePanel.tsx
// computes once at module import — so a fallback bug there cannot be caught
// by stubbing Intl.supportedValuesOf inside a page-level test body, which
// runs long after that import already happened. Exercise the function
// directly instead.
describe("supportedZones", () => {
  const real = Intl.supportedValuesOf;

  afterEach(() => {
    Intl.supportedValuesOf = real;
  });

  it("returns an empty list when Intl.supportedValuesOf is absent", () => {
    // @ts-expect-error - simulating a browser that never defined it (Safari < 15.4).
    Intl.supportedValuesOf = undefined;
    expect(supportedZones()).toEqual([]);
  });

  it("returns an empty list when Intl.supportedValuesOf throws", () => {
    Intl.supportedValuesOf = () => {
      throw new Error("nope");
    };
    expect(supportedZones()).toEqual([]);
  });

  it("returns the zone list when Intl.supportedValuesOf is present", () => {
    Intl.supportedValuesOf = ((key: string) =>
      key === "timeZone" ? ["America/Chicago", "Europe/Berlin"] : []) as typeof Intl.supportedValuesOf;
    expect(supportedZones()).toEqual(["America/Chicago", "Europe/Berlin"]);
  });
});
