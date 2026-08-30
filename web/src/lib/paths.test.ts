import { describe, expect, it } from "vitest";
import { decksApi, spaceApi, spacePath, spaceSettingsPath } from "./paths";

describe("space paths", () => {
  it("puts the org ahead of the slug", () => {
    expect(spacePath("acme", "platform-team")).toBe("/o/acme/s/platform-team");
    expect(spaceSettingsPath("acme", "platform-team")).toBe("/o/acme/s/platform-team/settings");
    expect(spaceApi("acme", "platform-team")).toBe("/api/orgs/acme/spaces/platform-team");
    expect(decksApi("acme", "platform-team")).toBe("/api/orgs/acme/spaces/platform-team/decks");
  });
});
