import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, NetworkError } from "../lib/api";
import type { DescribedGrant } from "../lib/plugins";
import { catalogueApi } from "../lib/paths";
import { buttonPrimary } from "../components/Modal";
import { GrantList } from "./PluginsPage";

type CatalogueVersion = {
  version: string;
  digest: string;
  key_id: string;
  grants: DescribedGrant[];
  settings?: unknown;
};
type Catalogue = {
  can_upload: boolean;
  plugins: { name: string; versions: CatalogueVersion[] }[];
};

/** The raw bundle upload. Its type is not JSON on purpose: see catalogue.go. */
async function uploadBundle(file: Blob): Promise<void> {
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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A digest is too long to read whole: its ends identify it at a glance. */
function shortDigest(d: string): string {
  return d.length > 20 ? `${d.slice(0, 12)}…${d.slice(-6)}` : d;
}

function BundleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
      <path d="M12 16V8m-3 3 3-3 3 3" className="text-accent" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 motion-safe:animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
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
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const catalogue = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api<Catalogue>("GET", catalogueApi),
    retry: false,
  });

  const clearInput = () => {
    if (input.current) input.current.value = "";
  };
  const choose = (f: File | null) => {
    setStatus("");
    setFailure("");
    if (f && !f.name.toLowerCase().endsWith(".parley")) {
      setFile(null);
      clearInput();
      setFailure(`“${f.name}” is not a .parley bundle. Choose a file ending in .parley.`);
      return;
    }
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files?.[0] ?? null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.current?.click();
    }
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setStatus("");
    setFailure("");
    try {
      await uploadBundle(file);
      setStatus(`Added ${file.name} to the catalogue.`);
      await qc.invalidateQueries({ queryKey: ["catalogue"] });
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
      setFile(null);
      clearInput();
    }
  };

  const plugins = catalogue.data?.plugins ?? [];

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
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          <div
            role="button"
            tabIndex={0}
            aria-describedby={hintId}
            onClick={() => input.current?.click()}
            onKeyDown={onKey}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={
              "mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-panel border-2 border-dashed px-6 py-9 text-center " +
              "transition-[background-color,border-color,transform] duration-[var(--dur-lift)] ease-[var(--ease-settle)] motion-reduce:transition-none " +
              "hover:border-accent hover:bg-surface-hi focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
              (dragging
                ? "border-accent bg-accent-soft motion-safe:scale-[1.01]"
                : "border-line-strong bg-surface")
            }
          >
            <span className={dragging ? "text-accent" : "text-ink-soft"}>
              <BundleIcon />
            </span>
            <span className="font-bold">
              Drop a .parley bundle here or <span className="text-accent underline underline-offset-2">browse</span>
            </span>
            <span id={hintId} className="text-xs text-ink-faint">
              Signed bundles only, up to 16 MiB.
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {file && (
              <span className="flex min-w-0 items-center gap-3 rounded-chip border border-line bg-surface-hi py-1.5 pl-3 pr-1.5 text-sm">
                <span className="min-w-0 truncate font-bold">{file.name}</span>
                <span className="shrink-0 text-ink-faint tabular-nums">{formatSize(file.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-felt-deep hover:text-ink"
                  onClick={() => {
                    setFile(null);
                    clearInput();
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </span>
            )}
            <button
              type="button"
              className={`${buttonPrimary} inline-flex items-center gap-2`}
              disabled={!file || busy}
              aria-busy={busy}
              onClick={() => void upload()}
            >
              {busy && <Spinner />}
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
          <p role="status" className="mt-3 text-sm font-bold text-go empty:hidden">
            {status}
          </p>
          {failure && (
            <p role="alert" className="mt-3 text-sm font-bold text-stop">
              {failure}
            </p>
          )}
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
