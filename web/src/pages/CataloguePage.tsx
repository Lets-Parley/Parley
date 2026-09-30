import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, NetworkError, type OrgMembership } from "../lib/api";
import { Link } from "react-router-dom";
import type { Catalogue } from "../lib/plugins";
import { catalogueApi, pluginsPath } from "../lib/paths";
import { GrantList } from "./PluginsPage";

/**
 * Uploads a bundle as the raw body; its type is not JSON on purpose (see
 * catalogue.go). `added` is false when the bundle was already held.
 */
async function uploadBundle(file: Blob): Promise<{ added: boolean; name: string; version: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${catalogueApi}/bundles`, {
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
 * The instance plugin catalogue. Everyone in an org can browse it; only the
 * default org's admins are offered the upload, and the server refuses it to
 * anyone else regardless. Capability copy is the server's, never written here.
 */
export function CataloguePage() {
  const qc = useQueryClient();
  const fileId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState("");
  const [drag, setDrag] = useState<Drag>("idle");
  // Enter and leave fire for every child the pointer crosses; the zone counts
  // them so it only goes idle when the pointer has really left it.
  const depth = useRef(0);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const catalogue = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api<Catalogue>("GET", catalogueApi),
    retry: false,
  });

  const clearInput = () => {
    if (input.current) input.current.value = "";
  };
  // Choosing a file is the upload: it is checked, sent, and the zone empties
  // whatever the answer. A drop while one is in flight is ignored.
  const choose = async (f: File | null) => {
    if (!f || uploading) return;
    setStatus("");
    setFailure("");
    if (!f.name.toLowerCase().endsWith(".parley")) {
      clearInput();
      setFailure(`“${f.name}” is not a .parley bundle. Choose a file ending in .parley.`);
      return;
    }
    setUploading(f.name);
    try {
      const got = await uploadBundle(f);
      setStatus(
        got.added
          ? `Added ${f.name} to the catalogue.`
          : `${got.name} ${got.version} is already in the catalogue.`,
      );
      await qc.invalidateQueries({ queryKey: ["catalogue"] });
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setUploading("");
      clearInput();
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDrag("idle");
    if ((e.dataTransfer.files?.length ?? 0) > 1) {
      setStatus("");
      setFailure("One bundle at a time. Drop a single .parley file.");
      return;
    }
    void choose(e.dataTransfer.files?.[0] ?? null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (uploading) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.current?.click();
    }
  };

  const plugins = catalogue.data?.plugins ?? [];
  // The orgs this person administers, each a place a version can be installed.
  const myOrgs = useQuery({
    queryKey: ["my-orgs"],
    queryFn: () => api<OrgMembership[]>("GET", "/api/orgs"),
    retry: false,
  });
  const adminOrgs = Array.isArray(myOrgs.data) ? myOrgs.data.filter((o) => o.role === "admin") : [];

  return (
    <main className="mx-auto max-w-[860px] px-6 py-9">
      <h1 className="font-display text-3xl">Plugin catalogue</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-soft text-pretty">
        Signed plugin bundles this instance holds, for any org to install.
        Every bundle was verified against a key this instance trusts.
      </p>

      {catalogue.data?.can_upload && (
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
            onChange={(e) => void choose(e.target.files?.[0] ?? null)}
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
              (drag === "over"
                ? "border-solid border-accent bg-accent-soft shadow-lift motion-safe:scale-[1.015]"
                : drag === "many"
                  ? "border-stop bg-surface"
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
                <span className={drag === "over" ? "text-accent" : drag === "many" ? "text-stop" : "text-ink-soft"}>
                  <BundleIcon drag={drag} />
                </span>
                <span className="font-bold">
                  {drag === "over" ? (
                    "Release to add it to the catalogue"
                  ) : drag === "many" ? (
                    "One bundle at a time"
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
              Signed bundles only, up to 16 MiB. It uploads as soon as you choose it.
            </span>
          </div>
          {/* Always rendered at a fixed height, so a result never moves the page. */}
          <div data-upload-result className="mt-3 min-h-[3rem] text-sm font-bold">
            <p role="status" className="text-go">
              {uploading ? `Uploading ${uploading}…` : status}
            </p>
            {failure && (
              <p role="alert" className="text-stop">
                {failure}
              </p>
            )}
          </div>
        </section>
      )}

      {catalogue.isPending && <p className="mt-10 text-ink-soft">Loading the catalogue…</p>}
      {catalogue.isError && (
        <p role="alert" className="mt-10 font-bold text-stop">
          {errorText(catalogue.error)}
        </p>
      )}
      {catalogue.data && plugins.length === 0 && (
        <div className="mt-10 rounded-panel border border-line bg-surface px-6 py-8">
          <p className="font-display text-lg">The catalogue is empty.</p>
          <p className="mt-1 max-w-prose text-sm text-ink-soft text-pretty">
            {catalogue.data.can_upload
              ? "Add the first signed bundle above, and every org on this instance can install it."
              : "An admin of the default org adds bundles here. Once one does, your org can install it."}
          </p>
        </div>
      )}

      {plugins.length > 0 && (
        <div className="mt-10 flex flex-col gap-5">
          <h2 className="font-display text-xl">
            Available plugins <span className="text-ink-faint tabular-nums">({plugins.length})</span>
          </h2>
          {plugins.map((p) => (
            <section
              key={p.name}
              aria-label={p.name}
              className="rounded-panel border border-line bg-surface shadow-rest"
            >
              <h3 className="border-b border-line px-5 py-3 font-display text-lg">{p.name}</h3>
              {p.versions.map((v) => (
                <div key={`${v.digest}/${v.key_id}`} className="border-b border-line px-5 py-4 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-bold tabular-nums">{v.version}</span>
                    <span className="rounded-chip bg-felt-deep px-2 py-0.5 text-xs text-ink-soft">
                      {v.key_id ? (
                        <>
                          Signed by key <span className="font-mono">{v.key_id}</span>
                        </>
                      ) : (
                        "Unsigned"
                      )}
                    </span>
                    <span className="font-mono text-xs text-ink-faint" title={v.digest}>
                      {shortDigest(v.digest)}
                    </span>
                    <CopyDigest digest={v.digest} />
                    {adminOrgs.map((o) => (
                      <Link
                        key={o.slug}
                        to={`${pluginsPath(o.slug)}?install=${v.digest}/${v.key_id}`}
                        aria-label={`Install ${p.name} ${v.version} in ${o.name}`}
                        className="ml-auto text-sm font-bold text-accent underline underline-offset-2"
                      >
                        Install in {o.name}
                      </Link>
                    ))}
                  </div>
                  {v.grants.length > 0 ? (
                    <GrantList grants={v.grants} />
                  ) : (
                    <p className="mt-2 text-sm text-ink-soft">Asks for no capabilities.</p>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
