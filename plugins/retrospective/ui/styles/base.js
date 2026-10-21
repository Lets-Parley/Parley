import { DARK, DARK_DEPTH, LIGHT, LIGHT_DEPTH } from "./tokens.js";

export const BASE_STYLES = [
  ":root{" + LIGHT + LIGHT_DEPTH,
  '--sans:"Instrument Sans",-apple-system,"Segoe UI",system-ui,sans-serif;',
  '--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}',
  "@media (prefers-color-scheme:dark){:root{" + DARK + DARK_DEPTH + "}}",
  ':root[data-scheme="light"]{' + LIGHT_DEPTH + "}",
  ':root[data-scheme="dark"]{' + DARK_DEPTH + "}",

  "*,*::before,*::after{box-sizing:border-box}",
  "*{scrollbar-color:var(--color-line-strong) transparent;scrollbar-width:thin}",
  // The frame document sets 14px on the root; the host's rem is 16px.
  "html{background:var(--color-felt);font-size:16px}",
  "body{background:var(--color-felt);color:var(--color-ink);font:16px/24px var(--sans);-webkit-font-smoothing:antialiased}",
  // Prose is the host's 16px. Controls, notes and rows are its 14px, as in the story queue and the kudos wall.
  ".progress,.authorship,.lane,.actions,.select-bar,.toast,.pop{font-size:14px;line-height:20px}",
  "::selection{background:var(--color-accent-soft);color:var(--color-ink)}",
  "::placeholder{color:var(--color-ink-faint);opacity:1}",
  ":focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}",
  "[hidden]{display:none!important}",
  "h2,h3,p,ul,ol{margin:0;padding:0}",
  "ul,ol{list-style:none}",
  "svg{display:block;flex:none}",
  "#root{display:flex;min-height:100%;position:relative}",
  ".sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",

  // Page: the poker room's gutters and gaps, and its main-plus-aside split.
  // On a very wide window the board stops growing: a lane wider than a line
  // of text can be read is no use to anybody.
  ".board{flex:1;display:flex;flex-direction:column;gap:20px;width:100%;max-width:1760px;min-width:0;margin:0 auto;padding:20px}",
  "@media (min-width:640px){.board{gap:24px;padding:28px}}",
  ".panel{background:var(--color-surface);border:1px solid var(--color-line);border-radius:20px;box-shadow:var(--shadow-rest)}",
  ".label{font:10px/15px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--color-ink-faint)}",
  ".mono{font-family:var(--mono);font-variant-numeric:tabular-nums}",
  ".fine{font-size:13px;color:var(--color-ink-soft);text-wrap:pretty}",
  ".row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  "h2{font-size:18px;font-weight:700;line-height:24px;letter-spacing:-.025em;overflow-wrap:anywhere}",

  "button{font:inherit;cursor:pointer}",
  "button:disabled{cursor:default}",
  ".btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;font-size:14px;font-weight:700;line-height:20px;transition:box-shadow .15s,background-color .15s,opacity .15s}",
  '.btn:disabled,.btn[aria-disabled="true"]{opacity:.5;cursor:default}',
  ".btn-primary,.btn-brass{border:0;padding:10px 20px;color:var(--color-accent-ink);box-shadow:var(--shadow-rest)}",
  ".btn-primary{background:var(--color-accent)}",
  ".btn-brass{background:var(--color-brass)}",
  ".btn-primary:hover:not(:disabled),.btn-brass:hover:not(:disabled){box-shadow:var(--shadow-lift)}",
  ".btn-quiet{border:1px solid var(--color-line-strong);padding:8px 16px;background:transparent;color:var(--color-ink-soft)}",
  ".btn-quiet:hover{background:var(--color-felt-deep)}",
  ".btn-small{min-height:32px;padding:5px 12px;font-size:13px}",
  // The red is mixed toward the ink so the words hold 4.5:1 in both themes.
  ".danger{border-color:var(--color-stop);color:color-mix(in srgb,var(--color-stop) 75%,var(--color-ink))}",
  ".field{display:block;width:100%;min-width:0;border:1px solid var(--color-line-strong);border-radius:8px;background:var(--color-surface-hi);color:var(--color-ink);padding:10px 14px;font:inherit;font-size:14px;line-height:20px;caret-color:var(--color-accent)}",
  ".field:focus-visible{outline-offset:1px;border-color:var(--color-accent)}",
  ".field:read-only{color:var(--color-ink-soft)}",
  "textarea.field{height:42px;max-height:122px;padding:10px 12px;resize:none;overflow-y:auto}",
];

