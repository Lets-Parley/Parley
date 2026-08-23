import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Envelope } from "./api";
import { connectSession, type ConnectionStatus } from "./socket";

export function useSession(id: string, active = true) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("live");

  const query = useQuery({
    queryKey: ["session", id],
    queryFn: () => api<Envelope>("GET", `/api/sessions/${id}`),
    staleTime: Infinity,
    retry: false,
    enabled: active,
    // Version guard on the refetch path too: a GET response computed before a
    // concurrent mutation must not overwrite a newer WS frame.
    structuralSharing: (oldData, newData) => {
      const o = oldData as Envelope | undefined;
      const n = newData as Envelope;
      return o && o.version > n.version ? o : n;
    },
  });

  useEffect(() => {
    // A guest who has left must stop presenting the spent credential — an
    // inactive caller tears the socket down immediately rather than at unmount.
    if (!active) return;
    const stop = connectSession({
      sessionId: id,
      onState: (frame) => {
        const env = frame as Envelope;
        // Drop anything older than what we already show — a refetch racing a
        // broadcast must never regress the board.
        qc.setQueryData<Envelope>(["session", id], (prev) =>
          prev && prev.version > env.version ? prev : env,
        );
      },
      onStatus: (s) => {
        setStatus(s);
        if (s === "live") {
          qc.invalidateQueries({ queryKey: ["session", id] });
        }
      },
    });
    return stop;
  }, [id, qc, active]);

  return { ...query, status };
}
