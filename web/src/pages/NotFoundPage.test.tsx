import { describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderApp } from "../test/render";
import { NotFoundPage } from "./NotFoundPage";

describe("NotFoundPage", () => {
  it("names itself in the tab and offers the way back, then gives the title back", () => {
    document.title = "Parley";
    renderApp(<NotFoundPage />);
    expect(document.title).toBe("Page not found");
    expect(screen.getByRole("link", { name: "Back to your spaces" }).getAttribute("href")).toBe("/");
    cleanup();
    expect(document.title).toBe("Parley");
  });
});
