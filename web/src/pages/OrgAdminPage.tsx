import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../lib/api";
import { adminApi, adminPath, orgPath } from "../lib/paths";
import { useDocumentTitle, useToast } from "../lib/ui";
import { actionText, familyOf, type Family } from "../lib/auditActions";
import { Logo } from "../components/Brand";
import { AdminTabs } from "../components/AdminTabs";
import { buttonDanger, buttonQuiet, inputClass, labelClass, labelText, Modal } from "../components/Modal";
import { useMe } from "../components/NameGate";
import { NotFoundPage } from "./NotFoundPage";

// Exactly the CustodySpace and member fields the custody API answers with.
// Custody is management without access: nothing here is space-scoped, and a
// row never links into its space (AGENTS.md gotcha 26).
type CustodySpace = {
  id: string;
  slug: string;
  name: string;
  ownerIds: string[];
  visibility: "org" | "private";
  memberCount: number;
  archivedAt: string | null;
};
type OrgMember = { userId: string; name: string; role: "admin" | "member"; revokedAt: string | null };

type AuditEntry = {
  id: string;
  createdAt: string;
  actorName: string | null;
  action: string;
  spaceSlug: string;
  detail: string;
};

// The server's default page size; a shorter page is the end of the log.
const auditPage = 50;

const cell = "px-3 py-2";
const head = "px-3 py-2 font-bold";
const date = (s: string) => new Date(s).toLocaleDateString();
// A 4xx will answer the same again; a 5xx or a dropped connection gets one more try.
const retry = (n: number, e: unknown) => n < 1 && !(e instanceof ApiError && e.status < 500);

/** The org admin hub: custody tables for spaces and members. */
export function OrgAdminPage() {
  const { org = "", tab } = useParams();
  const known = tab === "spaces" || tab === "members" || tab === "audit";
  useDocumentTitle(`Org admin - ${org} - Parley`);
  const spaces = useQuery({
    queryKey: ["admin", org, "spaces"],
    queryFn: () => api<CustodySpace[]>("GET", `${adminApi(org)}/spaces`),
    retry,
    enabled: known && tab === "spaces",
  });
  // Spaces need it too, to name their owners.
  const members = useQuery({
    queryKey: ["admin", org, "members"],
    queryFn: () => api<OrgMember[]>("GET", `${adminApi(org)}/members`),
    retry,
    enabled: known,
  });
  const audit = useInfiniteQuery({
    queryKey: ["admin", org, "audit"],
    queryFn: ({ pageParam }) =>
      api<AuditEntry[]>(
        "GET",
        `${adminApi(org)}/audit${
          pageParam ? `?before=${encodeURIComponent(pageParam.createdAt)}&beforeId=${pageParam.id}` : ""
        }`,
      ),
    initialPageParam: null as AuditEntry | null,
    getNextPageParam: (last) => (last.length < auditPage ? undefined : last[last.length - 1]),
    retry,
    enabled: tab === "audit",
  });
  // The bare hub opens on Spaces at its own URL, so its tab reads as current.
  if (tab === undefined) return <Navigate to={adminPath(org, "spaces")} replace />;
  if (!known) return <NotFoundPage />;

  const active = tab === "spaces" ? spaces : tab === "audit" ? audit : members;
  const error = active.error ?? members.error;
  // A foreign or unknown org answers 404, a non-admin 403; both read the same.
  const refused = error instanceof ApiError && (error.status === 403 || error.status === 404);

  return (
    <main className="mx-auto max-w-[860px] px-6 py-9">
      <header className="flex items-center gap-3">
        <Link to="/" className="flex items-center gap-3 font-bold tracking-tight">
          <Logo size={20} />
          Parley
        </Link>
      </header>
      <Link to={orgPath(org)} className="mt-6 inline-flex min-h-6 items-center text-[13px] font-bold text-accent hover:underline">
        ← Back to {org}
      </Link>
      <h1 className="mt-3 font-display text-3xl">Org admin</h1>
      {refused ? (
        <p role="status" className="mt-6 rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
          You are not an administrator of {org}, so this page is not available to you. Ask an
          administrator of {org}, or{" "}
          <Link to={orgPath(org)} className="font-bold text-accent hover:underline">go back to {org}</Link>.
        </p>
      ) : (
        <>
          <AdminTabs org={org} />
          {error ? (
            <div role="alert" className="mt-6 text-sm font-bold text-stop">
              {errorText(error)}{" "}
              <button
                type="button"
                className="underline hover:no-underline"
                onClick={() => {
                  if (active.error) void active.refetch();
                  if (members.error) void members.refetch();
                }}
              >
                Try again
              </button>
            </div>
          ) : active.isLoading || members.isLoading ? (
            <p role="status" className="mt-6 text-sm text-ink-faint">Loading…</p>
          ) : tab === "spaces" ? (
            <SpacesTable org={org} spaces={spaces.data ?? []} members={members.data ?? []} />
          ) : tab === "audit" ? (
            <>
            <RetentionSetting org={org} />
            <AuditTable
              entries={audit.data?.pages.flat() ?? []}
              more={audit.hasNextPage}
              loading={audit.isFetchingNextPage}
              onMore={() => void audit.fetchNextPage()}
            />
            </>
          ) : (
            <MembersTable org={org} members={members.data ?? []} />
          )}
        </>
      )}
    </main>
  );
}

function SpacesTable({ org, spaces, members }: { org: string; spaces: CustodySpace[]; members: OrgMember[] }) {
  const [query, setQuery] = useState("");
  // A stranded revoke sends the admin here with the space to open.
  const want = (useLocation().state as { open?: string } | null)?.open;
  const [openId, setOpenId] = useState<string | null>(() => spaces.find((s) => s.slug === want)?.id ?? null);
  // By id, so the panel follows the refetched row after a rename.
  const opened = spaces.find((s) => s.id === openId);
  const [show, setShow] = useState<"active" | "archived">("active");
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const q = query.trim().toLowerCase();
  const rows = spaces.filter(
    (s) => (show === "archived") === (s.archivedAt !== null) && (!q || s.name.toLowerCase().includes(q)),
  );
  return (
    <>
      <div className="mt-6 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelText}>Filter by name</span>
          <input type="search" className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelText}>Show</span>
          <select className={inputClass} value={show} onChange={(e) => setShow(e.target.value as "active" | "archived")}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Spaces in this org</caption>
          <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
            <tr>
              <th scope="col" className={head}>Name</th>
              <th scope="col" className={head}>Slug</th>
              <th scope="col" className={head}>Visibility</th>
              <th scope="col" className={head}>Members</th>
              <th scope="col" className={head}>Owners</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className={cell}>
                  <button type="button" className="text-left font-bold text-accent hover:underline" onClick={() => setOpenId(s.id)}>
                    <span className="sr-only">Manage</span>{" "}
                    <span>{s.name}</span>
                  </button>
                </td>
                <td className={`${cell} font-mono`}>{s.slug}</td>
                <td className={cell}>{s.visibility === "org" ? "Org" : "Private"}</td>
                <td className={cell}>{s.memberCount}</td>
                <td className={cell}>
                  {s.ownerIds.length ? s.ownerIds.map((id) => names.get(id) ?? "Unknown").join(", ") : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="mt-4 text-sm text-ink-faint">No spaces match.</p>}
      </div>
      {opened && <SpacePanel org={org} space={opened} members={members} onClose={() => setOpenId(null)} />}
    </>
  );
}

const retentionChoices: [string, string][] = [
  ["forever", "Forever"],
  ["365", "1 year"],
  ["90", "90 days"],
  ["30", "30 days"],
];

/** "Keep records for": shortening deletes history, so it waits on a confirm. */
function RetentionSetting({ org }: { org: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const url = `${adminApi(org)}/audit/settings`;
  const key = ["admin", org, "audit", "settings"];
  const saved = useQuery({ queryKey: key, queryFn: () => api<{ retentionDays: number | null }>("GET", url) });
  const save = useMutation({
    mutationFn: (days: number | null) => api("PATCH", url, { retentionDays: days }),
    onSuccess: (_, days) => {
      setPending(undefined);
      toast(days === null ? "Keeping records forever" : `Keeping records for ${days} days`);
      void qc.invalidateQueries({ queryKey: ["admin", org, "audit"] });
    },
  });
  const [pending, setPending] = useState<number | undefined>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pending !== undefined) cancel.current?.focus();
  }, [pending]);
  const current = saved.data?.retentionDays ?? null;
  const choose = (v: string) => {
    const days = v === "forever" ? null : Number(v);
    if (days !== null && (current === null || days < current)) setPending(days);
    else save.mutate(days);
  };
  return (
    <div className="mt-6">
      <label className="flex w-fit flex-col gap-1">
        <span className={labelText}>Keep records for</span>
        <select
          className={inputClass}
          value={current === null ? "forever" : String(current)}
          disabled={!saved.data || save.isPending}
          onChange={(e) => choose(e.target.value)}
        >
          {retentionChoices.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </label>
      {pending !== undefined && (
        <div className="mt-3 rounded-card border border-stop p-4">
          <p className="text-sm">
            Records older than {pending} days will be deleted and cannot be recovered.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonDanger} disabled={save.isPending} onClick={() => save.mutate(pending)}>
              Delete older records
            </button>
            <button type="button" ref={cancel} className={buttonQuiet} onClick={() => setPending(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {(saved.error || save.error) && (
        <p role="alert" className="mt-3 text-sm font-bold text-stop">{errorText(saved.error ?? save.error)}</p>
      )}
    </div>
  );
}

// The family filter is client-side over the pages loaded so far;
// move it to a server param if a busy log makes "Load older" tedious.
function AuditTable({
  entries,
  more,
  loading,
  onMore,
}: {
  entries: AuditEntry[];
  more: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  const [family, setFamily] = useState<Family>("all");
  const rows = family === "all" ? entries : entries.filter((e) => familyOf(e.action) === family);
  return (
    <>
      <label className="mt-6 flex w-fit flex-col gap-1">
        <span className={labelText}>Show</span>
        <select className={inputClass} value={family} onChange={(e) => setFamily(e.target.value as Family)}>
          <option value="all">Everything</option>
          <option value="spaces">Spaces</option>
          <option value="plugins">Plugins</option>
        </select>
      </label>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Audit log for this org, newest first</caption>
          <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
            <tr>
              <th scope="col" className={head}>When</th>
              <th scope="col" className={head}>Who</th>
              <th scope="col" className={head}>Action</th>
              <th scope="col" className={head}>Code</th>
              <th scope="col" className={head}>Space</th>
              <th scope="col" className={head}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-line">
                <td className={`${cell} whitespace-nowrap`}>{new Date(e.createdAt).toLocaleString()}</td>
                <td className={cell}>{e.actorName ?? <span className="text-ink-soft">Unknown or removed account</span>}</td>
                <td className={cell}>{actionText[e.action] ?? e.action}</td>
                <td className={`${cell} font-mono text-[13px] text-ink-soft`}>{e.action}</td>
                <td className={`${cell} font-mono`}>{e.spaceSlug}</td>
                <td className={cell}>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="mt-4 text-sm text-ink-faint">
            {more ? "No matches in the records loaded so far" : "No records match."}
          </p>
        )}
      </div>
      {more && (
        <button type="button" className={`${buttonQuiet} mt-4`} disabled={loading} onClick={onMore}>
          Load older
        </button>
      )}
    </>
  );
}

function MembersTable({ org, members }: { org: string; members: OrgMember[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = members.find((m) => m.userId === openId);
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Members of this org</caption>
        <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
          <tr>
            <th scope="col" className={head}>Name</th>
            <th scope="col" className={head}>Role</th>
            <th scope="col" className={head}>Status</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="border-t border-line">
              <td className={cell}>
                <button type="button" className="text-left font-bold text-accent hover:underline" onClick={() => setOpenId(m.userId)}>
                  <span className="sr-only">Manage</span>{" "}
                  <span>{m.name}</span>
                </button>
              </td>
              <td className={cell}>{m.role === "admin" ? "Admin" : "Member"}</td>
              <td className={cell}>{m.revokedAt ? `Revoked ${date(m.revokedAt)}` : "Active"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {opened && <MemberPanel org={org} member={opened} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Role, revoke and restore for one org member. The admin's own row offers none of them. */
function MemberPanel({ org, member, onClose }: { org: string; member: OrgMember; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useMe().data;
  const [confirm, setConfirm] = useState(false);
  const url = `${adminApi(org)}/members/${encodeURIComponent(member.userId)}`;
  const act = useMutation({
    mutationFn: ({ method, path = "", body }: { method: string; path?: string; body?: unknown; done: string }) =>
      api(method, url + path, body),
    onSuccess: (_, v) => {
      setConfirm(false);
      toast(v.done);
      void qc.invalidateQueries({ queryKey: ["admin", org, "members"] });
      // A revoke can promote a replacement owner in any space it touched.
      void qc.invalidateQueries({ queryKey: ["admin", org, "spaces"] });
    },
  });
  const busy = act.isPending;
  const cancel = useRef<HTMLButtonElement>(null);
  // data-autofocus only acts when the panel mounts; the confirm opens later.
  useEffect(() => {
    if (confirm) cancel.current?.focus();
  }, [confirm]);
  // Until we know who is signed in, every row is treated as their own.
  const self = !me || member.userId === me.id;
  const stranded =
    act.error instanceof ApiError && act.error.status === 409
      ? (act.error.body as { spaces?: string[] } | undefined)?.spaces
      : undefined;
  // Only to name the stranded spaces; the slug stands in until it arrives.
  const spaces = useQuery({
    queryKey: ["admin", org, "spaces"],
    queryFn: () => api<CustodySpace[]>("GET", `${adminApi(org)}/spaces`),
    enabled: !!stranded?.length,
  });
  const spaceName = (slug: string) => spaces.data?.find((s) => s.slug === slug)?.name ?? slug;
  const role = (r: OrgMember["role"]) => (r === "admin" ? "an admin" : "a member");
  return (
    <Modal title={member.name} onClose={onClose} anchor="side" width="24rem">
      <p className="text-sm text-ink-soft">
        {member.role === "admin" ? "Admin" : "Member"} ·{" "}
        {member.revokedAt ? `Revoked ${date(member.revokedAt)}` : "Active"}
      </p>
      {act.error && (
        <div role="alert" className="mt-3 text-sm font-bold text-stop">
          {stranded?.length ? (
            <>
              <p>
                {member.name} is the only owner of {stranded.length === 1 ? "this space" : "these spaces"}, and nobody
                else in {stranded.length === 1 ? "it" : "them"} can take over:
              </p>
              <ul className="mt-2 font-normal">
                {stranded.map((slug) => (
                  <li key={slug} className="mt-1 flex flex-wrap items-center gap-2">
                    <span>{spaceName(slug)}</span>
                    <button
                      type="button"
                      className="font-bold text-accent underline hover:no-underline"
                      aria-label={`Open ${spaceName(slug)} on the Spaces tab`}
                      onClick={() => navigate(adminPath(org, "spaces"), { state: { open: slug } })}
                    >
                      Open on Spaces
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-normal">
                Admins cannot add people to a space, and a new owner can only be promoted from its existing members.
                Archive or delete {stranded.length === 1 ? "it" : "each one"} on the Spaces tab, then try again.
              </p>
            </>
          ) : act.error instanceof ApiError && act.error.status === 404 ? (
            "That person is not in this org any more."
          ) : (
            errorText(act.error)
          )}
        </div>
      )}
      {!me ? null : self ? (
        <p className="mt-4 text-sm">
          You cannot change your own role or revoke yourself here. Ask another admin of {org}.
        </p>
      ) : member.revokedAt ? (
        <div className="mt-4">
          <p className="text-sm">Restoring returns them as {role(member.role)}. It does not put them back in any space.</p>
          <button
            type="button"
            className={`${buttonQuiet} mt-2`}
            disabled={busy}
            onClick={() => act.mutate({ method: "POST", path: "/restore", done: `${member.name} restored` })}
          >
            Restore
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`${buttonQuiet} mt-4`}
            disabled={busy}
            onClick={() => {
              const next = member.role === "admin" ? "member" : "admin";
              act.mutate({ method: "POST", path: "/role", body: { role: next }, done: `${member.name} is now ${role(next)}` });
            }}
          >
            {member.role === "admin" ? "Make member" : "Make admin"}
          </button>
          <section aria-labelledby="member-danger" className="mt-8 rounded-card border border-stop p-4">
            <h3 id="member-danger" className="font-bold text-stop">Danger zone</h3>
            {confirm ? (
              <>
                <p className="mt-3 text-sm">
                  Revoking removes {member.name} from every space in this org and closes their live sessions.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`${buttonDanger} disabled:opacity-50`}
                    disabled={busy || !!stranded?.length}
                    onClick={() => act.mutate({ method: "DELETE", done: `${member.name} revoked` })}
                  >
                    Revoke
                  </button>
                  <button
                    type="button"
                    ref={cancel}
                    className={buttonQuiet}
                    onClick={() => {
                      setConfirm(false);
                      act.reset();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className={`${buttonQuiet} mt-3`} onClick={() => setConfirm(true)}>Revoke…</button>
            )}
          </section>
        </>
      )}
    </Modal>
  );
}

/** Plain words for a refused custody call; a 404 means the space left this org. */
const failText = (e: unknown) =>
  e instanceof ApiError && e.status === 404
    ? "That space is not in this org any more."
    : e instanceof ApiError && e.message.startsWith("custody can only promote")
      ? "They need to be a member of this space first."
      : errorText(e);

/**
 * The custody actions on one space, and nothing else: no roster, no sessions,
 * no link into the room (AGENTS.md gotcha 26). Visibility only ever narrows.
 */
function SpacePanel({
  org,
  space,
  members,
  onClose,
}: {
  org: string;
  space: CustodySpace;
  members: OrgMember[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const [name, setName] = useState(space.name);
  const [owner, setOwner] = useState("");
  const [confirm, setConfirm] = useState<"private" | "archive" | "claim" | null>(null);
  const [typed, setTyped] = useState("");
  const url = `${adminApi(org)}/spaces/${encodeURIComponent(space.slug)}`;
  const act = useMutation({
    mutationFn: ({ method, path = "", body }: { method: string; path?: string; body?: unknown; done: string }) =>
      api(method, url + path, body),
    onSuccess: (_, v) => {
      setConfirm(null);
      if (v.path === "/owners") setOwner("");
      toast(v.done);
      void qc.invalidateQueries({ queryKey: ["admin", org, "spaces"] });
      if (v.method === "DELETE") onClose();
    },
  });
  // Org members who are not owners yet; whether they are in this space only the server knows.
  const candidates = members.filter(
    (m) => !m.revokedAt && m.userId !== me?.id && !space.ownerIds.includes(m.userId),
  );
  const busy = act.isPending;
  // An add-owner refusal sits under its own field; everything else at the top.
  const ownerFailed = act.error && act.variables?.path === "/owners";
  return (
    <Modal title={space.name} onClose={onClose} anchor="side" width="24rem">
      <p className="font-mono text-[13px] text-ink-faint">{space.slug}</p>
      <p className="mt-1 text-sm text-ink-soft">{space.visibility === "org" ? "Listed to the org" : "Private"}</p>
      {act.error && !ownerFailed && (
        <p role="alert" className="mt-3 text-sm font-bold text-stop">{failText(act.error)}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act.mutate({ method: "PATCH", body: { name: name.trim() }, done: `Renamed to ${name.trim()}` });
        }}
      >
        <label className={labelClass} htmlFor="space-name">Name</label>
        <div className="flex gap-2">
          <input id="space-name" className={inputClass} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className={buttonQuiet} disabled={busy}>Rename</button>
        </div>
      </form>
      {/* Custody may only narrow visibility; private to org is the owner's alone. */}
      {space.visibility === "org" && (
        <div className="mt-4">
          {confirm === "private" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">Only its members will see it listed. Only a space owner can list it again.</span>
              <button
                type="button"
                className={buttonQuiet}
                disabled={busy}
                onClick={() => act.mutate({ method: "PATCH", body: { visibility: "private" }, done: `${space.name} is now private` })}
              >
                Make private
              </button>
              <button type="button" className={buttonQuiet} data-autofocus onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className={buttonQuiet} onClick={() => setConfirm("private")}>Make private…</button>
          )}
        </div>
      )}
      {space.memberCount - space.ownerIds.length <= 0 ? (
        <>
          <h3 className={labelClass}>Add owner</h3>
          <p className="text-sm">
            Owners are chosen from a space's existing members, and everyone in this one already owns it or nobody is left.
          </p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const who = candidates.find((m) => m.userId === owner)?.name;
            if (owner) act.mutate({ method: "POST", path: "/owners", body: { userId: owner }, done: `${who} is now an owner` });
          }}
        >
          <label className={labelClass} htmlFor="space-owner">Add owner</label>
          <div className="flex gap-2">
            <select
              id="space-owner"
              className={inputClass}
              value={owner}
              aria-describedby="space-owner-help"
              onChange={(e) => {
                setOwner(e.target.value);
                if (ownerFailed) act.reset();
              }}
            >
              <option value="">Choose a member</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </select>
            <button type="submit" className={buttonQuiet} disabled={busy || !owner}>Add owner</button>
          </div>
          {ownerFailed ? (
            <p id="space-owner-help" role="alert" className="mt-1 text-[13px] font-bold text-stop">{failText(act.error)}</p>
          ) : (
            <p id="space-owner-help" className="mt-1 text-[13px] text-ink-faint">They must already be a member of this space.</p>
          )}
        </form>
      )}
      {space.memberCount === 0 && (
        <div className="mt-4">
          <p className="text-sm">
            Nobody is left in this space. Claiming it makes you its owner, with full access to its sessions and
            their history.
          </p>
          {confirm === "claim" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonQuiet}
                disabled={busy}
                onClick={() => act.mutate({ method: "POST", path: "/claim", done: `You now own ${space.name}` })}
              >
                Claim this space
              </button>
              <button type="button" className={buttonQuiet} data-autofocus onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className={`${buttonQuiet} mt-2`} onClick={() => setConfirm("claim")}>Claim this space…</button>
          )}
        </div>
      )}
      <section aria-labelledby="danger-zone" className="mt-8 rounded-card border border-stop p-4">
        <h3 id="danger-zone" className="font-bold text-stop">Danger zone</h3>
        <div className="mt-3">
          {confirm === "archive" ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonQuiet}
                disabled={busy}
                onClick={() =>
                  act.mutate({
                    method: "PATCH",
                    body: { archived: !space.archivedAt },
                    done: `${space.name} ${space.archivedAt ? "unarchived" : "archived"}`,
                  })
                }
              >
                {space.archivedAt ? "Unarchive" : "Archive"}
              </button>
              <button type="button" className={buttonQuiet} data-autofocus onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className={buttonQuiet} onClick={() => setConfirm("archive")}>
              {space.archivedAt ? "Unarchive…" : "Archive…"}
            </button>
          )}
        </div>
        <p className="mt-4 text-sm">
          Deleting removes every session in this space and its history too. This cannot be undone.
        </p>
        <label className={labelClass} htmlFor="space-delete">
          Type <span className="select-all font-mono normal-case tracking-normal text-ink">{space.name}</span> to confirm
        </label>
        <input
          id="space-delete"
          className={inputClass}
          autoComplete="off"
          aria-describedby="space-delete-hint"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <p id="space-delete-hint" className="mt-1 text-[13px] text-ink-faint">
          {typed && typed !== space.name ? "Doesn't match yet" : ""}
        </p>
        <button
          type="button"
          className={`${buttonDanger} mt-3 disabled:opacity-50`}
          disabled={busy || typed !== space.name}
          onClick={() => act.mutate({ method: "DELETE", done: `${space.name} deleted` })}
        >
          Delete this space
        </button>
      </section>
    </Modal>
  );
}
