import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

vi.mock("./pages/OrgDirectory", () => new Promise(() => {}));

afterEach(() => window.history.replaceState(null, "", "/"));

it("announces loading while the next page is downloading", () => {
  window.history.replaceState(null, "", "/o/acme");
  render(<App />);
  expect(screen.getByText("Loading page…").getAttribute("role")).toBe("status");
});
