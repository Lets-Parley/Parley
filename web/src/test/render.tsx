import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../lib/ui";

/**
 * The three providers every screen assumes exist. Retries are off so a
 * deliberately-failing fetch surfaces on the first tick instead of after a
 * backoff schedule the test would have to wait out.
 */
export function renderApp(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>{children}</ToastProvider>
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
