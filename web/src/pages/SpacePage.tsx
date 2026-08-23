import { Fragment, useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Person, type SessionSummary, type SpaceRole, type SpaceView } from "../lib/api";
import { useAuthMode, useMe, NameGate } from "../components/NameGate";
import { isFullAccount } from "../lib/links";
import { AppShell, Logo } from "../components/AppShell";
import { KindChip } from "../components/KindChip";
import { EmptyTable } from "./PokerRoom";
import {
  Modal,
  buttonPrimary,
  buttonQuiet,
  inputClass,
  labelClass,
} from "../components/Modal";
import { useCopy, useToast } from "../lib/ui";
import { KINDS, defaultConfig, kindLabel, type KindDef } from "../lib/kinds";

// "" is the All tab; every other value is a registered kind's wire id.
const KIND_TABS = [{ id: "", label: "All" }, ...KINDS];
type Sort = "Recent" | "Active first" | "A\u2013Z";

/**
 * The passcode an invite link carried, taken from the URL fragment.
 *
 * A fragment, not a query string: the fragment is never sent to the server and
 * never appears in a Referer header, so a one-click invite does not scatter the
 * passcode through access logs and proxy history the way `?c=` would. It is
 * read once and wiped from the address bar immediately, so it does not survive
 * into a bookmark or a screenshot either.
 */
function takeInviteCode(slug: string): string {
  const match = /(?:^|&)c=([^&]+)/.exec(window.location.hash.replace(/^#/, ""));
  if (!match) {
    // Nothing in the fragment. It may still be parked from before a sign-in
    // round trip, which is the only other place an invite code lives.
    return takeParkedInvite(slug);
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]);
}

/**
 * Where an invite passcode waits out a sign-in round trip.
 *
 * Under an identity provider, taking a seat is a full-page navigation to the
 * provider and back. The fragment does not survive it — `next` is built from
 * the path and query alone, deliberately, because putting the passcode in a
 * query string is the exposure the fragment exists to avoid. Without somewhere
 * to park it the code is simply lost, and worse than lost: the fragment has
 * already been wiped, so the invite link the visitor clicked no longer carries
 * it either and they are stranded at the passcode gate with nothing to type.
 *
 * sessionStorage, not localStorage, and stamped: an abandoned invite should die
 * with the tab rather than seat someone next week, and the stamp narrows it
 * further to roughly one sign-in trip. Same shape as the pending space name on
 * the landing page, for the same reason.
 *
 * This does put a passcode in storage in the clear, which is what CodeQL's
 * js/clear-text-storage-of-sensitive-data flags. It is written only when a
 * provider sign-in is about to navigate the page away — never in open mode —
 * it is scoped to one space, spent on the first read, expires in five minutes,
 * and dies with the tab. A space passcode is a shared door code that is
 * printed on the space page for every member to read and passed around in
 * chat; it is not a per-person credential. Same-origin script that could read
 * this could equally read it off the page.
 */
const pendingInviteKey = "parley:pending-invite";
// A sign-in round trip takes seconds. Five minutes is already generous, and
// every minute past that is a plaintext passcode sitting in storage for no
// reason.
const pendingInviteMaxAgeMs = 5 * 60 * 1000;

/** Reads the parked code and drops it: one attempt, so a refused passcode
 *  lands on the gate rather than being retried on every mount. */
function takeParkedInvite(slug: string): string {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(pendingInviteKey);
    sessionStorage.removeItem(pendingInviteKey);
  } catch {
    // Storage can be unavailable — a locked-down browser, or a test runner
    // started with webstorage off. An invite that cannot be parked still
    // works; it just asks for the passcode.
    return "";
  }
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "";
    const { code, at, slug: forSlug } = parsed as { code?: unknown; at?: unknown; slug?: unknown };
    if (typeof code !== "string" || typeof at !== "number") return "";
    // A passcode belongs to one space. Landing on a different one must not
    // spend it there — it would be refused, and the real invite is gone.
    if (forSlug !== slug) return "";
    if (!Number.isFinite(at) || Date.now() - at > pendingInviteMaxAgeMs) return "";
    return code;
  } catch {
    return "";
  }
}

function parkInvite(slug: string, code: string): void {
  if (!code) return;
  try {
    sessionStorage.setItem(pendingInviteKey, JSON.stringify({ code, slug, at: Date.now() }));
  } catch {
    // See takeParkedInvite: parking is a convenience, never a requirement.
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
  const { slug = "" } = useParams();
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
  // Held across the name prompt so a joiner types the code exactly once.
  const [pending, setPending] = useState("");
  // Read on the first render, before anything can navigate: an invite link
  // carries its passcode in the fragment, and this is the only chance to see
  // it. Empty for a link pasted without one, which is the ordinary case.
  const [invited] = useState(() => takeInviteCode(slug));
  /** The room whose manage dialog is open, if any. */
  const [managing, setManaging] = useState<SessionSummary | null>(null);
  // One attempt only. A refused passcode must land on the gate with the error
  // showing, not retry itself forever against a code that will never work.
  const [autoJoined, setAutoJoined] = useState(false);

  const space = useQuery({
    queryKey: ["space", slug],
    queryFn: () => api<SpaceView>("GET", `/api/spaces/${slug}`),
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
  useEffect(() => {
    if (!isMember) return;
    api("POST", `/api/spaces/${slug}/seen`).catch(() => {});
  }, [slug, isMember]);

  // The one join path, whether the passcode was typed at the gate or carried
  // in by an invite link. Identity comes first: a visitor with no name is sent
  // through the gate, and the code is held so they only present it once.
  function attemptJoin(passcode?: string) {
    // Still loading is not the same as "has no identity": asking a member to
    // pick a name again because their session hadn't arrived yet is worse than
    // a moment's wait.
    if (me.isLoading) return;
    // A link guest is bound to one other room, not to this space — treated as
    // "no identity here" the same as a signed-out visitor, so joining goes
    // through the name gate rather than silently reusing that identity.
    if (!isFullAccount(me.data)) {
      setPending(passcode ?? "");
      // Open mode's gate is a modal: this component stays mounted and the
      // state above survives, so nothing is written anywhere. Only the
      // provider gate leaves the page, and only that case pays the cost of
      // putting the passcode in storage.
      if (authMode.data?.mode === "oidc") {
        parkInvite(slug, passcode ?? "");
      }
      setNeedName(true);
      return;
    }
    doJoin(passcode);
  }

  // An invite link seats you without a second step. It runs at most once — a
  // refused code leaves the gate up with the error on it rather than looping.
  useEffect(() => {
    if (!invited || autoJoined || isMember || me.isLoading) return;
    setAutoJoined(true);
    // attemptJoin closes over this render's state; the guards above are what
    // keep it to a single run, not the dependency list.
    attemptJoin(invited);
  }, [invited, autoJoined, isMember, me.isLoading]);

  async function doJoin(passcode?: string) {
    try {
      await api("POST", `/api/spaces/${slug}/join`, passcode ? { passcode } : {});
      setError("");
      qc.invalidateQueries({ queryKey: ["space", slug] });
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
          slug={sp.slug}
          locked={sp.protected}
          error={error}
          onJoin={attemptJoin}
        />
        {needName && (
          <NameGate
            onDone={() => {
              setNeedName(false);
              doJoin(pending || undefined);
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
    <AppShell
      spaceSlug={sp.slug}
      spaceName={sp.name}
      me={me.data ?? null}
      members={sp.members}
      // This page holds no socket of its own, so the only honest presence it
      // has is who the server says is sitting in a live session right now.
      presence={(sp.members ?? []).filter((m) => m.at).map((m) => m.userId)}
      sessions={all}
    >
      <div className="mx-auto max-w-[760px] px-6 py-9 sm:px-8">
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

        {error && <p className="mt-4 text-center text-sm font-bold text-stop">{error}</p>}

        <MembersPanel
          slug={sp.slug}
          members={sp.members ?? []}
          meId={me.data?.id ?? ""}
          onChanged={() => qc.invalidateQueries({ queryKey: ["space", slug] })}
          onError={setError}
        />

        {canManage && (
          <SpaceSettingsPanel
            slug={sp.slug}
            name={sp.name}
            onChanged={() => qc.invalidateQueries({ queryKey: ["space", slug] })}
            onError={setError}
          />
        )}

        <PasscodePanel
          slug={sp.slug}
          passcode={sp.passcode ?? ""}
          onChanged={() => qc.invalidateQueries({ queryKey: ["space", slug] })}
          onError={setError}
        />
      </div>

      {managing && (
        <RoomManageModal
          slug={sp.slug}
          room={managing}
          onClose={() => setManaging(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["space", slug] })}
          onError={setError}
        />
      )}

      {creating && (
        <NewSessionModal
          slug={sp.slug}
          kinds={offered}
          onClose={() => setCreating(false)}
          onError={setError}
        />
      )}
    </AppShell>
  );
}

function Gate({
  name,
  slug,
  locked,
  error,
  onJoin,
}: {
  name: string;
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
          /s/{slug}
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
 * Who is in the space and who runs it. Owners get the controls; everyone else
 * sees the roles, because knowing who to ask is the point of showing them.
 *
 * Every rule here is enforced by the server as well — hiding a button is a
 * courtesy, not the guard.
 */
function MembersPanel({
  slug,
  members,
  meId,
  onChanged,
  onError,
}: {
  slug: string;
  members: Person[];
  meId: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const say = useToast();
  const [busy, setBusy] = useState("");
  const myRole = members.find((m) => m.userId === meId)?.role;
  const canManage = myRole === "owner";
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
      () => api("POST", `/api/spaces/${slug}/members/${m.userId}/role`, { role }),
      role === "owner" ? `${m.name} can now manage this space` : `${m.name} is a member again`,
    );
  }

  function remove(m: Person) {
    run(
      m.userId,
      () => api("DELETE", `/api/spaces/${slug}/members/${m.userId}`),
      `${m.name} no longer has a seat here`,
    );
  }

  if (members.length === 0) return null;

  return (
    <section className="mt-8 rounded-card border border-line bg-surface px-5 py-4">
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
              {canManage && (
                <>
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
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The passcode, readable by members so they can pass it on. */
function PasscodePanel({
  slug,
  passcode,
  onChanged,
  onError,
}: {
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
      await api("POST", `/api/spaces/${slug}/passcode`, { open });
      onChanged();
      say(open ? "Space opened — the link is now the only thing needed" : "New passcode — the old one stops working");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update the passcode.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Space passcode
        </h2>
        {passcode ? (
          /* Never break the code itself. Renaming the buttons to "Copy
             passcode" and "New passcode" widened the row enough to wrap
             RIVER-8412 across two lines, which is unreadable for the one
             string on this panel that gets read out loud. The button row is
             the thing that should wrap instead — it already can. */
          <p className="mt-1 whitespace-nowrap font-mono text-lg font-semibold tracking-[0.16em]">
            {passcode}
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-ink-soft">
            Open — anyone with the link can take a seat.
          </p>
        )}
      </div>
      <button
        className={buttonQuiet}
        onClick={() => {
          const link = `${window.location.origin}/s/${slug}`;
          // The passcode rides in the fragment, so the link is the whole
          // invite: one click seats them, with nothing to read off a second
          // line and retype. A fragment never reaches the server or a Referer
          // header, so it stays out of access logs — see takeInviteCode.
          copy(
            passcode ? `${link}#c=${encodeURIComponent(passcode)}` : link,
            "Invite link copied — it seats them in one click",
          );
        }}
      >
        Copy invite
      </button>
      {passcode && (
        <button
          className={buttonQuiet}
          onClick={() => copy(passcode, "Passcode copied")}
        >
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
    </section>
  );
}

/**
 * Renaming and deleting the space itself. Owners only, and the last thing on
 * the page: it is housekeeping, not something anyone came here to do.
 *
 * Deleting asks for the name to be typed back. The confirmation is not
 * ceremony — nothing here is recoverable, and every session, story and vote in
 * the space goes with it.
 */
function SpaceSettingsPanel({
  slug,
  name,
  onChanged,
  onError,
}: {
  slug: string;
  name: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const navigate = useNavigate();
  const say = useToast();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const nameFieldId = useId();

  const trimmed = draft.trim();

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("PATCH", `/api/spaces/${slug}`, { name: trimmed });
      onChanged();
      // The slug is in every invite already handed out, so it deliberately
      // stays put — say so rather than leaving people hunting for a new link.
      say(`Renamed — the link /s/${slug} still works`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename this space.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    try {
      await api("DELETE", `/api/spaces/${slug}`);
      say(`${name} is gone`);
      navigate("/");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete this space.");
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="mt-8 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        Space settings
      </h2>

      <form onSubmit={rename} className="mt-3 flex flex-wrap items-end gap-3">
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
        <button
          type="submit"
          className={buttonQuiet}
          disabled={busy || !trimmed || trimmed === name}
        >
          Rename
        </button>
      </form>
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        The address stays /s/{slug}, so invites already sent keep working.
      </p>

      <div className="my-4 h-px bg-line" />

      {confirming ? (
        <div>
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
              className="rounded-chip bg-stop px-4 py-2 text-[13px] font-bold text-surface disabled:opacity-50"
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
        <button className={buttonQuiet} onClick={() => setConfirming(true)}>
          Delete this space
        </button>
      )}
    </section>
  );
}

/**
 * Renaming and deleting one room. Owners only — closing a room is the
 * facilitator's call because it ends a meeting, while deleting discards one.
 */
function RoomManageModal({
  slug,
  room,
  onClose,
  onChanged,
  onError,
}: {
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
      await api("PATCH", `/api/spaces/${slug}/sessions/${room.id}`, { title: trimmed });
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
      await api("DELETE", `/api/spaces/${slug}/sessions/${room.id}`);
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
              className="rounded-chip bg-stop px-4 py-2 text-[13px] font-bold text-surface disabled:opacity-50"
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
  slug,
  kinds,
  onClose,
  onError,
}: {
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
      const sess = await api<SessionSummary>("POST", `/api/spaces/${slug}/sessions`, {
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
