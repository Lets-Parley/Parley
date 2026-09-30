function tsType(field) {
  if (Array.isArray(field.enum)) return field.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (field.type === "integer" || field.type === "number") return "number";
  return field.type === "boolean" ? "boolean" : "string";
}

/**
 * TypeScript for a manifest's `settings` schema: `Settings` is what
 * getSettings returns (secret fields are never in it), `SecretName` the
 * names getSecret reads.
 */
export function generateSettingsTypes(manifest) {
  const props = (manifest.settings && manifest.settings.properties) || {};
  const required = new Set((manifest.settings && manifest.settings.required) || []);
  const plain = Object.keys(props).filter((n) => props[n].format !== "secret");
  const secret = Object.keys(props).filter((n) => props[n].format === "secret");
  const lines = [`// Generated from the settings schema of ${manifest.name || "this plugin"}.`];
  if (plain.length === 0) {
    lines.push("export type Settings = Record<string, never>;");
  } else {
    lines.push("export interface Settings {");
    for (const n of plain) {
      if (props[n].description) lines.push(`  /** ${props[n].description} */`);
      lines.push(`  ${/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)}${required.has(n) ? "" : "?"}: ${tsType(props[n])};`);
    }
    lines.push("}");
  }
  lines.push(`export type SecretName = ${secret.length ? secret.map((n) => JSON.stringify(n)).join(" | ") : "never"};`, "");
  return lines.join("\n");
}
