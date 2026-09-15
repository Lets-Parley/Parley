import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ConnectionStatus } from "./socket";
import { useSession } from "./useSession";

const hub = {
  onState: (_: unknown) => {},
  onStatus: (_: ConnectionStatus) => {},
  stopped: 0,
};

vi.mock("./socket", () => ({
  connectSession: ({
    onState,
    onStatus,
  }: {
    onState: (s: unknown) => void;
    onStatus: (s: ConnectionStatus) => void;
  }) => {
    hub.onState = onState;
    hub.onStatus = onStatus;
    return () => {
      hub.stopped += 1;
    };
  },
}));

const envelope = (version: number, title = `v${version}`) => ({
  id: "sess-1",
  version,
  title,
});

function mount(initial = envelope(5), onTransition?: (prev: unknown, next: unknown) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetched: unknown[] = [initial];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify(fetched[fetched.length - 1]),
      }) as Response,
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(({ active }: { active: boolean }) => useSession("sess-1", active, onTransition), {
      wrapper,
      initialProps: { active: true },
    }),
    qc,
    fetched,
  };
}

beforeEach(() => {
  hub.stopped = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("useSession", () => {
  it("loads the session and starts out live", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data).toMatchObject({ version: 5 });
    expect(result.current.status).toBe("live");
  });

  it("shows a newer broadcast frame", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(6, "newer"));
    await waitFor(() => expect(result.current.data).toMatchObject({ version: 6 }));
  });

  it("drops a frame older than the board already shows", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(3, "stale"));
    await waitFor(() => expect(result.current.data).toMatchObject({ version: 5 }));
    expect(result.current.data).not.toMatchObject({ title: "stale" });
  });

  it("lets an equal-version frame through — the guard is strictly greater-than", async () => {
    // Pinning the current rule rather than assuming it: a same-version frame
    // replaces the cached one, so a redundant rebroadcast is not discarded.
    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(5, "same version, later frame"));
    await waitFor(() =>
      expect(result.current.data).toMatchObject({ title: "same version, later frame" }),
    );
  });

  it("uses the first frame on each connection as a silent transition baseline", async () => {
    const onTransition = vi.fn();
    const { result } = mount(envelope(1), onTransition);
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(2));
    expect(onTransition).not.toHaveBeenCalled();
    hub.onState(envelope(3));
    expect(onTransition).toHaveBeenCalledOnce();
    hub.onStatus("reconnecting");
    hub.onStatus("live");
    hub.onState(envelope(4));
    expect(onTransition).toHaveBeenCalledOnce();
    hub.onState(envelope(5));
    expect(onTransition).toHaveBeenCalledTimes(2);
  });

  it("delivers every accepted live transition directly and suppresses duplicates", async () => {
    const onTransition = vi.fn();
    const { result } = mount(envelope(1), onTransition);
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(2));
    hub.onState(envelope(3));
    hub.onState(envelope(4));
    hub.onState(envelope(4, "duplicate"));
    hub.onState(envelope(3, "older"));
    expect(onTransition.mock.calls.map(([, next]) => next.version)).toEqual([3, 4]);
  });

  it("does not let a refetch regress the board behind a newer frame", async () => {
    const { result, qc, fetched } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onState(envelope(9, "from the socket"));
    await waitFor(() => expect(result.current.data).toMatchObject({ version: 9 }));

    // A GET computed before the mutation lands after it.
    fetched.push(envelope(7, "stale refetch"));
    await qc.refetchQueries({ queryKey: ["session", "sess-1"] });
    // Read the cache, not the hook snapshot: `result.current` still holds the
    // pre-refetch render, so asserting on it passes even with the guard gone.
    await waitFor(() =>
      expect(qc.getQueryData(["session", "sess-1"])).toMatchObject({
        version: 9,
        title: "from the socket",
      }),
    );
    expect(qc.getQueryData(["session", "sess-1"])).not.toMatchObject({ title: "stale refetch" });
  });

  it("accepts a refetch that is genuinely newer", async () => {
    const { result, qc, fetched } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    fetched.push(envelope(11, "fresher"));
    await qc.refetchQueries({ queryKey: ["session", "sess-1"] });
    await waitFor(() =>
      expect(qc.getQueryData(["session", "sess-1"])).toMatchObject({
        version: 11,
        title: "fresher",
      }),
    );
  });

  it("surfaces the socket status to the caller", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    hub.onStatus("stale");
    await waitFor(() => expect(result.current.status).toBe("stale"));
  });

  it("refreshes identity after reconnect even though me is infinitely fresh", async () => {
    const { result, qc } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const refetch = vi.spyOn(qc, "refetchQueries");
    hub.onStatus("reconnecting");
    hub.onStatus("live");
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["me"], exact: true, type: "active" });
  });

  it("lets go of the socket on unmount", async () => {
    const { result, unmount } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    unmount();
    expect(hub.stopped).toBe(1);
  });

  // A guest who has left must not keep presenting a spent credential to the
  // server — the socket has to come down the moment the caller says so, not
  // wait for unmount.
  it("stops the socket when switched inactive, without waiting for unmount", async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.data).toBeTruthy());
    rerender({ active: false });
    await waitFor(() => expect(hub.stopped).toBe(1));

    // A frame arriving after teardown must not resurrect state through a
    // socket that is supposed to be gone.
    hub.onState(envelope(6, "after leaving"));
    expect(result.current.data).not.toMatchObject({ title: "after leaving" });
  });
});
