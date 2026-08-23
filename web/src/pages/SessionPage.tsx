import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SpaceView } from "../lib/api";
import { linkGuestFor } from "../lib/links";
import { useSession } from "../lib/useSession";
import { useMe, NameGate } from "../components/NameGate";
import { AppShell } from "../components/AppShell";
import { LinkPanel } from "../components/LinkPanel";
import { Modal, buttonQuiet } from "../components/Modal";
import { getKind } from "../lib/kinds";

export function SessionPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  // A link guest is refused /api/me the way it is refused everything outside
  // this room, so its name and hue come from the redemption it already did.
  // Read once: the room must not change identity under a re-render.
  const [guest] = useState(() => linkGuestFor(id));
  const me = useMe(!guest);
  const session = useSession(id);
  const slug = session.data?.spaceSlug;
  const [linksOpen, setLinksOpen] = useState(false);

  // The sidebar's roster and session list come from the space, not the session
  // envelope — one cached query, shared with the space page. A guest is refused
  // the space view, so it is never asked for.
  const space = useQuery({
    queryKey: ["space", slug],
    queryFn: () => api<SpaceView>("GET", `/api/spaces/${slug}`),
    enabled: !!slug && !guest,
    retry: false,
  });

  const identity = guest?.me ?? me.data ?? null;

  if ((!guest && me.isLoading) || session.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  }
  if (!guest && me.data === null) {
    return <NameGate onDone={() => session.refetch()} />;
  }
  if (session.isError || !session.data || !identity) {
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
  const Room = getKind(env.kind)?.Room;
  // A guest is never the facilitator, so the panel is never offered to one —
  // and the server refuses it either way.
  const isFacilitator = !guest && env.facilitatorId === identity.id;

  return (
    <AppShell
      spaceSlug={env.spaceSlug}
      spaceName={space.data?.name ?? env.spaceSlug}
      title={env.title}
      me={identity}
      guest={!!guest}
      status={session.status}
      onRetry={() => qc.invalidateQueries({ queryKey: ["session", id] })}
      members={space.data?.members}
      presence={env.presence}
      sessions={space.data?.sessions}
      activeSessionId={env.id}
      sidebarDefault={false}
      actions={
        isFacilitator && (
          <button className={buttonQuiet} onClick={() => setLinksOpen(true)}>
            Guest links
          </button>
        )
      }
    >
      {guest && (
        /* Say what the link is and when it runs out, so nobody discovers the
           second half by being dropped mid-round. */
        <p
          data-testid="link-guest-banner"
          className="border-b border-line bg-felt-deep px-5 py-2 text-[13px] text-ink-soft"
        >
          You're in this room on a guest link — just this room, and only until{" "}
          {new Date(guest.expiresAt).toLocaleString()}.
        </p>
      )}
      {Room ? (
        <Room env={env} me={identity} status={session.status} guest={!!guest} />
      ) : (
        // Falling through to a room here would point one kind's controls at
        // another kind's state, so an unknown kind gets no room at all.
        <p className="p-8 text-center text-ink-soft text-pretty">
          This Parley doesn't know how to open a “{env.kind}” session. It may
          need a newer version.
        </p>
      )}
      {linksOpen && (
        <Modal title="Guest links" onClose={() => setLinksOpen(false)} width="34rem">
          <div className="mt-4">
            <LinkPanel sessionId={env.id} ended={env.endedAt !== null} />
          </div>
        </Modal>
      )}
    </AppShell>
  );
}
