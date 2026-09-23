import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../lib/ui";

/**
 * The three providers every screen assumes exist. Retries are off so a
 * deliberately-failing fetch surfaces on the first tick instead of after a
 * backoff schedule the test would have to wait out.
 *
 * Pass `path` when the screen reads useParams. Without a matched route the
 * hook answers an empty object, so a page that builds its API URL out of the
 * org and slug segments would silently ask for the wrong thing — and a test
 * that never notices is worse than no test.
 */
export function renderApp(
  ui: ReactElement,
  { route = "/", path }: { route?: string; path?: string } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>
          {path ? (
            <Routes>
              <Route path={path} element={children} />
            </Routes>
          ) : (
            children
          )}
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper: Wrapper }), queryClient: qc };
}

export function makePerson(over: Partial<import("../lib/api").Person> = {}) {
  return {
    userId: "u1",
    name: "Dana Whitfield",
    avatarHue: 120,
    spectator: false,
    ...over,
  } as import("../lib/api").Person;
}

/**
 * The page's own live regions, without the toast's. The toast region is
 * mounted for the life of the provider (a region that appears with its first
 * message goes unannounced by some screen readers), so every screen rendered
 * through renderApp has it, and a lookup for "the" status region has to step
 * past it.
 */
export function pageStatuses(): HTMLElement[] {
  return screen.getAllByRole("status").filter((n) => !n.hasAttribute("data-toast"));
}

/** The one status region the screen itself owns; throws unless there is exactly one. */
export function pageStatus(): HTMLElement {
  const found = pageStatuses();
  if (found.length !== 1) throw new Error(`expected one page status region, found ${found.length}`);
  return found[0];
}
