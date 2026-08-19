import { VERSION } from "./version.mjs";

const TOKEN = "%VERSION%";

// Substitutes %VERSION% across the content tree, code fences included. A
// component can't reach inside a fence and MDX braces parse as JSX, so the
// substitution happens here rather than in the pages.
function substitute(node, ctx) {
  if (!node.value.includes(TOKEN)) return;
  ctx.setProperty(node, "value", node.value.replaceAll(TOKEN, VERSION));
}

export function mdastVersion() {
  return {
    name: "parley-version",
    text: substitute,
    code: substitute,
    inlineCode: substitute,
  };
}
