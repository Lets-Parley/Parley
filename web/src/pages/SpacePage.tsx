import { Fragment, useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SessionSummary, type SpaceView } from "../lib/api";
import { useAuthMode, useMe, NameGate } from "../components/NameGate";
import { isFullAccount } from "../lib/links";
import { AppShell, Logo } from "../components/AppShell";
import { KindChip } from "../components/KindChip";
import { EmptyTable } from "./PokerRoom";
import {
  Modal,
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  inputClass,
  labelClass,
} from "../components/Modal";
import { useCopy, useToast } from "../lib/ui";
import { spaceApi, spacePath } from "../lib/paths";
import { inviteLink } from "../lib/invite";
import { KINDS, defaultConfig, kindLabel, type KindDef } from "../lib/kinds";

// "" is the All tab; every other value is a registered kind's wire id.
const KIND_TABS = [{ id: "", label: "All" }, ...KINDS];
type Sort = "Recent" | "Active first" | "A\u2013Z";

/**
 * The credential an invite arrived with: a passcode read out of the URL
 * fragment, or a handle that waited out a sign-in round trip. Exactly one of
 * them is ever set, and the join door takes either.
 */
type Invite = { passcode?: string; handle?: string };

/**
 * The passcode an invite link carried, taken from the URL fragment.
 *
 * A fragment, not a query string: the fragment is never sent to the server and
 * never appears in a Referer header, so a one-click invite does not scatter the
 * passcode through access logs and proxy history the way `?c=` would. It is
 * read once and wiped from the address bar immediately, so it does not survive
 * into a bookmark or a screenshot either.
 */
function takeInviteCode(org: string, slug: string): Invite {
  const match = /(?:^|&)c=([^&]+)/.exec(window.location.hash.replace(/^#/, ""));
  if (!match) {
    // Nothing in the fragment. There may still be a handle parked from before
    // a sign-in round trip, which is the only other place an invite lives.
    return takeParkedInvite(org, slug);
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return { passcode: decodeURIComponent(match[1]) };
}

/**
 * Where an invite handle waits out a sign-in round trip.
 *
 * Under an identity provider, taking a seat is a full-page navigation to the
 * provider and back. The fragment does not survive it — `next` is built from
 * the path and query alone, deliberately, because putting the passcode in a
 * query string is the exposure the fragment exists to avoid. Without somewhere
 * to park something the invite is simply lost, and worse than lost: the
 * fragment has already been wiped, so the link the visitor clicked no longer
 * carries the code either and they are stranded at the passcode gate with
 * nothing to type.
 *
 * What waits here is never the passcode. The code is traded first, at the mint
 * door, for an opaque handle the server issues only to a caller who already
 * presented the right code: a capability on this one space that expires in
 * five minutes and is spent by the first join that uses it. So the door code —
 * the one every member of the space shares and reads off the space page —
 * never goes into storage at all, and what does is worth nothing a moment
 * later.
 *
 * sessionStorage, not localStorage, and stamped: an abandoned invite should die
 * with the tab rather than seat someone next week, and the stamp narrows it
 * further to roughly one sign-in trip. Same shape as the pending space name on
 * the landing page, for the same reason.
 */
const pendingInviteKey = "parley:pending-invite";
// A sign-in round trip takes seconds. Five minutes is already generous, and it
// is the server's own limit on the handle too — expiring it here first only
// saves a call that would be refused anyway.
const pendingInviteMaxAgeMs = 5 * 60 * 1000;

/** Reads the parked handle and drops it: one attempt, so a refused invite
 *  lands on the gate rather than being retried on every mount. */
function takeParkedInvite(org: string, slug: string): Invite {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(pendingInviteKey);
    sessionStorage.removeItem(pendingInviteKey);
  } catch {
    // Storage can be unavailable — a locked-down browser, or a test runner
    // started with webstorage off. An invite that cannot be parked still
    // works; it just asks for the passcode.
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const {
      handle,
      at,
      org: forOrg,
      slug: forSlug,
    } = parsed as { handle?: unknown; at?: unknown; org?: unknown; slug?: unknown };
    if (typeof handle !== "string" || typeof at !== "number") return {};
    // A handle belongs to one space. Landing on a different one must not spend
    // it there — the server refuses it, and the real invite is gone. Both
    // halves of the address, because a slug is only unique inside an org: two
    // orgs can each have a "platform-team", and matching on the slug alone
    // would burn a live invite against the wrong one.
    if (forOrg !== org || forSlug !== slug) return {};
    if (!Number.isFinite(at) || Date.now() - at > pendingInviteMaxAgeMs) return {};
    return { handle };
  } catch {
    return {};
  }
}

/** Trades the invite passcode for a handle and parks that instead. The mint
 *  door checks the code exactly as the join door does, so a wrong one gets
 *  nothing to park — and a right one is left in memory only, where the page
 *  already had it. */
async function parkInvite(org: string, slug: string, code: string): Promise<void> {
  if (!code) return;
  try {
    const { handle } = await api<{ handle: string }>("POST", `${spaceApi(org, slug)}/invite`, { passcode: code });
    sessionStorage.setItem(pendingInviteKey, JSON.stringify({ handle, org, slug, at: Date.now() }));
  } catch {
    // See takeParkedInvite: parking is a convenience, never a requirement. A
    // visitor whose handle could not be minted or stored is asked for the
    // passcode on the way back, which is where they started.
  }
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function SpacePage() {
  const { org = "", slug = "" } = useParams();
  const qc = useQueryClient();
  const me = useMe();
  const authMode = useAuthMode();
  const say = useToast();
  const [needName, setNeedName] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState<Sort>("Recent");
  // Held across the name prompt so a joiner presents the invite exactly once.
  const [pending, setPending] = useState<Invite>({});
  // Read on the first render, before anything can navigate: an invite link
  // carries its passcode in the fragment, and this is the only chance to see
  // it. Empty for a link pasted without one, which is the ordinary case.
  const [invited] = useState<Invite>(() => takeInviteCode(org, slug));
  /** The room whose manage dialog is open, if any. */
  const [managing, setManaging] = useState<SessionSummary | null>(null);
  // One attempt only. A refused passcode must land on the gate with the error
  // showing, not retry itself forever against a code that will never work.
  const [autoJoined, setAutoJoined] = useState(false);

  const space = useQuery({
    queryKey: ["space", org, slug],
    queryFn: () => api<SpaceView>("GET", spaceApi(org, slug)),
    retry: false,
    // Presence ages out after ~100s (2 × the socket pong deadline), so a page
    // read once shows a headcount that is quietly wrong within two minutes.
    refetchInterval: 30_000,
  });

  // Opening a space you already belong to is what the landing list means by
  // "recently active" — join only fires for someone who is not a member yet.
  // The read above is a GET and must stay read-only, so the stamp goes out as
  // its own POST. A failed stamp is a slightly stale sort order, nothing to
  // interrupt anyone about.
  const isMember = space.data?.members !== undefined;
  // Cached member view + a null me means the seat dropped under us. Overlay
  // the gate so half-typed create-session fields stay mounted; a silent slide
  // into the room-code gate is the stranger bug.
  const sessionLapsed = isMember && !me.isLoading && me.data === null;
  useEffect(() => {
    if (!isMember) return;
    api("POST", `${spaceApi(org, slug)}/seen`).catch(() => {});
  }, [org, slug, isMember]);

  // The one join path, whether the passcode was typed at the gate or carried
  // in by an invite link. Identity comes first: a visitor with no name is sent
  // through the gate, and the code is held so they only present it once.
  async function attemptJoin(invite: Invite = {}) {
    // Still loading is not the same as "has no identity": asking a member to
    // pick a name again because their session hadn't arrived yet is worse than
    // a moment's wait.
    if (me.isLoading) return;
    // A link guest is bound to one other room, not to this space — treated as
    // "no identity here" the same as a signed-out visitor, so joining goes
    // through the name gate rather than silently reusing that identity.
    if (!isFullAccount(me.data)) {
      setPending(invite);
      // Open mode's gate is a modal: this component stays mounted and the
      // state above survives, so nothing is written anywhere and no handle is
      // minted. Only the provider gate leaves the page, and only that case
      // needs something that survives the trip.
      if (authMode.data?.mode === "oidc") {
        await parkInvite(org, slug, invite.passcode ?? "");
      }
      setNeedName(true);
      return;
    }
    doJoin(invite);
  }

  // An invite link seats you without a second step. It runs at most once — a
  // refused code leaves the gate up with the error on it rather than looping.
  useEffect(() => {
    if ((!invited.passcode && !invited.handle) || autoJoined || isMember || me.isLoading) return;
    setAutoJoined(true);
    // attemptJoin closes over this render's state; the guards above are what
    // keep it to a single run, not the dependency list.
    attemptJoin(invited);
  }, [invited, autoJoined, isMember, me.isLoading]);

  async function doJoin(invite: Invite = {}) {
    try {
      // A handle if one survived the round trip, the typed passcode otherwise.
      // Never both: the join door spends whichever it is handed.
      const credential = invite.handle ? { handle: invite.handle } : invite.passcode ? { passcode: invite.passcode } : {};
      await api("POST", `${spaceApi(org, slug)}/join`, credential);
      setError("");
      qc.invalidateQueries({ queryKey: ["space", org, slug] });
      say("You're seated — pull up a chair");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join.");
    }
  }

  if (space.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Finding the table…</p>;
  }
  // Only the *first* read failing means there is no table. With a poll
  // running, a background refetch failure sets isError while the cached space
  // is still perfectly good — showing the dead end there would replace a
  // working page with an error on one flaky response.
  if (!space.data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl">No table under that name</p>
        <p className="text-sm text-ink-soft">Check the link with your team.</p>
      </div>
    );
  }

  const sp = space.data;

  // Members-only spaces don't leak their contents — the gate says so plainly
  // and points at the one way in.
  if (!isMember) {
    return (
      <>
        <Gate
          name={sp.name}
          org={org}
          slug={sp.slug}
          locked={sp.protected}
          error={error}
          onJoin={(passcode) => attemptJoin(passcode ? { passcode } : {})}
        />
        {needName && (
          <NameGate
            onDone={() => {
              setNeedName(false);
              doJoin(pending);
            }}
          />
        )}
      </>
    );
  }

  const all = sp.sessions ?? [];
  const q = query.trim().toLowerCase();
  const filtered = all
    // Kinds compare by exact wire id — a namespaced id like "acme.retro" has
    // no label to lowercase, and "pokerful" is not "poker".
    .filter((s) => (!kind || s.kind === kind) && (!q || s.title.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "A\u2013Z") return a.title.localeCompare(b.title);
      if (sort === "Active first") return Number(!!a.endedAt) - Number(!!b.endedAt);
      return 0; // "Recent" — the server already returns newest first.
    });
  const filtersOn = !!q || !!kind || sort !== "Recent";
  // What a new session may be: the server omits any kind retired in place.
  // An older server sends no list at all, and offers everything as before.
  const offered = KINDS.filter((k) => sp.kinds?.includes(k.id) ?? true);
  // Hiding a control is a courtesy; the server enforces the same rule and
  // answers 403 to a member who reaches the route another way.
  const canManage = (sp.members ?? []).find((m) => m.userId === me.data?.id)?.role === "owner";

  return (
    <>
    <AppShell
      orgSlug={org}
      spaceSlug={sp.slug}
      spaceName={sp.name}
      me={me.data ?? null}
      members={sp.members}
      // This page holds no socket of its own, so the only honest presence it
      // has is who the server says is sitting in a live session right now.
      presence={(sp.members ?? []).filter((m) => m.at).map((m) => m.userId)}
      sessions={all}
      canManage={canManage}
    >
      <div className="mx-auto max-w-[760px] px-6 py-9 sm:px-8">
        <InviteStrip org={org} slug={sp.slug} passcode={sp.passcode ?? ""} />

        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="text-[22px] font-extrabold tracking-tight">Recent sessions</h2>
          {offered.length > 0 && (
            <button className={buttonPrimary} onClick={() => setCreating(true)}>
              New session
            </button>
          )}
        </div>

        {all.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-ink-faint" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions"
                aria-label="Search sessions"
                className="w-full bg-transparent text-[13px]"
              />
            </label>
            <div className="flex gap-0.5 rounded-full bg-felt-deep p-[3px]">
              {KIND_TABS.map((k) => (
                <button
                  key={k.id}
                  onClick={() => setKind(k.id)}
                  aria-pressed={kind === k.id}
                  className={
                    "rounded-full px-3 py-1.5 text-xs font-bold " +
                    (kind === k.id ? "bg-surface text-ink shadow-rest" : "text-ink-soft")
                  }
                >
                  {k.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSort(sort === "Recent" ? "Active first" : sort === "Active first" ? "A\u2013Z" : "Recent")}
              className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-xs font-bold text-ink-soft hover:bg-surface-hi"
            >
              <span className="font-mono text-[10px] text-ink-faint">SORT</span>
              {sort}
            </button>
            {filtersOn && (
              <button
                onClick={() => {
                  setQuery("");
                  setKind("");
                  setSort("Recent");
                }}
                className="px-1 py-2 text-xs font-bold text-accent"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {all.length === 0 ? (
          <EmptyTable
            heading="Nothing on the table yet"
            body={`Start a session and everyone in ${sp.name} can pull up a chair.`}
          />
        ) : filtered.length === 0 ? (
          <p className="px-2 py-9 text-center text-sm text-ink-soft">
            Nothing matches {q ? `\u201c${query}\u201d` : "these filters"}
            {kind ? ` in ${kindLabel(kind)} sessions` : ""}.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {filtered.map((s) => (
              <li key={s.id} className="relative">
                {/* The button is a sibling of the link, never inside it: a
                    control nested in an anchor is neither reliably clickable
                    nor announced as its own thing. */}
                {canManage && (
                  <button
                    onClick={() => setManaging(s)}
                    aria-label={`Manage ${s.title}`}
                    className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-chip border border-line bg-surface px-2.5 py-1.5 text-[12px] font-bold text-ink-soft hover:bg-felt-deep"
                  >
                    Manage
                  </button>
                )}
                <Link
                  to={`/session/${s.id}`}
                  className={
                    "flex items-center gap-3.5 rounded-card border border-line bg-surface px-5 py-4 shadow-rest transition hover:shadow-lift " +
                    (canManage ? "pr-24" : "")
                  }
                >
                  <KindChip kind={s.kind} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold">{s.title}</span>
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {relativeDate(s.createdAt)}
                    </span>
                  </span>
                  <span className="flex-1" />
                  {/* The text carries the whole meaning — the dot only
                      decorates a count that is already spelled out. */}
                  {s.endedAt ? (
                    <span className="shrink-0 rounded-full bg-felt-deep px-2.5 py-1 font-mono text-[10px] text-ink-faint">
                      ended
                    </span>
                  ) : s.here > 0 ? (
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-go">
                      <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-go" />
                      {`${s.here} here`}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">open</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}

      </div>

      {managing && (
        <RoomManageModal
          org={org}
          slug={sp.slug}
          room={managing}
          onClose={() => setManaging(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["space", org, slug] })}
          onError={say}
        />
      )}

      {creating && (
        <NewSessionModal
          org={org}
          slug={sp.slug}
          kinds={offered}
          onClose={() => setCreating(false)}
          onError={say}
        />
      )}
    </AppShell>
    {sessionLapsed && (
      <NameGate
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["space", org, slug] });
        }}
      />
    )}
    </>
  );
}

function Gate({
  name,
  org,
  slug,
  locked,
  error,
  onJoin,
}: {
  name: string;
  org: string;
  slug: string;
  locked: boolean;
  error: string;
  onJoin: (passcode?: string) => void;
}) {
  const [code, setCode] = useState("");

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <div className="flex items-center gap-2 opacity-80">
        <Logo />
        <span className="text-base font-extrabold">Parley</span>
      </div>
      <div className="w-full max-w-[420px] rounded-panel border border-line bg-surface px-10 py-9 text-center shadow-rest">
        <h1 className="text-2xl font-extrabold tracking-tight">{name}</h1>
        <p className="mt-2 inline-block rounded-chip bg-felt-deep px-2.5 py-1 font-mono text-[11px] text-ink-faint">
          {spacePath(org, slug)}
        </p>
        <div className="my-6 h-px bg-line" />

        {locked ? (
          <>
            <p className="text-sm text-ink-soft text-pretty">
              This table is members-only. Enter the space passcode — whoever
              invited you has it — and pick a display name. No account, no
              password to remember.
            </p>
            <form
              className="mt-5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) onJoin(code.trim());
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Passcode"
                aria-label="Space passcode"
                maxLength={12}
                autoFocus
                className="min-w-0 flex-1 rounded-chip border bg-surface-hi px-3.5 py-2.5 text-center font-mono text-sm tracking-[0.16em] uppercase"
                style={{ borderColor: error ? "var(--color-stop)" : "var(--color-line)" }}
              />
              <button
                type="submit"
                disabled={!code.trim()}
                className="shrink-0 rounded-chip bg-accent px-4 py-2.5 text-[13px] font-bold text-accent-ink disabled:opacity-50"
              >
                Join
              </button>
            </form>
            {error && <p className="mt-2 text-left text-xs font-semibold text-stop text-pretty">{error}</p>}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-soft text-pretty">
              This space is open — the link is the invite. Pick a display name
              and take a seat. No account, no password.
            </p>
            <button className={buttonPrimary + " mt-5"} onClick={() => onJoin()}>
              Take a seat
            </button>
            {error && <p className="mt-3 text-sm font-bold text-stop">{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The invite, in one line, above the session list.
 *
 * Read-only on purpose: rotating a passcode locks out everyone still holding
 * the old one, so every control that changes the door lives on the settings page
 * instead. An open space has no code to show, so the strip says so in the same
 * one line rather than rendering a bordered panel around the word "Open".
 */
function InviteStrip({ org, slug, passcode }: { org: string; slug: string; passcode: string }) {
  const copyText = useCopy();

  return (
    <div
      data-testid="invite-strip"
      className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        {passcode ? "Passcode" : "Access"}
      </span>
      {passcode ? (
        /* Never break the code itself — it is the one string here that gets
           read out loud. */
        <span className="whitespace-nowrap font-mono text-[15px] font-semibold tracking-[0.16em]">
          {passcode}
        </span>
      ) : (
        <span className="text-[13px] text-ink-soft">
          Open — anyone with the link can take a seat.
        </span>
      )}
      <span className="flex-1" />
      <button
        className={buttonQuiet}
        onClick={() =>
          void copyText(
            inviteLink(org, slug, passcode),
            "Invite link copied — it seats them in one click",
          )
        }
      >
        Copy invite
      </button>
    </div>
  );
}

/**
 * Renaming and deleting one room. Owners only — closing a room is the
 * facilitator's call because it ends a meeting, while deleting discards one.
 */
function RoomManageModal({
  org,
  slug,
  room,
  onClose,
  onChanged,
  onError,
}: {
  org: string;
  slug: string;
  room: SessionSummary;
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const [title, setTitle] = useState(room.title);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const titleFieldId = useId();

  const trimmed = title.trim();

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("PATCH", `${spaceApi(org, slug)}/sessions/${room.id}`, { title: trimmed });
      onChanged();
      say("Session renamed");
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename this session.");
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    try {
      await api("DELETE", `${spaceApi(org, slug)}/sessions/${room.id}`);
      onChanged();
      say(`${room.title} is gone`);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete this session.");
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Modal title={`Manage ${room.title}`} onClose={onClose} width="26rem">
      <form onSubmit={rename} className="mt-2">
        <label htmlFor={titleFieldId} className={labelClass + " mt-0"}>
          Session title
        </label>
        <input
          id={titleFieldId}
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          autoFocus
        />
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={busy || !trimmed || trimmed === room.title}
          >
            Rename
          </button>
        </div>
      </form>

      <div className="my-4 h-px bg-line" />

      {confirming ? (
        <div>
          <p className="text-[13px] text-ink-soft text-pretty">
            This deletes {room.title} and everything estimated or said in it,
            for everyone. It cannot be undone.
          </p>
          <div className="mt-3 flex justify-end gap-3">
            <button className={buttonQuiet} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className={buttonDanger + " disabled:opacity-50"}
              disabled={busy}
              onClick={() => void destroy()}
            >
              {busy ? "Deleting…" : "Delete for everyone"}
            </button>
          </div>
        </div>
      ) : (
        <button className={buttonQuiet} onClick={() => setConfirming(true)}>
          Delete this session
        </button>
      )}
    </Modal>
  );
}

function NewSessionModal({
  org,
  slug,
  kinds,
  onClose,
  onError,
}: {
  org: string;
  slug: string;
  /** The kinds this space may start, in registry order. Never empty. */
  kinds: KindDef[];
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const navigate = useNavigate();
  const [kind, setKind] = useState(kinds[0]);
  const [title, setTitle] = useState("");
  const [config, setConfig] = useState(() => defaultConfig(kinds[0]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const sess = await api<SessionSummary>("POST", `${spaceApi(org, slug)}/sessions`, {
        kind: kind.id,
        title: title.trim(),
        config,
      });
      navigate(`/session/${sess.id}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create the session.");
      onClose();
    }
  }

  return (
    <Modal title="New session" onClose={onClose} width="480px">
      <form onSubmit={submit}>
        <span className={labelClass}>Kind</span>
        <div className="flex gap-2">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => {
                setKind(k);
                setConfig(defaultConfig(k));
              }}
              className={
                "flex-1 rounded-chip px-3.5 py-2.5 text-sm " +
                (kind.id === k.id
                  ? "border-2 border-accent bg-accent-soft font-bold"
                  : "border border-line font-semibold text-ink-soft hover:bg-felt-deep")
              }
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className={labelClass} htmlFor="session-title">
          Title
        </label>
        <input
          id="session-title"
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Sprint 43 planning"
          maxLength={200}
          autoFocus
        />

        {(kind.fields ?? []).map((f) => (
          <Fragment key={f.key}>
            <span className={labelClass}>{f.label}</span>
            <div className="grid grid-cols-2 gap-2">
              {f.options.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setConfig({ ...config, [f.key]: d.id })}
                  className={
                    "rounded-chip px-3.5 py-3 text-left " +
                    (config[f.key] === d.id
                      ? "border-2 border-accent bg-accent-soft"
                      : "border border-line hover:bg-felt-deep")
                  }
                >
                  <span className="block text-[13px] font-bold">{d.name}</span>
                  <span className="mt-2 flex gap-1">
                    {d.sample.map((v) => (
                      <span
                        key={v}
                        className="flex h-7 w-5 items-center justify-center rounded-[4px] border border-line bg-surface font-mono text-[0.65rem]"
                      >
                        {v}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </Fragment>
        ))}

        {(kind.toggles ?? []).map((t) => (
          <label key={t.key} className="mt-4 flex items-start gap-3 text-sm text-ink-soft">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={config[t.key] === true}
              onChange={(e) => setConfig({ ...config, [t.key]: e.target.checked })}
            />
            <span>
              <span className="block font-semibold text-ink">{t.label}</span>
              {t.hint && <span className="mt-0.5 block text-[13px] text-ink-faint">{t.hint}</span>}
            </span>
          </label>
        ))}

        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button" className={buttonQuiet} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonPrimary} disabled={!title.trim()}>
            Start session
          </button>
        </div>
      </form>
    </Modal>
  );
}
