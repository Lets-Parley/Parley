export function generateGuestHookTypes(abi) {
  const lines = [
    `// Generated from the Parley plugin ABI, protocol ${abi.protocol}.`,
    `export const WIRE_PROTOCOL_VERSION = ${abi.protocol} as const;`,
    "",
  ];
  for (const hook of abi.hooks || []) {
    lines.push(
      `/** Guest export \`${hook.export}\`. */`,
      `export type ${hook.typeName} = (input: ${hook.input}) => ${hook.output};`,
      "",
    );
  }
  lines.push("export interface GuestHooks {");
  for (const hook of abi.hooks || []) {
    lines.push(`  ${hook.export}: ${hook.typeName};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
