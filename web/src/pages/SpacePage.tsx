import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Person, type SessionSummary, type SpaceRole, type SpaceView } from "../lib/api";
import { useMe, NameGate } from "../components/NameGate";
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
import { useToast } from "../lib/ui";
import { KINDS, defaultConfig, kindLabel, type KindDef } from "../lib/kinds";

// "" is the All tab; every other value is a registered kind's wire id.
const KIND_TABS = [{ id: "", label: "All" }, ...KINDS];
type Sort = "Recent" | "Active first" | "A\u2013Z";

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
  const say = useToast();
  const [needName, setNeedName] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState<Sort>("Recent");
  // Held across the name prompt so a joiner types the code exactly once.
  const [pending, setPending] = useState("");

  const space = useQuery({
    queryKey: ["space", slug],
    queryFn: () => api<SpaceView>("GET", `/api/spaces/${slug}`),
    retry: false,
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
  if (space.isError || !space.data) {
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
          onJoin={(passcode) => {
            // Still loading is not the same as "has no identity": asking a
            // member to pick a name again because their session hadn't
            // arrived yet is worse than a moment's wait.
            if (me.isLoading) return;
            if (!me.data) {
              setPending(passcode ?? "");
              setNeedName(true);
              return;
            }
            doJoin(passcode);
          }}
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
          <h1 className="text-[22px] font-extrabold tracking-tight">Recent sessions</h1>
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
              <li key={s.id}>
                <Link
                  to={`/session/${s.id}`}
                  className="flex items-center gap-3.5 rounded-card border border-line bg-surface px-5 py-4 shadow-rest transition hover:shadow-lift"
                >
                  <KindChip kind={s.kind} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold">{s.title}</span>
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {relativeDate(s.createdAt)}
                    </span>
                  </span>
                  <span className="flex-1" />
                  {s.endedAt ? (
                    <span className="shrink-0 rounded-full bg-felt-deep px-2.5 py-1 font-mono text-[10px] text-ink-faint">
                      ended
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-go">
                      <span className="h-[7px] w-[7px] rounded-full bg-go" />
                      live
                    </span>
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

        <PasscodePanel
          slug={sp.slug}
          passcode={sp.passcode ?? ""}
          onChanged={() => qc.invalidateQueries({ queryKey: ["space", slug] })}
          onError={setError}
        />
      </div>

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

/** The room code, readable by members so they can pass it on. */
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
  const [busy, setBusy] = useState(false);

  // Clipboard writes reject on an insecure origin or a denied permission, and a
  // success toast over a failed copy sends people off to paste nothing.
  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      say(done);
    } catch {
      onError("Could not copy — copy it by hand.");
    }
  }

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
          <p className="mt-1 font-mono text-lg font-semibold tracking-[0.16em]">{passcode}</p>
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
          copy(
            passcode ? `${link} — passcode ${passcode}` : link,
            passcode ? "Invite copied — link and passcode" : "Invite link copied",
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
          Copy code
        </button>
      )}
      <button className={buttonQuiet} disabled={busy} onClick={() => set(false)}>
        {passcode ? "New code" : "Protect space"}
      </button>
      {passcode && (
        <button className={buttonQuiet} disabled={busy} onClick={() => set(true)}>
          Make open
        </button>
      )}
    </section>
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
