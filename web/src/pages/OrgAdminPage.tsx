import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../lib/api";
import { adminApi, adminPath, orgPath } from "../lib/paths";
import { useDocumentTitle } from "../lib/ui";
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

/** The org admin hub: custody tables for spaces and members. */
export function OrgAdminPage() {
  const { org = "", tab } = useParams();
  const known = tab === "spaces" || tab === "members" || tab === "audit";
  useDocumentTitle(`Org admin - ${org} - Parley`);
  const spaces = useQuery({
    queryKey: ["admin", org, "spaces"],
    queryFn: () => api<CustodySpace[]>("GET", `${adminApi(org)}/spaces`),
    enabled: known && tab === "spaces",
  });
  // Spaces need it too, to name their owners.
  const members = useQuery({
    queryKey: ["admin", org, "members"],
    queryFn: () => api<OrgMember[]>("GET", `${adminApi(org)}/members`),
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
            <div role="alert" className="mt-6 text-sm font-bold text-stop">{errorText(error)}</div>
          ) : active.isLoading || members.isLoading ? (
            <p className="mt-6 text-sm text-ink-faint">Loading…</p>
          ) : tab === "spaces" ? (
            <SpacesTable org={org} spaces={spaces.data ?? []} members={members.data ?? []} />
          ) : tab === "audit" ? (
            <AuditTable
              entries={audit.data?.pages.flat() ?? []}
              more={audit.hasNextPage}
              loading={audit.isFetchingNextPage}
              onMore={() => void audit.fetchNextPage()}
            />
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
  const [openId, setOpenId] = useState<string | null>(null);
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
  const me = useMe().data;
  const [confirm, setConfirm] = useState(false);
  const url = `${adminApi(org)}/members/${encodeURIComponent(member.userId)}`;
  const act = useMutation({
    mutationFn: ({ method, path = "", body }: { method: string; path?: string; body?: unknown }) =>
      api(method, url + path, body),
    onSuccess: () => {
      setConfirm(false);
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
  return (
    <Modal title={member.name} onClose={onClose} anchor="side" width="24rem">
      <p className="text-sm text-ink-soft">
        {member.role === "admin" ? "Admin" : "Member"} ·{" "}
        {member.revokedAt ? `Revoked ${date(member.revokedAt)}` : "Active"}
      </p>
      {act.error && (
        <p role="alert" className="mt-3 text-sm font-bold text-stop">
          {act.error instanceof ApiError && act.error.status === 404
            ? "That person is not in this org any more."
            : errorText(act.error)}
          {stranded?.length ? (
            <>
              <span className="mt-2 block font-normal">Spaces: {stranded.map((slug, i) => (
                <span key={slug}>{i ? ", " : ""}<span className="font-mono">{slug}</span></span>
              ))}</span>
              <span className="mt-1 block font-normal">Add another owner to each on the Spaces tab, then try again.</span>
            </>
          ) : null}
        </p>
      )}
      {!me ? null : self ? (
        <p className="mt-4 text-sm">
          You cannot change your own role or revoke yourself here. Ask another admin of {org}.
        </p>
      ) : member.revokedAt ? (
        <div className="mt-4">
          <p className="text-sm">Restoring returns them as {member.role === "admin" ? "an admin" : "a member"}. It does not put them back in any space.</p>
          <button type="button" className={`${buttonQuiet} mt-2`} disabled={busy} onClick={() => act.mutate({ method: "POST", path: "/restore" })}>
            Restore
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`${buttonQuiet} mt-4`}
            disabled={busy}
            onClick={() => act.mutate({ method: "POST", path: "/role", body: { role: member.role === "admin" ? "member" : "admin" } })}
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
                  <button type="button" className={buttonDanger} disabled={busy} onClick={() => act.mutate({ method: "DELETE" })}>
                    Revoke
                  </button>
                  <button type="button" ref={cancel} className={buttonQuiet} onClick={() => setConfirm(false)}>Cancel</button>
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
  e instanceof ApiError && e.status === 404 ? "That space is not in this org any more." : errorText(e);

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
  const me = useMe().data;
  const [name, setName] = useState(space.name);
  const [owner, setOwner] = useState("");
  const [confirm, setConfirm] = useState<"private" | "archive" | null>(null);
  const [typed, setTyped] = useState("");
  const url = `${adminApi(org)}/spaces/${encodeURIComponent(space.slug)}`;
  const act = useMutation({
    mutationFn: ({ method, path = "", body }: { method: string; path?: string; body?: unknown }) =>
      api(method, url + path, body),
    onSuccess: (_, v) => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["admin", org, "spaces"] });
      if (v.method === "DELETE") onClose();
    },
  });
  const candidates = members.filter(
    (m) => !m.revokedAt && m.userId !== me?.id && !space.ownerIds.includes(m.userId),
  );
  const busy = act.isPending;
  return (
    <Modal title={space.name} onClose={onClose} anchor="side" width="24rem">
      <p className="font-mono text-[13px] text-ink-faint">{space.slug}</p>
      {act.error && (
        <p role="alert" className="mt-3 text-sm font-bold text-stop">{failText(act.error)}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act.mutate({ method: "PATCH", body: { name: name.trim() } });
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
              <span className="text-sm">Only its members will see it listed.</span>
              <button type="button" className={buttonQuiet} disabled={busy} onClick={() => act.mutate({ method: "PATCH", body: { visibility: "private" } })}>
                Make private
              </button>
              <button type="button" className={buttonQuiet} data-autofocus onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className={buttonQuiet} onClick={() => setConfirm("private")}>Make private…</button>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (owner) act.mutate({ method: "POST", path: "/owners", body: { userId: owner } });
        }}
      >
        <label className={labelClass} htmlFor="space-owner">Add owner</label>
        <div className="flex gap-2">
          <select id="space-owner" className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Choose a member</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}</option>
            ))}
          </select>
          <button type="submit" className={buttonQuiet} disabled={busy || !owner}>Add owner</button>
        </div>
        <p className="mt-1 text-[13px] text-ink-faint">They must already be a member of this space.</p>
      </form>
      {space.memberCount === 0 && (
        <div className="mt-4">
          <p className="text-sm">Nobody is left in this space. Claiming it makes you its owner.</p>
          <button type="button" className={`${buttonQuiet} mt-2`} disabled={busy} onClick={() => act.mutate({ method: "POST", path: "/claim" })}>
            Claim this space
          </button>
        </div>
      )}
      <section aria-labelledby="danger-zone" className="mt-8 rounded-card border border-stop p-4">
        <h3 id="danger-zone" className="font-bold text-stop">Danger zone</h3>
        <div className="mt-3">
          {confirm === "archive" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonQuiet} disabled={busy} onClick={() => act.mutate({ method: "PATCH", body: { archived: !space.archivedAt } })}>
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
        <label className={labelClass} htmlFor="space-delete">Type {space.name} to confirm</label>
        <input id="space-delete" className={inputClass} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button
          type="button"
          className={`${buttonDanger} mt-3 disabled:opacity-50`}
          disabled={busy || typed !== space.name}
          onClick={() => act.mutate({ method: "DELETE" })}
        >
          Delete this space
        </button>
      </section>
    </Modal>
  );
}
