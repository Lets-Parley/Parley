// Plain sentences for the codes the server writes. An unknown code shows as itself.
export const actionText: Record<string, string> = {
  "space.delete": "Deleted a space",
  "space.claim": "Claimed an abandoned space",
  "space.add_owner": "Added an owner to a space",
  "org.purge": "Purged the org",
  "audit.retention_changed": "Changed how long records are kept",
  "plugin.action": "Ran a plugin action",
  "plugin.install": "Installed a plugin",
  "plugin.uninstall": "Uninstalled a plugin",
  "plugin.enable": "Enabled a plugin",
  "plugin.disable": "Disabled a plugin",
  "plugin.upgrade": "Upgraded a plugin",
  "plugin.upgrade_requested": "Requested a plugin upgrade",
  "plugin.upgrade_approved": "Approved a plugin upgrade",
  "plugin.rollback": "Rolled back a plugin",
  "plugin.rollback_requested": "Requested a plugin rollback",
  "plugin.settings": "Changed a plugin's settings",
  "plugin.catalog.upload": "Uploaded a plugin bundle",
  "plugin.catalog.refused": "Refused an unsigned plugin bundle",
  "plugin.dev_register": "Registered a development plugin",
  "theme.install": "Installed a theme",
  "theme.reset": "Reset the theme",
};

export type Family = "all" | "spaces" | "plugins";
export const familyOf = (action: string): Family =>
  action.startsWith("space.")
    ? "spaces"
    : action.startsWith("plugin.") || action.startsWith("theme.")
      ? "plugins"
      : "all";
