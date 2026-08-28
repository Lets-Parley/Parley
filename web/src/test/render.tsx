import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
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
