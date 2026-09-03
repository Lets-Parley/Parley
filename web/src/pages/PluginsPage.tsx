import { useId, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../lib/api";
import type { DescribedGrant, InstalledPlugin, PluginPreview, PluginRegistry } from "../lib/plugins";
import { normalizePluginPreview, normalizePluginRegistry } from "../lib/plugins";
import { pluginsApi } from "../lib/paths";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
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
        {!(registry.error instanceof ApiError && registry.error.status === 403) && (
          <InstallPanel org={org} onDone={refresh} onSay={say} />
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
 * A theme pack owns every colour token in the app, including the ones a button
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
            A theme pack is a value map — sixteen colours and nothing else. It
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
function GrantList({ grants, tone }: { grants: DescribedGrant[]; tone?: "add" | "drop" }) {
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
  onDone,
  onSay,
}: {
  org: string;
  onDone: () => void;
  onSay: (m: string) => void;
}) {
  const fileId = useId();
  const ackId = useId();
  const base = pluginsApi(org);
  const [pkg, setPkg] = useState<unknown>(null);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [ack, setAck] = useState(false);
  const [problem, setProblem] = useState("");

  const install = useMutation({
    mutationFn: () => api("POST", base, { package: pkg, grantsAccepted: true }),
    onSuccess: () => {
      setPkg(null);
      setPreview(null);
      setAck(false);
      onSay(preview?.upgrade ? "Upgrade recorded." : "Installed.");
      onDone();
    },
    onError: (e) => setProblem(errorText(e)),
  });

  async function readFile(file: File) {
    setProblem("");
    setPreview(null);
    setAck(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setProblem("that file is not JSON");
      return;
    }
    setPkg(parsed);
    try {
      // The server describes what it will permit. Asking it, rather than
      // reading the manifest here, is what stops this screen and the guard
      // drifting apart.
      setPreview(normalizePluginPreview(await api<PluginPreview>("POST", `${base}/preview`, parsed)));
    } catch (e) {
      setProblem(errorText(e));
    }
  }

  return (
    <div className="mt-5 rounded-card border border-line bg-surface p-5">
      <label htmlFor={fileId} className={"block " + labelText}>
        Plugin package file (.json)
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
      {problem && (
        <p role="alert" className="mt-3 text-[13px] font-bold text-stop">
          {problem}
        </p>
      )}

      {preview && (
        <div className="mt-4">
          <h3 className="font-display text-lg">
            {preview.name} {preview.version}
            {preview.upgrade && " — an upgrade"}
          </h3>
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

          <label htmlFor={ackId} className="mt-4 flex items-start gap-2 text-[13px] text-pretty">
            <input
              id={ackId}
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              I have read what this plugin will be able to do, and I grant it.
            </span>
          </label>
          <button
            type="button"
            className={buttonPrimary + " mt-3"}
            disabled={!ack || install.isPending}
            onClick={() => install.mutate()}
          >
            {preview.upgrade ? "Submit this upgrade" : "Grant and install"}
          </button>
        </div>
      )}
    </div>
  );
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

function HealthBadge({ health }: { health: InstalledPlugin["health"] }) {
  const word =
    health.state === "healthy" ? "Running" : health.state === "degraded" ? "Degraded" : "Disabled";
  const tone =
    health.state === "healthy" ? "text-go" : health.state === "degraded" ? "text-brass" : "text-stop";
  return (
    <>
      <strong className={tone}>{word}</strong>
      {health.reason && <> — {health.reason}</>}
    </>
  );
}
