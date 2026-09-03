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
  state: "healthy" | "degraded" | "disabled";
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
};
