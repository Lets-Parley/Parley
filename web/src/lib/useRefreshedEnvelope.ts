import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Envelope } from "./api";
import type { ConnectionStatus } from "./socket";

const REFRESH_FIRST = "Refresh the room before writing again.";

export function useRefreshedEnvelope(
  live: Envelope,
  status: ConnectionStatus,
  shouldRefreshOnReconnect: boolean,
  onReadRevoked: () => void,
) {
  const sessionId = live.id;
  const [fetched, setFetched] = useState<Envelope | null>(null);
  const [isRefreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const previousStatus = useRef(status);
  const env = fetched && fetched.id === live.id && fetched.version > live.version ? fetched : live;

  const refresh = useCallback(async () => {
    try {
      const next = await api<Envelope>("GET", `/api/sessions/${sessionId}`);
      setFetched(next);
      setRefreshError("");
      return next;
    } catch (problem) {
      if (problem instanceof ApiError && [401, 403, 404].includes(problem.status)) onReadRevoked();
      setRefreshError(REFRESH_FIRST);
      throw problem;
    }
  }, [sessionId, onReadRevoked]);

  const retryRefresh = useCallback(() => {
    setRefreshing(true);
    void refresh()
      .catch(() => setRefreshError(REFRESH_FIRST))
      .finally(() => setRefreshing(false));
  }, [refresh]);

  useEffect(() => {
    const hasReconnected = previousStatus.current !== "live" && status === "live";
    previousStatus.current = status;
    if (hasReconnected && shouldRefreshOnReconnect) queueMicrotask(retryRefresh);
  }, [status, shouldRefreshOnReconnect, retryRefresh]);

  return { env, refresh, retryRefresh, isRefreshing, refreshError };
}
