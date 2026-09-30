import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, NetworkError } from "../lib/api";
import type { DescribedGrant } from "../lib/plugins";
import { catalogueApi } from "../lib/paths";
import { buttonPrimary, labelText } from "../components/Modal";
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

/**
 * The instance plugin catalogue. Everyone in an org can browse it; only the
 * default org's admins are offered the upload, and the server refuses it to
 * anyone else regardless. Capability copy is the server's, never written here.
 */
export function CataloguePage() {
  const qc = useQueryClient();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const catalogue = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api<Catalogue>("GET", catalogueApi),
    retry: false,
  });

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
    }
  };

  return (
    <main className="mx-auto max-w-[860px] px-6 py-9">
      <h1 className="font-display text-3xl">Plugin catalogue</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-soft text-pretty">
        Signed plugin bundles this instance holds, for any org to install.
        Every bundle was verified against a key this instance trusts.
      </p>

      {catalogue.data?.can_upload && (
        <section className="mt-8">
          <h2 className="font-display text-xl">Add a bundle</h2>
          <label htmlFor={fileId} className={labelText}>
            A signed .parley file
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              id={fileId}
              type="file"
              accept=".parley"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setStatus("");
                setFailure("");
              }}
            />
            <button type="button" className={buttonPrimary} disabled={!file || busy} onClick={() => void upload()}>
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
          <p role="status" className="mt-2 text-sm text-ink-soft">
            {status}
          </p>
          {failure && (
            <p role="alert" className="mt-2 text-sm font-bold text-stop">
              {failure}
            </p>
          )}
        </section>
      )}

      {catalogue.isPending && <p className="mt-6 text-ink-soft">Loading the catalogue…</p>}
      {catalogue.isError && (
        <p role="alert" className="mt-6 font-bold text-stop">
          {errorText(catalogue.error)}
        </p>
      )}
      {catalogue.data && catalogue.data.plugins.length === 0 && (
        <p className="mt-6 text-ink-soft">The catalogue is empty.</p>
      )}

      {catalogue.data?.plugins.map((p) => (
        <section key={p.name} aria-label={p.name} className="mt-8 rounded-panel border border-line bg-surface p-5">
          <h2 className="font-display text-xl">{p.name}</h2>
          {p.versions.map((v) => (
            <div key={`${v.digest}/${v.key_id}`} className="mt-4">
              <h3 className="font-bold">{v.version}</h3>
              <p className="font-mono text-[11px] text-ink-faint break-all">
                {v.digest} · {v.key_id ? `key ${v.key_id}` : "unsigned"}
              </p>
              <GrantList grants={v.grants} />
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
