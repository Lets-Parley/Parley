import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../lib/api";
import { adminApi, adminPath, orgPath } from "../lib/paths";
import { useDocumentTitle } from "../lib/ui";
import { Logo } from "../components/Brand";
import { AdminTabs } from "../components/AdminTabs";
import { inputClass, labelText } from "../components/Modal";
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

const cell = "px-3 py-2";
const head = "px-3 py-2 font-bold";
const date = (s: string) => new Date(s).toLocaleDateString();

/** The org admin hub: read-only custody tables for spaces and members. */
export function OrgAdminPage() {
  const { org = "", tab } = useParams();
  const known = tab === "spaces" || tab === "members";
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
  // The bare hub opens on Spaces at its own URL, so its tab reads as current.
  if (tab === undefined) return <Navigate to={adminPath(org, "spaces")} replace />;
  if (!known) return <NotFoundPage />;

  const active = tab === "spaces" ? spaces : members;
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
            <SpacesTable spaces={spaces.data ?? []} members={members.data ?? []} />
          ) : (
            <MembersTable members={members.data ?? []} />
          )}
        </>
      )}
    </main>
  );
}

function SpacesTable({ spaces, members }: { spaces: CustodySpace[]; members: OrgMember[] }) {
  const [query, setQuery] = useState("");
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
                <td className={cell}>{s.name}</td>
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
    </>
  );
}

function MembersTable({ members }: { members: OrgMember[] }) {
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
              <td className={cell}>{m.name}</td>
              <td className={cell}>{m.role === "admin" ? "Admin" : "Member"}</td>
              <td className={cell}>{m.revokedAt ? `Revoked ${date(m.revokedAt)}` : "Active"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
