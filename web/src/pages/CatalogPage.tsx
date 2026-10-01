import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, NetworkError, type OrgMembership } from "../lib/api";
import { Link } from "react-router-dom";
import type { Catalog, CatalogVersion, DescribedGrant } from "../lib/plugins";
import { direction } from "../lib/plugins";
import { catalogApi, pluginsPath } from "../lib/paths";
import { Logo } from "../components/Brand";
import { GrantList } from "./PluginsPage";

/**
 * Uploads a bundle as the raw body; its type is not JSON on purpose (see
 * catalog.go). `added` is false when the bundle was already held.
 */
async function uploadBundle(file: Blob): Promise<{ added: boolean; name: string; version: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${catalogApi}/bundles`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/vnd.parley.bundle" },
      body: file,
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : "network failure");
  }
  if (resp.status === 413) throw new ApiError(413, "That bundle is too large to upload.");
  if (!resp.ok) {
    const data = (await resp.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new ApiError(resp.status, data?.error ?? "The upload failed.");
  }
  const body = (await resp.json().catch(() => undefined)) as
    | { name?: string; versions?: { version?: string }[] }
    | undefined;
  return { added: resp.status !== 200, name: body?.name ?? "", version: body?.versions?.[0]?.version ?? "" };
}

/** A digest is too long to read whole: its ends identify it at a glance. */
function shortDigest(d: string): string {
  return d.length > 20 ? `${d.slice(0, 12)}…${d.slice(-6)}` : d;
}

type Drag = "idle" | "over" | "many";

/** One file of an upload batch and what became of it. */
type Result = { file: string; ok: boolean; kind: "added" | "held" | "refused"; text: string };

/** One sentence for the whole batch, e.g. "2 added, 1 already there, 1 refused." */
function summary(results: Result[]): string {
  if (results.length === 0) return "";
  const n = (k: Result["kind"]) => results.filter((r) => r.kind === k).length;
  return [
    n("added") && `${n("added")} added`,
    n("held") && `${n("held")} already there`,
    n("refused") && `${n("refused")} refused`,
  ]
    .filter(Boolean)
    .join(", ") + ".";
}

/**
 * A box whose lid lifts and an arrow that drops in while a bundle is held over
 * the zone. Under reduced motion the same end state is shown without movement.
 */
function BundleIcon({ drag }: { drag: Drag }) {
  const open = drag === "over";
  const move = "motion-safe:transition-transform motion-safe:duration-[var(--dur-lift)] motion-safe:ease-[var(--ease-spring)]";
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10 overflow-visible" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11v7l8 4 8-4v-7M4 11l8 4 8-4M12 15v7" />
      <path d="M4 11l8-4 8 4" className={`${move} ${open ? "-translate-y-[3px]" : ""}`} />
      <path
        d="M12 1v6m-3-3 3 3 3-3"
        className={`${move} ${open ? "translate-y-[4px] text-accent" : drag === "many" ? "opacity-0" : "opacity-60"}`}
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8 motion-safe:animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 12a9 9 0 1 1-9-9" strokeLinecap="round" />
    </svg>
  );
}

function CopyDigest({ digest }: { digest: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-chip px-2 py-1 text-xs font-bold text-ink-soft underline underline-offset-2 hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(digest).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : "Copy digest"}
    </button>
  );
}

/**
 * The instance plugin catalog. Everyone in an org can browse it; only the
 * default org's admins are offered the upload, and the server refuses it to
 * anyone else regardless. Capability copy is the server's, never written here.
 */
export function CatalogPage() {
  const qc = useQueryClient();
  const fileId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState("");
  const [drag, setDrag] = useState<Drag>("idle");
  // Enter and leave fire for every child the pointer crosses; the zone counts
  // them so it only goes idle when the pointer has really left it.
  const depth = useRef(0);
  const [results, setResults] = useState<Result[]>([]);
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("GET", catalogApi),
    retry: false,
  });

  const clearInput = () => {
    if (input.current) input.current.value = "";
  };
  // Choosing files is the upload: each is checked and sent in turn, one
  // result per file, and the zone empties at the end whatever the answers. A
  // drop while a batch is in flight is ignored.
  const choose = async (files: File[]) => {
    if (files.length === 0 || uploading) return;
    setResults([]);
    const add = (r: Result) => setResults((rs) => [...rs, r]);
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith(".parley")) {
        add({ file: f.name, ok: false, kind: "refused", text: `“${f.name}” is not a .parley bundle. Choose a file ending in .parley.` });
        continue;
      }
      setUploading(f.name);
      try {
        const got = await uploadBundle(f);
        add({
          file: f.name,
          ok: true,
          kind: got.added ? "added" : "held",
          text: got.added ? `Added ${f.name} to the catalog.` : `${got.name} ${got.version} is already in the catalog.`,
        });
      } catch (e) {
        add({ file: f.name, ok: false, kind: "refused", text: errorText(e) });
      }
    }
    setUploading("");
    clearInput();
    await qc.invalidateQueries({ queryKey: ["catalog"] });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDrag("idle");
    void choose(Array.from(e.dataTransfer.files ?? []));
  };
  const onKey = (e: KeyboardEvent) => {
    if (uploading) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.current?.click();
    }
  };

  const plugins = catalog.data?.plugins ?? [];
  // The orgs this person administers, each a place a version can be installed.
  const myOrgs = useQuery({
    queryKey: ["my-orgs"],
    queryFn: () => api<OrgMembership[]>("GET", "/api/orgs"),
    retry: false,
  });
  const adminOrgs = Array.isArray(myOrgs.data) ? myOrgs.data.filter((o) => o.role === "admin") : [];

  return (
    <main className="mx-auto max-w-[860px] px-6 py-9">
      <header className="flex items-center gap-3">
        <Link to="/" className="flex items-center gap-3 font-bold tracking-tight">
          <Logo size={20} />
          Parley
        </Link>
      </header>
      <Link
        to={"/"}
        className="mt-6 inline-block text-[13px] font-bold text-accent hover:underline"
      >
        ← Back to your spaces
      </Link>
      <h1 className="mt-3 font-display text-3xl">Plugin catalog</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-soft text-pretty">
        Signed plugin bundles this instance holds, for any org to install.
        Every bundle was verified against a key this instance trusts.
      </p>

      {catalog.data?.can_upload && (
        <section aria-labelledby={`${fileId}-h`} className="mt-10">
          <h2 id={`${fileId}-h`} className="font-display text-xl">
            Add a bundle
          </h2>
          <label htmlFor={fileId} className="sr-only">
            A signed .parley file
          </label>
          <input
            ref={input}
            id={fileId}
            type="file"
            accept=".parley"
            tabIndex={-1}
            className="sr-only"
            disabled={!!uploading}
            multiple
            onChange={(e) => void choose(Array.from(e.target.files ?? []))}
          />
          <div
            role="button"
            tabIndex={0}
            aria-describedby={hintId}
            aria-busy={!!uploading}
            onClick={() => {
              if (!uploading) input.current?.click();
            }}
            onKeyDown={onKey}
            data-drag={drag}
            onDragEnter={(e) => {
              e.preventDefault();
              depth.current += 1;
              setDrag((e.dataTransfer?.items?.length ?? 1) > 1 ? "many" : "over");
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => {
              depth.current = Math.max(0, depth.current - 1);
              if (depth.current === 0) setDrag("idle");
            }}
            onDrop={onDrop}
            className={
              "mt-3 flex cursor-pointer aria-busy:cursor-progress flex-col items-center gap-2 rounded-panel border-2 border-dashed px-6 py-9 text-center " +
              "transition-[background-color,border-color,transform] duration-[var(--dur-lift)] ease-[var(--ease-settle)] motion-reduce:transition-none " +
              "[&>*]:pointer-events-none hover:border-ink-faint hover:bg-surface-hi focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
              (drag !== "idle"
                ? "border-solid border-accent bg-accent-soft shadow-lift motion-safe:scale-[1.015]"
                : "border-line-strong bg-surface")
            }
          >
            {uploading ? (
              <>
                <span className="text-accent">
                  <Spinner />
                </span>
                <span className="font-bold">Uploading {uploading}…</span>
              </>
            ) : (
              <>
                <span className={drag === "idle" ? "text-ink-soft" : "text-accent"}>
                  <BundleIcon drag={drag} />
                </span>
                <span className="font-bold">
                  {drag === "over" ? (
                    "Release to add it to the catalog"
                  ) : drag === "many" ? (
                    "Release to add them to the catalog"
                  ) : (
                    <>
                      Drop a .parley bundle here or{" "}
                      <span className="text-accent underline underline-offset-2">browse</span>
                    </>
                  )}
                </span>
              </>
            )}
            <span id={hintId} className="text-xs text-ink-faint">
              Signed bundles only, up to 16 MiB each. Several at once is fine; they upload as soon as you choose them.
            </span>
          </div>
          {/* Always rendered at a fixed height, so a result never moves the page. */}
          <div data-upload-result className="mt-3 min-h-[3rem] max-h-48 overflow-y-auto text-sm">
            {/* One polite region carries progress, the summary and every row. */}
            <div role="status" aria-live="polite">
              <p className="font-bold text-ink-soft">{uploading ? `Uploading ${uploading}…` : summary(results)}</p>
              {results.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1">
                  {results.map((r, i) => (
                    <li key={i} className="flex items-baseline gap-2">
                      <span
                        className={
                          "shrink-0 rounded-chip px-1.5 text-[11px] font-bold " +
                          (r.ok ? "bg-go/15 text-go" : "bg-stop/10 text-stop")
                        }
                      >
                        {r.ok ? "Done" : "Refused"}
                      </span>
                      <span className={"min-w-0 break-words font-bold " + (r.ok ? "text-ink" : "text-stop")}>
                        {r.ok || r.text.includes(r.file) ? "" : <span className="font-normal text-ink-soft">{r.file}: </span>}
                        {r.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {catalog.isPending && <p className="mt-10 text-ink-soft">Loading the catalog…</p>}
      {catalog.isError && (
        <p role="alert" className="mt-10 font-bold text-stop">
          {errorText(catalog.error)}
        </p>
      )}
      {catalog.data && plugins.length === 0 && (
        <div className="mt-10 rounded-panel border border-line bg-surface px-6 py-8">
          <p className="font-display text-lg">The catalog is empty.</p>
          <p className="mt-1 max-w-prose text-sm text-ink-soft text-pretty">
            {catalog.data.can_upload
              ? "Add the first signed bundle above, and every org on this instance can install it."
              : "An admin of the default org adds bundles here. Once one does, your org can install it."}
          </p>
        </div>
      )}

      {plugins.length > 0 && (
        <div className="mt-10 flex flex-col gap-6">
          <h2 className="font-display text-xl">
            Available plugins <span className="text-ink-faint tabular-nums">({plugins.length})</span>
          </h2>
          {plugins.map((p) => (
            <PluginCard key={p.name} name={p.name} versions={p.versions} adminOrgs={adminOrgs} />
          ))}
        </div>
      )}
    </main>
  );
}

/** Newest first by major.minor.patch. */
function byVersionDesc(a: CatalogVersion, b: CatalogVersion): number {
  const d = direction(a.version, b.version);
  return d === "upgrade" ? -1 : d === "rollback" ? 1 : 0;
}

const grantKey = (g: DescribedGrant) => (g.scope ? `${g.capability} ${g.scope}` : g.capability);

/** What a version asks for beyond, and gives up from, the one before it. */
function changes(v: CatalogVersion, before: CatalogVersion | undefined): string {
  if (!before) return "";
  const now = new Set(v.grants.map(grantKey));
  const then = new Set(before.grants.map(grantKey));
  const adds = [...now].filter((k) => !then.has(k));
  const drops = [...then].filter((k) => !now.has(k));
  return [adds.length ? `adds ${adds.join(", ")}` : "", drops.length ? `drops ${drops.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
}

const signer = (keyId: string) => (keyId ? `key ${keyId.slice(0, 8)}` : "Unsigned");

/**
 * One plugin: who signed it, what it provides and what its latest version may
 * do, said once, then every version as a row that flags only what changed.
 */
function PluginCard({
  name,
  versions,
  adminOrgs,
}: {
  name: string;
  versions: CatalogVersion[];
  adminOrgs: OrgMembership[];
}) {
  const headId = useId();
  const sorted = [...versions].sort(byVersionDesc);
  const latest = sorted[0];
  const provides = latest.provides ?? [];
  return (
    <section aria-labelledby={headId} className="rounded-panel border border-line bg-surface shadow-rest">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-4 py-4 sm:px-5">
        <h3 id={headId} className="font-display text-xl break-words">
          {name}
        </h3>
        <p className="text-sm text-ink-soft">
          Latest <span className="font-bold text-ink tabular-nums">{latest.version}</span>
          {" · "}
          <span className="tabular-nums">
            {sorted.length} {sorted.length === 1 ? "version" : "versions"}
          </span>
          {" · "}
          {latest.key_id ? <>Signed by {signer(latest.key_id)}</> : "Unsigned"}
        </p>
        {provides.length > 0 && (
          <p className="w-full text-sm text-ink-soft">
            Provides <span className="font-bold text-ink">{provides.join(", ")}</span>
          </p>
        )}
      </header>
      <div className="px-4 py-4 sm:px-5">
        <p className="text-[13px] font-bold text-ink-soft">What {latest.version} may do</p>
        {latest.grants.length > 0 ? (
          <GrantList grants={latest.grants} />
        ) : (
          <p className="mt-2 text-sm text-ink-soft">Asks for no capabilities.</p>
        )}
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Versions of {name}</caption>
          <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
            <tr>
              <th scope="col" className="px-4 py-2 font-bold sm:pl-5">Version</th>
              <th scope="col" className="px-2 py-2 font-bold">Signer</th>
              <th scope="col" className="px-2 py-2 font-bold">Digest</th>
              <th scope="col" className="hidden px-2 py-2 font-bold sm:table-cell">Published</th>
              <th scope="col" className="px-4 py-2 font-bold sm:pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v, i) => {
              const diff = changes(v, sorted[i + 1]);
              return (
                <tr key={`${v.digest}/${v.key_id}`} className="border-t border-line align-top">
                  <td className="px-4 py-3 sm:pl-5">
                    <span className="font-bold tabular-nums">{v.version}</span>
                    {diff && <p className="mt-0.5 text-xs text-ink-soft">{diff}</p>}
                  </td>
                  <td className="px-2 py-3">
                    <span className="rounded-chip bg-felt-deep px-2 py-0.5 text-xs text-ink-soft whitespace-nowrap">
                      {signer(v.key_id)}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <span className="font-mono text-xs text-ink-faint" title={v.digest}>
                      {shortDigest(v.digest)}
                    </span>
                    <CopyDigest digest={v.digest} />
                  </td>
                  <td className="hidden px-2 py-3 text-xs text-ink-soft tabular-nums sm:table-cell">
                    {v.published_at ? new Date(v.published_at).toLocaleDateString() : ""}
                  </td>
                  <td className="px-4 py-3 text-right sm:pr-5">
                    {adminOrgs.map((o) => (
                      <Link
                        key={o.slug}
                        to={`${pluginsPath(o.slug)}?install=${v.digest}/${v.key_id}`}
                        aria-label={`Install ${name} ${v.version} in ${o.name}`}
                        className="block whitespace-nowrap text-sm font-bold text-accent underline underline-offset-2"
                      >
                        Install in {o.name}
                      </Link>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
