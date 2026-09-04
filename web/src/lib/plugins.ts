/**
 * The shapes the plugin administration surface reads.
 *
 * There is deliberately no capability copy in this file. Every human-readable
 * sentence about what a grant permits — and every expanded wildcard — is
 * written by the server in `internal/plugin`, beside the guard that enforces
 * it, so the screen cannot promise a rule the host does not apply.
 */

/** One capability, as the server describes it to a person. */
export type DescribedGrant = {
  capability: string;
  scope: string;
  /** The consequence sentence. Never assembled on this side. */
  permits: string;
  /** Worked examples of what an allowlist entry covers, and what it does not. */
  allows?: string[];
  refuses?: string[];
};

export type PluginHealth = {
  state: "healthy" | "degraded" | "disabled" | "unknown";
  reason: string;
  lastError?: string;
  recoversAt?: string;
};

/** An upgrade waiting on an operator, as a diff against the grants in force. */
export type PendingUpgrade = {
  version: string;
  grants: DescribedGrant[];
  added: DescribedGrant[];
  removed: DescribedGrant[];
};

export type InstalledPlugin = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  grants: DescribedGrant[];
  /** Session kinds this plugin provides; they are what blocks an uninstall. */
  provides: string[];
  pending?: PendingUpgrade;
  health: PluginHealth;
};

export type PluginRegistry = {
  hostRunning: boolean;
  secretsAvailable: boolean;
  installs: InstalledPlugin[];
};

/** One session kind a package declares, as preview and install both carry it. */
export type PluginKindDef = {
  kind: string;
  display: string;
};

/** What the server says an uploaded package would be permitted, before anything is installed. */
export type PluginPreview = {
  name: string;
  version: string;
  grants: DescribedGrant[];
  upgrade: boolean;
  current?: DescribedGrant[];
  added: DescribedGrant[];
  removed: DescribedGrant[];
  widens: boolean;
  kinds: PluginKindDef[];
};

/**
 * The server declares these fields as arrays and, as of the fix in
 * internal/api/plugins.go, always marshals them as `[]` rather than `null`
 * for an install or a diff with nothing in it — a Go test pins that at the
 * wire. This is a second, independent line of defence on the read side: it
 * costs one `?? []` per field, and it means a stray `null` reaching the
 * browser (an older cached response, a future producer that forgets the
 * same discipline) degrades to "shows nothing" rather than white-screening
 * the page the way `install.provides.length` on a real `null` did.
 */
function orEmpty<T>(v: T[] | null | undefined): T[] {
  return v ?? [];
}

export function normalizePluginRegistry(reg: PluginRegistry): PluginRegistry {
  return {
    ...reg,
    installs: reg.installs.map((install) => ({
      ...install,
      grants: orEmpty(install.grants),
      provides: orEmpty(install.provides),
      pending: install.pending
        ? {
            ...install.pending,
            grants: orEmpty(install.pending.grants),
            added: orEmpty(install.pending.added),
            removed: orEmpty(install.pending.removed),
          }
        : install.pending,
    })),
  };
}

export function normalizePluginPreview(preview: PluginPreview): PluginPreview {
  return {
    ...preview,
    grants: orEmpty(preview.grants),
    current: preview.current ? orEmpty(preview.current) : preview.current,
    added: orEmpty(preview.added),
    removed: orEmpty(preview.removed),
    kinds: orEmpty(preview.kinds),
  };
}
