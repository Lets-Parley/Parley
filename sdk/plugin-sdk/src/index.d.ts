export function createHost(grants: Grant[], call: HostCall): ParleyHost;
export function generateGuestHookTypes(abi: { protocol: number; hooks?: Array<{ export: string; typeName: string; input: string; output: string }> }): string;
export const WIRE_PROTOCOL_VERSION: 1;

export type Grant = { capability: string; scope?: string };
export type HostCall = (name: string, req: unknown) => unknown;

export type ParleyHost = {
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
