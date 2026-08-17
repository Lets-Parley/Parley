import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SpaceView } from "../lib/api";
import { useSession } from "../lib/useSession";
import { useMe, NameGate } from "../components/NameGate";
import { AppShell } from "../components/AppShell";
import { PokerRoom } from "./PokerRoom";
import { StandupRoom } from "./StandupRoom";

export function SessionPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const me = useMe();
  const session = useSession(id);
  const slug = session.data?.spaceSlug;

  // The sidebar's roster and session list come from the space, not the session
  // envelope — one cached query, shared with the space page.
  const space = useQuery({
    queryKey: ["space", slug],
    queryFn: () => api<SpaceView>("GET", `/api/spaces/${slug}`),
    enabled: !!slug,
    retry: false,
  });

  if (me.isLoading || session.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  }
  if (me.data === null) {
    return <NameGate onDone={() => session.refetch()} />;
  }
  if (session.isError || !session.data || !me.data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl">No seat at this table</p>
        <p className="max-w-sm text-sm text-ink-soft text-pretty">
          This session doesn't exist, or you're not a member of its space. Ask a
          teammate for the space link — it seats you with just a display name.
        </p>
      </div>
    );
  }

  const env = session.data;

  return (
    <AppShell
      spaceSlug={env.spaceSlug}
      spaceName={space.data?.name ?? env.spaceSlug}
      me={me.data}
      status={session.status}
      onRetry={() => qc.invalidateQueries({ queryKey: ["session", id] })}
      members={space.data?.members}
      presence={env.presence}
      sessions={space.data?.sessions}
      activeSessionId={env.id}
      sidebarDefault={false}
    >
      {env.kind === "poker" ? (
        <PokerRoom env={env} me={me.data} />
      ) : (
        <StandupRoom env={env} me={me.data} />
      )}
    </AppShell>
  );
}
