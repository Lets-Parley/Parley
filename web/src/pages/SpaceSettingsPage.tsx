import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Person, type SpaceRole, type SpaceView } from "../lib/api";
import { useMe } from "../components/NameGate";
import { AppShell } from "../components/AppShell";
import {
  buttonDanger,
  buttonQuiet,
  inputClass,
  labelClass,
} from "../components/Modal";
import { DecksPanel } from "../components/DecksPanel";
import { useCopy, useToast } from "../lib/ui";
import { inviteLink } from "../lib/invite";
import { spaceApi, spacePath } from "../lib/paths";

/**
 * Everything that changes a space, on its own page.
 *
 * It is a route rather than a panel on the space page because the two have
 * different audiences and different lifetimes: the table is what the team opens
 * daily, and this is housekeeping an owner does rarely. Keeping them on one
 * scroll put `Delete this space` beside the session list and pushed the
 * passcode about a viewport and a half down.
 *
 * The query key is the space page's, so arriving here serves from cache.
 */
export function SpaceSettingsPage() {
  const { org = "", slug = "" } = useParams();
  const qc = useQueryClient();
  const me = useMe();
  const say = useToast();
  // Route changes do not move focus on their own, so a keyboard or screen
  // reader user would still be parked wherever the Settings link was.
  const column = useRef<HTMLDivElement>(null);

  const space = useQuery({
    queryKey: ["space", org, slug],
    queryFn: () => api<SpaceView>("GET", spaceApi(org, slug)),
    retry: false,
  });

  const ready = !!space.data;
  useEffect(() => {
    if (ready) column.current?.focus();
  }, [ready]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["space", org, slug] });

  if (space.isLoading || me.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Finding the table…</p>;
  }
  if (!space.data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl">No table under that name</p>
        <p className="text-sm text-ink-soft">Check the link with your team.</p>
      </div>
    );
  }

  const sp = space.data;
  // Settings is not a way in. Somebody who has not joined belongs at the gate,
  // which is what the space page renders for them.
  if (sp.members === undefined) return <Navigate to={spacePath(org, slug)} replace />;

  // Hiding a control is a courtesy; the server enforces the same rule and
  // answers 403 to a member who reaches the route another way.
  const canManage = sp.members.find((m) => m.userId === me.data?.id)?.role === "owner";

  return (
    <AppShell
      orgSlug={org}
      spaceSlug={sp.slug}
      spaceName={sp.name}
      title="Settings"
      me={me.data ?? null}
      members={sp.members}
      presence={sp.members.filter((m) => m.at).map((m) => m.userId)}
      sessions={sp.sessions ?? []}
      canManage={canManage}
    >
      {/* Full width by design: below 768px the sidebar is a sheet, so this is
          the whole column, and above it the rail is already beside us. */}
      <div
        ref={column}
        tabIndex={-1}
        className="mx-auto max-w-[760px] px-6 py-9 outline-none sm:px-8"
      >
        <Link
          to={spacePath(org, sp.slug)}
          className="inline-block text-[13px] font-bold text-accent hover:underline"
        >
          ← Back to {sp.name}
        </Link>

        {!canManage ? (
          <p className="mt-6 rounded-card border border-line bg-surface px-5 py-4 text-sm text-ink-soft text-pretty">
            Only an owner can manage this space. Ask one of them — the roster in
            the sidebar says who they are.
          </p>
        ) : (
          <>
            <MembersPanel
              org={org}
              slug={sp.slug}
              members={sp.members}
              meId={me.data?.id ?? ""}
              onChanged={refresh}
              onError={say}
            />
            <AccessPanel
              org={org}
              slug={sp.slug}
              passcode={sp.passcode ?? ""}
              onChanged={refresh}
              onError={say}
            />
            <VisibilityPanel
              org={org}
              slug={sp.slug}
              visibility={sp.visibility ?? "private"}
              onChanged={refresh}
              onError={say}
            />
            <SpaceNamePanel org={org} slug={sp.slug} name={sp.name} onChanged={refresh} onError={say} />
          </>
        )}
        {/* Outside the owner branch on purpose: the decks are what a member
            picks from when they start a session, so seeing which ones the
            space keeps is reference, not administration. Only the controls
            are an owner's. */}
        <DecksPanel org={org} slug={sp.slug} canManage={canManage} onError={say} />
        {canManage && <DangerZone org={org} slug={sp.slug} name={sp.name} onError={say} />}
      </div>
    </AppShell>
  );
}

/**
 * Who is in the space and who runs it.
 *
 * Every rule here is enforced by the server as well — hiding a button is a
 * courtesy, not the guard.
 */
function MembersPanel({
  org,
  slug,
  members,
  meId,
  onChanged,
  onError,
}: {
  org: string;
  slug: string;
  members: Person[];
  meId: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const [busy, setBusy] = useState("");
  const owners = members.filter((m) => m.role === "owner").length;

  async function run(userId: string, work: () => Promise<unknown>, done: string) {
    setBusy(userId);
    try {
      await work();
      onChanged();
      say(done);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update that member.");
    } finally {
      setBusy("");
    }
  }

  function setRole(m: Person, role: SpaceRole) {
    run(
      m.userId,
      () => api("POST", `${spaceApi(org, slug)}/members/${m.userId}/role`, { role }),
      role === "owner" ? `${m.name} can now manage this space` : `${m.name} is a member again`,
    );
  }

  function remove(m: Person) {
    run(
      m.userId,
      () => api("DELETE", `${spaceApi(org, slug)}/members/${m.userId}`),
      `${m.name} no longer has a seat here`,
    );
  }

  if (members.length === 0) return null;

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">Members</h2>
      <ul className="mt-2 flex flex-col divide-y divide-line">
        {members.map((m) => {
          const isOwner = m.role === "owner";
          // The server refuses to strand a space without an owner; the UI says
          // so up front instead of offering a button that always 409s.
          const lastOwner = isOwner && owners < 2;
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                {m.name}
                {m.userId === meId && <span className="ml-1.5 text-ink-faint">(you)</span>}
              </span>
              <span
                className={
                  "shrink-0 rounded-chip px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] " +
                  (isOwner ? "bg-accent-soft text-ink" : "bg-felt-deep text-ink-faint")
                }
              >
                {isOwner ? "Owner" : "Member"}
              </span>
              <button
                className={buttonQuiet}
                disabled={busy === m.userId || lastOwner}
                title={lastOwner ? "Promote someone else first — a space needs an owner" : undefined}
                aria-label={(isOwner ? "Make member: " : "Make owner: ") + m.name}
                onClick={() => setRole(m, isOwner ? "member" : "owner")}
              >
                {isOwner ? "Make member" : "Make owner"}
              </button>
              <button
                className={buttonQuiet}
                disabled={busy === m.userId || lastOwner}
                title={lastOwner ? "Promote someone else first — a space needs an owner" : undefined}
                aria-label={"Remove: " + m.name}
                onClick={() => remove(m)}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The door: the passcode, and the two ways to change it.
 *
 * Rotating locks out everyone still holding the old code, which is why these
 * controls live here rather than on the page the team opens daily.
 */
function AccessPanel({
  org,
  slug,
  passcode,
  onChanged,
  onError,
}: {
  org: string;
  slug: string;
  passcode: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const copyText = useCopy();
  const [busy, setBusy] = useState(false);

  // The same copy affordance the guest-link panel uses, denial path included.
  const copy = (text: string, done: string) => copyText(text, done, onError);

  async function set(open: boolean) {
    setBusy(true);
    try {
      await api("POST", `${spaceApi(org, slug)}/passcode`, { open });
      onChanged();
      say(open ? "Space opened — the link is now the only thing needed" : "New passcode — the old one stops working");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update the passcode.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">Access</h2>
      {passcode ? (
        /* Never break the code itself — it is the one string on this page that
           gets read out loud. The button row wraps instead. */
        <p className="mt-1 whitespace-nowrap font-mono text-lg font-semibold tracking-[0.16em]">
          {passcode}
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-ink-soft">
          Open — anyone with the link can take a seat.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className={buttonQuiet}
          onClick={() =>
            copy(inviteLink(org, slug, passcode), "Invite link copied — it seats them in one click")
          }
        >
          Copy invite
        </button>
        {passcode && (
          <button className={buttonQuiet} onClick={() => copy(passcode, "Passcode copied")}>
            Copy passcode
          </button>
        )}
        <button className={buttonQuiet} disabled={busy} onClick={() => set(false)}>
          {passcode ? "New passcode" : "Protect space"}
        </button>
        {passcode && (
          <button className={buttonQuiet} disabled={busy} onClick={() => set(true)}>
            Make open
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        A new passcode retires the old one immediately — anyone still holding it
        drops back to the gate.
      </p>
    </section>
  );
}

/**
 * Whether the org can find this space at all.
 *
 * Deliberately its own panel, and not a control inside Access: the two answer
 * different questions and conflating them is exactly the mistake this feature
 * has to avoid. Visibility decides who can *find* the space; the passcode
 * decides who gets *in*. Neither route writes the other, so "listed in the
 * directory but still behind its passcode" is a real state — and the copy below
 * says so, because a row in a directory reads as an open door if nothing
 * contradicts it.
 *
 * An instance with no sign-in configured refuses org visibility outright, since
 * every visitor there is handed an identity and enrolled in the only org. That
 * refusal is the server's; this shows whatever it says rather than guessing.
 */
function VisibilityPanel({
  org,
  slug,
  visibility,
  onChanged,
  onError,
}: {
  org: string;
  slug: string;
  visibility: "private" | "org";
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const [busy, setBusy] = useState(false);
  const listed = visibility === "org";

  async function set(next: "private" | "org") {
    setBusy(true);
    try {
      await api("PATCH", `${spaceApi(org, slug)}/visibility`, { visibility: next });
      onChanged();
      say(
        next === "org"
          ? "Listed — anyone in your org can find this space"
          : "Unlisted — only a link or an invite finds this space now",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not change who can find this space.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        Who can find it
      </h2>
      <p className="mt-1 text-[13px] text-ink-soft">
        {listed
          ? "Listed — everyone in your org sees this space in the directory."
          : "Unlisted — only a link or an invite finds this space."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className={buttonQuiet}
          disabled={busy}
          onClick={() => set(listed ? "private" : "org")}
        >
          {listed ? "Unlist from the org" : "List in the org"}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        Being listed is not the same as being open. A space with a passcode
        still asks for it, whoever finds it.
      </p>
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        Unlisted means hidden from your colleagues, not from whoever runs this
        instance: an org admin can see that this space exists, its name and how
        many members it has, though never what is said in it.
      </p>
    </section>
  );
}

/** Renaming the space. The slug deliberately stays put. */
function SpaceNamePanel({
  org,
  slug,
  name,
  onChanged,
  onError,
}: {
  org: string;
  slug: string;
  name: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const nameFieldId = useId();

  const trimmed = draft.trim();

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("PATCH", spaceApi(org, slug), { name: trimmed });
      onChanged();
      // The slug is in every invite already handed out, so it deliberately
      // stays put — say so rather than leaving people hunting for a new link.
      say(`Renamed — the link ${spacePath(org, slug)} still works`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename this space.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">Space</h2>
      <form onSubmit={rename} className="mt-1 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor={nameFieldId} className={labelClass + " mt-0"}>
            Space name
          </label>
          <input
            id={nameFieldId}
            className={inputClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={64}
          />
        </div>
        <button type="submit" className={buttonQuiet} disabled={busy || !trimmed || trimmed === name}>
          Rename
        </button>
      </form>
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        The address stays {spacePath(org, slug)}, so invites already sent keep working.
      </p>
    </section>
  );
}

/**
 * Deleting the space, fenced off from everything above it.
 *
 * Deleting asks for the name to be typed back. The confirmation is not
 * ceremony — nothing here is recoverable, and every session, story and vote in
 * the space goes with it.
 */
function DangerZone({
  org,
  slug,
  name,
  onError,
}: {
  org: string;
  slug: string;
  name: string;
  onError: (msg: string) => void;
}) {
  const navigate = useNavigate();
  const say = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  async function destroy() {
    setBusy(true);
    try {
      await api("DELETE", spaceApi(org, slug));
      say(`${name} is gone`);
      navigate("/");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete this space.");
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    /* The fence is the point: a red border and its own heading, so nothing in
       here can be mistaken for the housekeeping above it. */
    <section className="mt-8 rounded-card border-2 border-stop bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-stop">Danger zone</h2>
      {confirming ? (
        <div className="mt-3">
          <p className="text-[13px] text-ink-soft text-pretty">
            This deletes {name} and every session, story and vote in it, for
            everyone. It cannot be undone. Type <strong>{name}</strong> to
            confirm.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              className={inputClass + " min-w-[200px] max-w-[280px] flex-1"}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Type ${name} to confirm`}
              autoFocus
            />
            <button
              className={buttonDanger + " disabled:opacity-50"}
              disabled={busy || typed.trim() !== name}
              onClick={() => void destroy()}
            >
              {busy ? "Deleting…" : "Delete this space"}
            </button>
            <button
              className={buttonQuiet}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-soft text-pretty">
            Deleting takes the space and everything under it, for everybody.
            There is no undo and no archive.
          </p>
          <button className={buttonQuiet + " mt-3"} onClick={() => setConfirming(true)}>
            Delete this space
          </button>
        </>
      )}
    </section>
  );
}
