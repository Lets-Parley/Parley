import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me, type SpaceView } from "../lib/api";
import { forgetLinkGuest, linkGuestFor } from "../lib/links";
import { useSession } from "../lib/useSession";
import { useMe, NameGate } from "../components/NameGate";
import { AppShell } from "../components/AppShell";
import { LinkPanel } from "../components/LinkPanel";
import { Modal, buttonQuiet } from "../components/Modal";
import { getKind } from "../lib/kinds";
import { spaceApi } from "../lib/paths";

/** Drop member-only fields after an identity remint — see SpacePage. */
function strangerSpace(prev: SpaceView): SpaceView {
  return { slug: prev.slug, name: prev.name, protected: prev.protected };
}

export function SessionPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  // A link guest's name and hue come from the redemption it already did, kept
  // in session storage. Read once: the room must not change identity under a
  // re-render.
  const [stored] = useState(() => linkGuestFor(id));
  // Session storage is a cache, not the identity — a private window, a cleared
  // site or a second device has none of it, and the cookie is still perfectly
  // good. GET /api/me is open to a link principal for exactly this: without it
  // that guest resolves as nobody and lands in a name gate whose POST the
  // server refuses, which is a dead end rather than a lost preference.
  const me = useMe(!stored);
  const guest =
    stored ??
    (me.data?.linkSessionId === id
      ? { sessionId: id, me: me.data, expiresAt: me.data.linkExpiresAt ?? "" }
      : null);
  // Closing the tab drops the cached identity — session storage is per tab —
  // but not the seat: the cookie is scoped to the browsing session, so it
  // outlives the tab for as long as any window of this browser stays open, and
  // the recovery above seats the next person from it. Leaving is the reliable
  // version — it deletes the token server-side, so the seat ends whatever the
  // browser keeps. What the guest already said — votes, standup entries, CSV
  // attribution — stays in the room.
  const [left, setLeft] = useState(false);
  const session = useSession(id, !left);
  const slug = session.data?.spaceSlug;
  const org = session.data?.orgSlug;
  const [linksOpen, setLinksOpen] = useState(false);
  async function leave() {
    // Best effort on the wire, unconditional locally: whatever the server
    // says, this browser must stop presenting itself as the guest. Leave is
    // link-guest only; rememberOpenSession already skips link principals, so
    // clearing open-mode last-name here would wipe an unrelated prior seat.
    try {
      await api("DELETE", "/api/me");
    } finally {
      forgetLinkGuest();
      qc.clear();
      setLeft(true);
    }
  }

  // The sidebar's roster and session list come from the space, not the session
  // envelope — one cached query, shared with the space page. A guest is refused
  // the space view, so it is never asked for.
  const space = useQuery({
    queryKey: ["space", org, slug],
    queryFn: () => api<SpaceView>("GET", spaceApi(org ?? "", slug ?? "")),
    // Not while identity is still in flight: a guest recovering from the
    // cookie alone is not yet known to be one, and the space route is the one
    // request that must never be made on its behalf.
    enabled: !!slug && !!org && !guest && !me.isLoading,
    retry: false,
  });

  const liveIdentity = guest?.me ?? me.data ?? null;
  // Hold the last known seat across a mid-room 401 so the expired-session
  // NameGate can overlay the room instead of unmounting half-typed standup
  // text or an estimate in progress. Adjusting state during render is the
  // React-documented way to keep a previous value without reading a ref.
  const [keptIdentity, setKeptIdentity] = useState<Me | null>(null);
  if (liveIdentity && liveIdentity !== keptIdentity) {
    setKeptIdentity(liveIdentity);
  }
  const needsName = !guest && !me.isLoading && me.data === null;
  const identity = liveIdentity ?? (needsName ? keptIdentity : null);

  if (left) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl">No seat at this table</p>
        <p role="status" className="max-w-sm text-sm text-ink-soft text-pretty">
          You've left this room. The guest link is spent on this browser — ask
          whoever shared it for a new one if you need to come back.
        </p>
      </div>
    );
  }
  if ((!stored && me.isLoading) || session.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  }
  if (needsName && !identity) {
    return (
      <NameGate
        onDone={() => {
          if (org && slug) {
            qc.setQueryData<SpaceView>(["space", org, slug], (prev) =>
              prev ? strangerSpace(prev) : prev,
            );
            void qc.invalidateQueries({ queryKey: ["space", org, slug] });
          }
          void session.refetch();
        }}
      />
    );
  }
  // An envelope with no org is broken for a member — a slug alone addresses no
  // space, so treating it as a failed session read keeps the regression
  // visible. For a link guest it is normal: RedactForGuest blanks OrgSlug and
  // SpaceSlug so the room never leaks tenancy the guest is not part of. The
  // sidebar lookup stays disabled either way (enabled: !!slug && !!org &&
  // !guest); only the room itself must still render for the guest.
  //
  // isError alone is not enough to tear the room down: useSession invalidates
  // on every reconnect with retry:false, so a single failed background refetch
  // keeps prior data. Unmounting Room here would destroy an unsaved standup
  // draft that lives in useState inside the room. Gate on data presence only.
  if (!session.data || (!guest && !session.data.orgSlug) || !identity) {
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
    <>
      <AppShell
        orgSlug={env.orgSlug}
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
            {new Date(guest.expiresAt).toLocaleString()}.{" "}
            <button
              type="button"
              onClick={leave}
              className="font-bold underline underline-offset-2 hover:text-ink"
            >
              Leave room
            </button>
          </p>
        )}
        {Room ? (
          <Room
            env={env}
            me={identity}
            status={session.status}
            guest={!!guest}
            kickReason={session.kickReason}
            kicked={session.kicked}
          />
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
      {needsName && (
        <NameGate
          onDone={() => {
            if (org && slug) {
              qc.setQueryData<SpaceView>(["space", org, slug], (prev) =>
                prev ? strangerSpace(prev) : prev,
              );
              void qc.invalidateQueries({ queryKey: ["space", org, slug] });
            }
            void session.refetch();
          }}
        />
      )}
    </>
  );
}
