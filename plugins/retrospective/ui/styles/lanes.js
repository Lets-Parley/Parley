export const LANE_STYLES = [
  ".main{flex:1;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}",
  ".lanes{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}",
  "@media (min-width:860px){.lanes{grid-template-columns:repeat(3,minmax(0,1fr))}}",
  ".lane{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px}",
  ".lane-head{display:flex;align-items:flex-start;gap:10px}",
  ".lane-title{flex:1;min-width:0}",
  ".prompt{font-size:13px;line-height:18px;color:var(--color-ink-soft);text-wrap:pretty}",
  ".lane-glyph{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:var(--hue);background:color-mix(in srgb,var(--hue) 14%,transparent)}",
  // The lens says what it is in words wherever its lane has room for them.
  ".lane{container-type:inline-size}",
  ".sort{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 6px;border:1px solid var(--color-line-strong);border-radius:999px;background:transparent;color:var(--color-ink-soft);font-size:12px;font-weight:700;line-height:16px;white-space:nowrap;transition:background-color .15s,border-color .15s}",
  // Below a lane width where the title would wrap beside the words, the
  // lens is its icon alone; its name is still read, and shown on hover.
  "@container (max-width:319px){.sort{padding:0 6px}.sort-word{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}}",
  ".sort:hover{background:var(--color-felt-deep)}",
  '.sort[aria-pressed="true"]{border-color:var(--color-accent);background:var(--color-accent-soft);color:var(--color-ink)}',
  ".sort-line .fine{flex:1 1 100%}",
  // Above the stickers: one that hangs over a note's edge must not sit on
  // top of the composer or the sort controls.
  ".composer,.sort-line{position:relative;z-index:2}",
  ".count{display:inline-block;font:12px/24px var(--mono);font-variant-numeric:tabular-nums;color:var(--color-ink-faint)}",
  ".composer-row{display:flex;align-items:flex-end;gap:8px}",
  ".composer-row .btn{padding:11px 18px}",
  ".reopen{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 12px;border:1px dashed var(--color-line-strong);border-radius:8px;background:transparent;color:var(--color-ink-soft);font-weight:700;transition:background-color .15s}",
  ".reopen:hover{background:var(--color-felt-deep)}",
  ".left{margin-top:6px;font-size:13px;color:var(--color-ink-faint)}",
  ".empty{font-size:13px;color:var(--color-ink-faint);text-wrap:pretty}",
];

