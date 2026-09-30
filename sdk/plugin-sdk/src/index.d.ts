export function createHost(grants: Grant[], call: HostCall, manifest?: { settings?: SettingsSchema }): ParleyHost;
export function generateSettingsTypes(manifest: { name?: string; settings?: SettingsSchema }): string;
export function generateGuestHookTypes(abi: { protocol: number; hooks?: Array<{ export: string; typeName: string; input: string; output: string }> }): string;
export const WIRE_PROTOCOL_VERSION: 1;

export type Grant = { capability: string; scope?: string };
export type HostCall = (name: string, req: unknown) => unknown;

export type SettingsField = {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: "secret";
};
export type SettingsSchema = {
  type: "object";
  properties: Record<string, SettingsField>;
  required?: string[];
  additionalProperties: false;
};

export type ParleyHost = {
  /** Non-secret settings values; throws if the manifest declares no settings. */
  getSettings<T = Record<string, unknown>>(): T;
  /** A secret settings field (or a granted secret) by name. */
  getSecret(name: string): unknown;
  kvGet(req: { scope?: string; key: string }): unknown;
  kvSet(req: { scope?: string; key: string; value?: unknown }): unknown;
  fetch(req: unknown): unknown;
  secretGet(req: { name: string }): unknown;
  log(req: unknown): unknown;
  emit(req: { topic: string }): unknown;
  sessionGet(req: { session: string }): unknown;
  sessionPatch(req: { session: string; patch?: unknown }): unknown;
  jobEnqueue(req: { kind: string }): unknown;
};
