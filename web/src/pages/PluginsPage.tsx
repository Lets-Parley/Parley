import { useEffect, useId, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../lib/api";
import type {
  BundleRef,
  Catalog,
  DescribedGrant,
  InstalledPlugin,
  PluginPreview,
  PluginRegistry,
  PluginSettings,
} from "../lib/plugins";
import { direction, normalizePluginPreview, normalizePluginRegistry } from "../lib/plugins";
import { catalogApi, catalogPath, pluginsApi } from "../lib/paths";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  inputClass,
  labelText,
} from "../components/Modal";
import { useToast } from "../lib/ui";
import {
  contrastFailures,
  installThemePack,
  installedThemePack,
  parseThemePack,
  uninstallThemePack,
  type ThemePack,
} from "../lib/theme";

/**
 * The operator's plugin surface — and the consent conversation.
 *
 * This is the only place a human sees what a plugin is asking for before it
 * gets it, so the wording here is part of the security boundary rather than
 * decoration. Two things follow, and both are load-bearing:
 *
 *   - **No capability copy is written in this file.** Every "can send…", every
 *     expanded wildcard, comes from the server's `preview` and list endpoints,
 *     which build it in `internal/plugin` next to the guards that enforce it.
 *     A screen that wrote its own sentences would drift from the rule the host
 *     applies, and the operator would be consenting to the wrong thing.
 *   - **Nothing here is authorization.** The routes 403 an ordinary member
 *     server-side; this page simply cannot be usefully reached without it.
 *
 * Two tiers, two visibly different acts. A theme pack is a value map: it is
 * parsed and applied in this browser, executes nothing, and needs no grant. A
 * plugin runs code in a sandbox, and cannot be installed at all without an
 * explicit grant decision — the checkbox below, and `grantsAccepted` on the
 * wire, which the server refuses to do without.
 */
export function PluginsPage() {
  const { org = "" } = useParams();
  const qc = useQueryClient();
  const say = useToast();
  const base = pluginsApi(org);

  const registry = useQuery({
    queryKey: ["plugins", org],
    queryFn: async () => normalizePluginRegistry(await api<PluginRegistry>("GET", base)),
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["plugins", org] });

  return (
    <main className="mx-auto max-w-[860px] px-6 py-9">
      <h1 className="font-display text-3xl">Plugins</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-soft text-pretty">
        Everything installed on this instance, and everything it is allowed to
        do. Only an operator can reach this page; the server refuses these
        actions to anyone else.
      </p>

      <ThemePanel org={org} onSay={say} />

      <section className="mt-10">
        <h2 className="font-display text-xl">Plugins that run code</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-soft text-pretty">
          A plugin runs inside a sandbox with no network, no disk and no
          database of its own. Everything it can reach, it can only reach
          because you granted it — so read the list before you do.
        </p>

        {registry.data?.hostRunning === false && (
          <p className="mt-4 rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
            No plugin host is running on this instance (<code>PLUGIN_DIR</code>{" "}
            is unset), so nothing here will execute and no health can be
            observed.
          </p>
        )}

        {/* The server is the enforcer, not this check — a refused GET still
            means every write below would 403 too. But showing a live file
            input and an "install" button above a one-line refusal reads as
            actionable when it cannot do anything, so a viewer the server has
            already refused does not see controls that only exist to fail. */}
        {!registry.isLoading && !(registry.error instanceof ApiError && registry.error.status === 403) && (
          <InstallPanel org={org} installs={registry.data?.installs ?? []} onDone={refresh} onSay={say} />
        )}

        {registry.isLoading && <p className="mt-6 text-sm text-ink-faint">Reading the register…</p>}
        {registry.error && (
          <p role="alert" className="mt-6 text-sm font-bold text-stop">
            {errorText(registry.error)}
          </p>
        )}
        {registry.data?.installs.length === 0 && (
          <p className="mt-6 text-sm text-ink-faint">Nothing is installed.</p>
        )}
        <ul className="mt-6 space-y-5">
          {registry.data?.installs.map((p) => (
            <li key={p.id}>
              <InstalledCard install={p} base={base} onDone={refresh} onSay={say} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------- the theme -- */

/**
 * The escape hatch, and why it is styled the way it is.
 *
 * A theme pack owns every color token in the app, including the ones a button
 * is drawn with. A reset control painted in `--color-accent` on
 * `--color-surface` can be made invisible by the very pack it exists to undo,
 * so this one is drawn in literal hex with its own `colorScheme`. It never
 * reads a token, which is the whole of what makes it un-hideable: it sits in
 * the theme panel, beside the control that applied the pack, so the undo is
 * where the act was.
 */
const escapeHatch: React.CSSProperties = {
  background: "#ffffff",
  color: "#111111",
  border: "2px solid #111111",
  borderRadius: "999px",
  padding: "0.5rem 1.15rem",
  fontWeight: 700,
  fontSize: "14px",
  colorScheme: "light",
  cursor: "pointer",
};

function ThemePanel({ org, onSay }: { org: string; onSay: (m: string) => void }) {
  const fileId = useId();
  const ackId = useId();
  const [pack, setPack] = useState<ThemePack | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const installed = installedThemePack();
  const failures = pack ? contrastFailures(pack) : [];
  const base = pluginsApi(org);

  async function readFile(file: File) {
    setAck(false);
    setPack(null);
    setErrors([]);
    let parsed;
    try {
      parsed = parseThemePack(JSON.parse(await file.text()));
    } catch {
      setErrors(["that file is not JSON"]);
      return;
    }
    if (!parsed.ok) setErrors(parsed.errors);
    else setPack(parsed.pack);
  }

  function apply() {
    if (!pack) return;
    try {
      installThemePack(pack, { acknowledgeContrast: ack });
    } catch (e) {
      onSay(errorText(e));
      return;
    }
    // The pack itself never leaves this browser — it is applied here. The
    // audit row is written anyway: "every install" has no exception for the
    // tier that executes nothing.
    api("POST", `${base}/themes`, {
      name: pack.name,
      version: pack.version,
      contrastAcknowledged: failures.length > 0,
    }).catch(() => {});
    onSay(`Applied ${pack.name}.`);
    setPack(null);
  }

  function reset() {
    uninstallThemePack();
    api("DELETE", `${base}/themes`).catch(() => {});
    onSay("Back to the built-in palette.");
  }

  return (
    <section className="mt-8 rounded-card border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">Theme packs</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-soft text-pretty">
            A theme pack is a value map — sixteen colors and nothing else. It
            runs no code, reads nothing, and asks for no capabilities, so there
            is no grant to make. {installed ? `Applied: ${installed.name} ${installed.version}.` : "None applied."}
          </p>
        </div>
        {/* Deliberately not a token in sight — see escapeHatch. */}
        <button type="button" style={escapeHatch} onClick={reset}>
          Reset to the built-in palette
        </button>
      </div>

      <label htmlFor={fileId} className={"mt-5 block " + labelText}>
        Theme pack file (.json)
      </label>
      <input
        id={fileId}
        type="file"
        accept="application/json,.json"
        className="mt-2 block text-sm text-ink-soft"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void readFile(f);
        }}
      />

      {errors.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 text-[13px] font-bold text-stop">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {pack && (
        <div className="mt-4 rounded-chip border border-line-strong p-4">
          <p className="text-sm">
            <strong>{pack.name}</strong> {pack.version} — {Object.keys(pack.modes).length} mode
            {Object.keys(pack.modes).length === 1 ? "" : "s"}
          </p>
          {failures.length > 0 && (
            <div className="mt-3">
              <p role="alert" className="text-[13px] font-bold text-stop text-pretty">
                This pack fails the contrast gate on {failures.length} pair
                {failures.length === 1 ? "" : "s"}. Applying it will make some text
                harder to read, and for some people unreadable.
              </p>
              <ul className="mt-2 space-y-0.5 text-[13px] text-ink-soft">
                {failures.slice(0, 6).map((f) => (
                  <li key={`${f.mode}-${f.foreground}-${f.background}`}>
                    {f.mode}: {f.foreground} on {f.background} is {f.ratio.toFixed(2)}:1, below{" "}
                    {f.required}:1
                  </li>
                ))}
              </ul>
              <label htmlFor={ackId} className="mt-3 flex items-start gap-2 text-[13px] text-pretty">
                <input
                  id={ackId}
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <span>I understand this pack fails the contrast gate and I want to apply it anyway.</span>
              </label>
            </div>
          )}
          <button
            type="button"
            className={buttonPrimary + " mt-4"}
            disabled={failures.length > 0 && !ack}
            onClick={apply}
          >
            Apply this theme
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ the grants -- */

/**
 * One capability, as a consequence. `permits`, `allows` and `refuses` are all
 * written by the server — this renders them and adds nothing.
 */
export function GrantList({ grants, tone }: { grants: DescribedGrant[]; tone?: "add" | "drop" }) {
  if (grants.length === 0) return null;
  return (
    <ul className="mt-2 space-y-2">
      {grants.map((g) => (
        <li
          key={`${g.capability}:${g.scope}`}
          className={
            "rounded-chip border px-3 py-2 text-[13px] text-pretty " +
            (tone === "add"
              ? "border-stop"
              : tone === "drop"
                ? "border-line text-ink-faint"
                : "border-line")
          }
        >
          <p>{g.permits}</p>
          {g.allows && g.allows.length > 0 && (
            <p className="mt-1 text-ink-soft">
              For example: {g.allows.join(", ")}
              {g.refuses && g.refuses.length > 0 && <> — but not {g.refuses.join(", ")}.</>}
            </p>
          )}
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            {g.capability}
            {g.scope ? `: ${g.scope}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------- installing -- */

function InstallPanel({
  org,
  installs,
  onDone,
  onSay,
}: {
  org: string;
  installs: InstalledPlugin[];
  onDone: () => void;
  onSay: (m: string) => void;
}) {
  const ackId = useId();
  const headId = useId();
  const base = pluginsApi(org);
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState<BundleRef | null>(null);
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("GET", catalogApi),
  });
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [ack, setAck] = useState(false);
  const [problem, setProblem] = useState("");
  const running = new Set(installs.map((i) => (i.bundle ? `${i.bundle.digest}/${i.bundle.key_id}` : "")));

  const current = installs.find((i) => i.name === preview?.name);
  const move0 = preview ? direction(preview.version, current?.version) : "install";
  // The same version from another bundle, or onto a pin for an unpinned
  // install, is a re-pin: the rollback route moves to any trusted bundle.
  const move =
    move0 === "same" &&
    current &&
    chosen &&
    (current.bundle?.digest !== chosen.digest || current.bundle?.key_id !== chosen.key_id)
      ? "repin"
      : move0;
  const install = useMutation({
    // Going back is a rollback on the server too, never an install.
    mutationFn: () =>
      (move === "rollback" || move === "repin") && current
        ? api<InstalledPlugin>("POST", `${base}/${current.id}/rollback`, chosen)
        : api<InstalledPlugin>("POST", base, { ...chosen, grantsAccepted: true }),
    onSuccess: (view) => {
      setChosen(null);
      setPreview(null);
      setAck(false);
      onSay(
        outcome(
          view,
          move === "rollback" ? "Rolled back." : move === "repin" ? "Re-pinned." : move === "upgrade" ? "Upgraded." : "Installed.",
        ),
      );
      onDone();
    },
    onError: (e) => setProblem(errorText(e)),
  });

  // Only the latest choice's preview may land; an older one arriving late
  // would describe a bundle other than the one about to be installed.
  const latest = useRef(0);
  async function pick(ref: BundleRef) {
    // A second press on the chosen version puts it down again.
    if (chosen?.digest === ref.digest && chosen?.key_id === ref.key_id) {
      latest.current++;
      setChosen(null);
      setPreview(null);
      setAck(false);
      setProblem("");
      return;
    }
    setProblem("");
    setPreview(null);
    setAck(false);
    setChosen(ref);
    const mine = ++latest.current;
    try {
      // The server describes what it will permit. Asking it, rather than
      // reading the manifest here, is what stops this screen and the guard
      // drifting apart.
      const got = normalizePluginPreview(await api<PluginPreview>("POST", `${base}/preview`, ref));
      if (mine === latest.current) setPreview(got);
    } catch (e) {
      if (mine === latest.current) setProblem(errorText(e));
    }
  }

  // A link from the catalog names one version: choose it once it loads.
  const wanted = params.get("install");
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !wanted || !catalog.data) return;
    const hit = catalog.data.plugins.flatMap((p) => p.versions).find((v) => `${v.digest}/${v.key_id}` === wanted);
    if (hit) {
      preselected.current = true;
      void pick({ digest: hit.digest, key_id: hit.key_id });
    }
  });

  const plugins = catalog.data?.plugins ?? [];
  const isChosen = (v: BundleRef) => chosen?.digest === v.digest && chosen?.key_id === v.key_id;

  // The consent opens under the plugin that was chosen, not after the list.
  const consentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!preview) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    consentRef.current?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [preview]);
  const consent = (
      <div ref={consentRef} data-consent className="mt-4 border-t border-line">
      {problem && !preview && (
        <p role="alert" className="py-4 text-[13px] font-bold text-stop">
          {problem}
        </p>
      )}

      {preview && (
        <div className="py-5">
          <h3 className="font-display text-lg">
            {preview.name} {preview.version}
            {move === "upgrade" && " — an upgrade"}
            {move === "rollback" && " — a rollback"}
          </h3>
          {preview.kinds.length > 0 && (
            <p className="mt-2 text-sm text-ink-soft">
              Provides: {preview.kinds.map((k) => k.display).join(", ")}
            </p>
          )}
          {preview.upgrade ? (
            <>
              <p className="mt-2 text-sm text-ink-soft text-pretty">
                {preview.added.length > 0
                  ? "This version asks for more than you have already granted. Until you approve it, the plugin keeps running on the version and the capabilities it already has."
                  : "This version asks for nothing beyond what you have already granted."}
              </p>
              {preview.added.length > 0 && (
                <>
                  <p className="mt-4 text-[13px] font-bold">New — this version would gain:</p>
                  <GrantList grants={preview.added} tone="add" />
                </>
              )}
              {preview.removed.length > 0 && (
                <>
                  <p className="mt-4 text-[13px] font-bold">Given up:</p>
                  <GrantList grants={preview.removed} tone="drop" />
                </>
              )}
            </>
          ) : preview.grants.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              This plugin asks for no capabilities at all.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-soft text-pretty">
                Installing it grants all of the following, permanently, until you
                revoke them:
              </p>
              <GrantList grants={preview.grants} />
            </>
          )}

          {move === "same" ? (
            <p className="mt-4 text-sm font-bold text-ink-soft">This version is already running.</p>
          ) : (
            <>
              <label htmlFor={ackId} className="mt-4 flex items-start gap-2 text-[13px] text-pretty">
                <input id={ackId} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I have read what this plugin will be able to do, and I grant it.</span>
              </label>
              <button
                type="button"
                className={buttonPrimary + " mt-3"}
                disabled={!ack || install.isPending}
                onClick={() => install.mutate()}
              >
                {move === "repin"
                  ? "Re-pin to this bundle"
                  : `${move === "upgrade" ? "Upgrade to" : move === "rollback" ? "Roll back to" : "Install"} ${preview.name} ${preview.version}`}
              </button>
            </>
          )}
          {problem && (
            <p role="alert" className="mt-3 text-[13px] font-bold text-stop text-pretty">
              {problem}
            </p>
          )}
        </div>
      )}
      </div>
  );
  const announce = preview ? `Showing what ${preview.name} ${preview.version} may do, below.` : "";
  const chosenName = plugins.find((p) => p.versions.some((v) => isChosen(v)))?.name;

  return (
    <section aria-labelledby={headId} className="mt-5 rounded-panel border border-line bg-surface shadow-rest">
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <h3 id={headId} className="border-b border-line px-4 py-3 font-display text-lg">
        Install from the catalog
      </h3>
      {catalog.isLoading && <p className="px-4 py-4 text-sm text-ink-faint">Reading the catalog…</p>}
      {catalog.error && (
        <p role="alert" className="px-4 py-4 text-[13px] font-bold text-stop">
          {errorText(catalog.error)}
        </p>
      )}
      {catalog.data && plugins.length === 0 && (
        <p className="px-4 py-4 text-sm text-ink-soft text-pretty">
          The catalog is empty; a default-org admin can add bundles at{" "}
          <Link to={catalogPath} className="font-bold text-accent underline underline-offset-2">
            the plugin catalog
          </Link>
          .
        </p>
      )}
      {plugins.length > 0 && (
        <div className="divide-y divide-line">
          {plugins.map((p) => (
            <div key={p.name} role="group" aria-label={p.name} className="px-4 py-4">
              <p className="mb-2 font-bold break-words">{p.name}</p>
              <div data-versions className="flex flex-wrap gap-2">
                {p.versions.map((v) => {
                  const key = `${v.digest}/${v.key_id}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={isChosen(v)}
                      aria-label={`${p.name} ${v.version}${running.has(key) ? ", running" : ""}, ${v.key_id ? `signed by key ${v.key_id.slice(0, 8)}` : "unsigned"}`}
                      onClick={() => void pick({ digest: v.digest, key_id: v.key_id })}
                      className={
                        "flex min-w-0 flex-col items-start gap-0.5 rounded-card border px-3 py-2 text-left " +
                        "transition-[background-color,border-color,box-shadow] duration-[var(--dur-lift)] ease-[var(--ease-settle)] motion-reduce:transition-none " +
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
                        (isChosen(v)
                          ? "border-accent bg-accent-soft shadow-rest"
                          : "border-line bg-surface hover:border-ink-faint hover:bg-surface-hi")
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-bold tabular-nums">{v.version}</span>
                        {running.has(key) && (
                          <span className="rounded-chip bg-go/15 px-1.5 text-[11px] font-bold text-go">Running</span>
                        )}
                      </span>
                      <span className="text-[11px] text-ink-soft">
                        {v.key_id ? `Signed · key ${v.key_id.slice(0, 8)}` : "Unsigned"}
                      </span>
                      <span className="font-mono text-[11px] text-ink-faint" title={v.digest}>
                        {v.digest.slice(0, 12)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {chosenName === p.name && (problem || preview) && consent}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What to say after a move: a 202 comes back with the upgrade pending, and
 * then it has not happened yet — it is waiting on what it would gain.
 */
function outcome(view: InstalledPlugin | undefined, done: string): string {
  const added = view?.pending?.added ?? [];
  if (!view?.pending) return done;
  return `Waiting for approval: ${added.map((g) => (g.scope ? `${g.capability} ${g.scope}` : g.capability)).join(", ") || "the new version"}`;
}

/* ------------------------------------------------------------- installed -- */


function InstalledCard({
  install,
  base,
  onDone,
  onSay,
}: {
  install: InstalledPlugin;
  base: string;
  onDone: () => void;
  onSay: (m: string) => void;
}) {
  const [blocked, setBlocked] = useState("");
  const [confirming, setConfirming] = useState(false);
  const approveId = useId();
  const [approveAck, setApproveAck] = useState(false);

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api("POST", `${base}/${install.id}/enabled`, { enabled }),
    onSuccess: onDone,
    onError: (e) => onSay(errorText(e)),
  });
  const approve = useMutation({
    mutationFn: () => api("POST", `${base}/${install.id}/upgrade`, { approve: true }),
    onSuccess: () => {
      setApproveAck(false);
      onSay("Upgrade approved.");
      onDone();
    },
    onError: (e) => onSay(errorText(e)),
  });
  const rollback = useMutation({
    mutationFn: (to: BundleRef) =>
      api<InstalledPlugin>("POST", `${base}/${install.id}/rollback`, { digest: to.digest, key_id: to.key_id }),
    onSuccess: (view) => {
      setRollingBack("");
      onSay(outcome(view, "Done."));
      onDone();
    },
    onError: (e) => {
      setRollingBack("");
      onSay(errorText(e));
    },
  });
  const [rollingBack, setRollingBack] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (rollingBack) confirmRef.current?.focus();
  }, [rollingBack]);
  const rollbackTo = (install.history ?? []).filter((h) => h.digest !== install.bundle?.digest);
  const uninstall = useMutation({
    mutationFn: () => api("DELETE", `${base}/${install.id}`),
    onSuccess: () => {
      onSay(`Uninstalled ${install.name}.`);
      onDone();
    },
    onError: (e) => setBlocked(errorText(e)),
  });

  const health = install.health;
  return (
    <article className="rounded-card border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg">
            {install.name} <span className="text-ink-faint">{install.version}</span>
          </h3>
          <p className="mt-1 text-[13px] text-ink-soft">
            <HealthBadge health={health} />
          </p>
          {health.lastError && (
            <p className="mt-1 font-mono text-[11px] text-ink-faint">
              Last error: {health.lastError}
            </p>
          )}
          {install.provides.length > 0 && (
            <p className="mt-1 text-[13px] text-ink-soft">
              Provides: {install.provides.join(", ")}
            </p>
          )}
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            {install.bundle
              ? `Bundle ${install.bundle.digest.slice(0, 12)}`
              : "Not in catalog — still runs from PLUGIN_DIR"}
          </p>
          {/* Two steps, like uninstall: the first click only asks. */}
          {rollbackTo.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {rollbackTo.map((h) =>
                rollingBack === h.digest ? (
                  <span
                    key={`${h.digest}/${h.key_id}`}
                    className="flex gap-2"
                    onKeyDown={(e) => e.key === "Escape" && setRollingBack("")}
                    onBlur={(e) => {
                      // Only focus landing elsewhere disarms: a click that
                      // does not focus (Safari) blurs with no related target.
                      const to = e.relatedTarget as Node | null;
                      if (to && !e.currentTarget.contains(to)) setRollingBack("");
                    }}
                  >
                    <button
                      ref={confirmRef}
                      type="button"
                      className={buttonDanger}
                      disabled={rollback.isPending}
                      onClick={() => rollback.mutate(h)}
                    >
                      {direction(h.version, install.version) === "upgrade" ? "Confirm upgrade to" : "Confirm rollback to"} {h.version}
                    </button>
                    <button type="button" className={buttonQuiet} onClick={() => setRollingBack("")}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    key={`${h.digest}/${h.key_id}`}
                    type="button"
                    className={buttonQuiet}
                    disabled={rollback.isPending}
                    onClick={() => setRollingBack(h.digest)}
                  >
                    {direction(h.version, install.version) === "upgrade" ? "Upgrade to" : "Roll back to"} {h.version}
                  </button>
                ),
              )}
            </div>
          )}
          <p role="status" className="sr-only">
            {rollingBack
              ? `Confirm moving ${install.name} from ${install.version} to ${rollbackTo.find((h) => h.digest === rollingBack)?.version}, or cancel.`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonQuiet}
            disabled={setEnabled.isPending}
            onClick={() => setEnabled.mutate(!install.enabled)}
          >
            {install.enabled ? "Disable" : "Re-enable"}
          </button>
          {confirming ? (
            <button
              type="button"
              className={buttonDanger}
              disabled={uninstall.isPending}
              onClick={() => uninstall.mutate()}
            >
              Uninstall for good
            </button>
          ) : (
            <button type="button" className={buttonQuiet} onClick={() => setConfirming(true)}>
              Uninstall…
            </button>
          )}
        </div>
      </div>

      {confirming && !blocked && (
        <p className="mt-3 text-[13px] font-bold text-stop text-pretty">
          Uninstalling destroys this plugin's stored data and its encrypted
          secrets. They cannot be recovered. Disabling it is reversible;
          this is not.
        </p>
      )}
      {blocked && (
        <p role="alert" className="mt-3 text-[13px] font-bold text-stop text-pretty">
          {blocked}
        </p>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-[13px] font-bold text-ink-soft">
          What it is allowed to do ({install.grants.length})
        </summary>
        <GrantList grants={install.grants} />
      </details>

      <SettingsPanel base={`${base}/${install.id}/settings`} onSay={onSay} />

      {install.pending && (
        <div className="mt-4 rounded-chip border border-line-strong p-4">
          <h4 className="font-display text-base">
            Version {install.pending.version} is waiting for you
          </h4>
          <p className="mt-1 text-[13px] text-ink-soft text-pretty">
            It asks for more than {install.name} has now. Until you approve it,
            the plugin keeps running on {install.version} under the capabilities
            already in force.
          </p>
          {install.pending.added.length > 0 && (
            <>
              <p className="mt-3 text-[13px] font-bold">It would gain:</p>
              <GrantList grants={install.pending.added} tone="add" />
            </>
          )}
          {install.pending.removed.length > 0 && (
            <>
              <p className="mt-3 text-[13px] font-bold">It would give up:</p>
              <GrantList grants={install.pending.removed} tone="drop" />
            </>
          )}
          {/*
            Approval is never the default action. Keeping the current grants is
            the primary control and the first in the tab order; approving is
            quiet, comes second, is not autofocused, and is inert until the
            checkbox beside it is ticked — so no single keystroke can widen a
            plugin's capabilities.
          */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => onSay(`${install.name} stays on ${install.version}.`)}
            >
              Keep the current capabilities
            </button>
            <label htmlFor={approveId} className="flex items-start gap-2 text-[13px]">
              <input
                id={approveId}
                type="checkbox"
                checked={approveAck}
                onChange={(e) => setApproveAck(e.target.checked)}
              />
              <span>I grant the additional capabilities above.</span>
            </label>
            <button
              type="button"
              className={buttonQuiet}
              disabled={!approveAck || approve.isPending}
              onClick={() => approve.mutate()}
            >
              Approve the upgrade
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/* -------------------------------------------------------------- settings -- */

type Draft = Record<string, string | boolean>;

/**
 * The form a plugin's manifest declares, fetched only once it is opened. A
 * secret is write-only: the field starts empty whatever is stored, typing
 * replaces it, and clearing is its own explicit act.
 */
function SettingsPanel({ base, onSay }: { base: string; onSay: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-4" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-[13px] font-bold text-ink-soft">Settings</summary>
      {open && <SettingsForm base={base} onSay={onSay} />}
    </details>
  );
}

function SettingsForm({ base, onSay }: { base: string; onSay: (m: string) => void }) {
  const current = useQuery({
    queryKey: ["plugin-settings", base],
    queryFn: () => api<PluginSettings>("GET", base),
    retry: false,
  });
  if (current.isLoading) return <p className="mt-3 text-[13px] text-ink-faint">Reading the settings…</p>;
  if (current.error || !current.data)
    return (
      <p role="alert" className="mt-3 text-[13px] font-bold text-stop">
        {errorText(current.error)}
      </p>
    );
  // Keyed on the read, so a save that refetches starts the form over from
  // what the server now holds.
  return (
    <SettingsEditor
      key={current.dataUpdatedAt}
      data={current.data}
      base={base}
      onSay={onSay}
      onSaved={() => current.refetch()}
    />
  );
}

function initialDraft(data: PluginSettings): Draft {
  const next: Draft = {};
  for (const [name, f] of Object.entries(data.schema?.properties ?? {})) {
    if (f.format === "secret") next[name] = "";
    else {
      const v = data.values[name] ?? f.default;
      next[name] = f.type === "boolean" ? v === true : v === undefined ? "" : String(v);
    }
  }
  return next;
}

function SettingsEditor({
  data,
  base,
  onSay,
  onSaved,
}: {
  data: PluginSettings;
  base: string;
  onSay: (m: string) => void;
  onSaved: () => void;
}) {
  const idBase = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(data));
  const [clearing, setClearing] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const props = Object.entries(data.schema?.properties ?? {});
  const required = new Set(data.schema?.required ?? []);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const [name, f] of props) {
        const v = draft[name];
        if (f.format === "secret") {
          if (typeof v === "string" && v !== "") body[name] = v;
          else if (clearing[name]) body[name] = null;
        } else if (f.type === "boolean") body[name] = v === true;
        else if (typeof v === "string" && v !== "") body[name] = f.type === "string" ? v : Number(v);
      }
      return api<PluginSettings>("PUT", base, body);
    },
    onSuccess: () => {
      onSay("Settings saved.");
      onSaved();
    },
    onError: (e) => {
      setErrors(e instanceof ApiError && e.fields ? e.fields : {});
      onSay(errorText(e));
    },
  });

  if (props.length === 0) return <p className="mt-3 text-[13px] text-ink-faint">This plugin has no settings.</p>;

  return (
    <form
      className="mt-3 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {props.map(([name, f]) => {
        const id = `${idBase}-${name}`;
        const errId = `${id}-error`;
        const hintId = `${id}-hint`;
        const label = f.title || name;
        const described = [f.description ? hintId : "", errors[name] ? errId : ""].filter(Boolean).join(" ") || undefined;
        const common = {
          id,
          "aria-invalid": errors[name] ? true : undefined,
          "aria-describedby": described,
        };
        const set = (v: string | boolean) => {
          setDraft((d) => ({ ...d, [name]: v }));
          // Editing a refused field is the answer to its message.
          setErrors((e) => {
            const rest = { ...e };
            delete rest[name];
            return rest;
          });
        };
        const secret = data.secrets[name];
        return (
          <div key={name}>
            {f.type === "boolean" ? (
              <label htmlFor={id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...common} checked={draft[name] === true} onChange={(e) => set(e.target.checked)} />
                <span>{label}</span>
              </label>
            ) : (
              <>
                <label htmlFor={id} className={`mb-1 block ${labelText}`}>
                  {label}
                  {f.format === "secret" && (
                    <span className="ml-2 normal-case tracking-normal">
                      {secret?.undecryptable
                        ? "Set, but no configured key opens it"
                        : secret?.set && !clearing[name]
                          ? "Set"
                          : clearing[name]
                            ? "Will be cleared"
                            : "Not set"}
                    </span>
                  )}
                </label>
                {f.format === "secret" ? (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={inputClass}
                      placeholder={secret?.set ? "Type to replace it" : "Type to set it"}
                      {...common}
                      value={String(draft[name] ?? "")}
                      onChange={(e) => set(e.target.value)}
                    />
                    {secret?.set && (
                      <button
                        type="button"
                        className={buttonQuiet}
                        aria-pressed={clearing[name] === true}
                        onClick={() => {
                          set("");
                          setClearing((c) => ({ ...c, [name]: !c[name] }));
                        }}
                      >
                        Clear {label}
                      </button>
                    )}
                  </div>
                ) : f.enum ? (
                  <select className={inputClass} {...common} value={String(draft[name] ?? "")} onChange={(e) => set(e.target.value)}>
                    {!required.has(name) && <option value="">Default</option>}
                    {required.has(name) && draft[name] === "" && <option value="">Choose one</option>}
                    {f.enum.map((o) => (
                      <option key={String(o)} value={String(o)}>
                        {String(o)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "string" ? "text" : "number"}
                    step={f.type === "integer" ? 1 : f.type === "number" ? "any" : undefined}
                    className={inputClass}
                    {...common}
                    value={String(draft[name] ?? "")}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </>
            )}
            {f.description && (
              <p id={hintId} className="mt-1 text-[12px] text-ink-soft">
                {f.description}
              </p>
            )}
            {errors[name] && (
              <p id={errId} role="alert" className="mt-1 text-[12px] font-bold text-stop">
                {label} {errors[name]}
              </p>
            )}
          </div>
        );
      })}
      <button type="submit" className={buttonPrimary} disabled={save.isPending}>
        Save settings
      </button>
    </form>
  );
}

// Kept on every card, even when the banner above has already said no health
// is observable: a missing badge here reads as "fine", the same lie this
// screen exists to not tell. Repeating "Not observable" on each card is a
// little noisy, but it is honest at the one place an operator's eye actually
// lands — the card for the plugin they're looking at — without them having to
// remember a banner they scrolled past.
function HealthBadge({ health }: { health: InstalledPlugin["health"] }) {
  const word =
    health.state === "healthy"
      ? "Running"
      : health.state === "degraded"
        ? "Degraded"
        : health.state === "unknown"
          ? "Not observable"
          : "Disabled";
  const tone =
    health.state === "healthy"
      ? "text-go"
      : health.state === "degraded"
        ? "text-brass"
        : health.state === "unknown"
          ? "text-ink-faint"
          : "text-stop";
  return (
    <>
      <strong className={tone}>{word}</strong>
      {health.reason && <> — {health.reason}</>}
    </>
  );
}
