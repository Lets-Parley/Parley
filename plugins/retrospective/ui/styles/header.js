export const HEADER_STYLES = [
  // Progress and authorship are two things, in two boxes.
  ".top{display:flex;flex-wrap:wrap;align-items:stretch;gap:16px 20px}",
  // The strip is a fixed grid: steps and timer above, hint and stage buttons
  // below. Every cell keeps its size whatever it holds, so neither a stage
  // change nor a timer starting moves the board underneath.
  ".progress{flex:1 1 24rem;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:6px 12px;min-width:0;padding:12px 16px;border:1px solid var(--color-line);border-radius:20px;background:var(--color-felt-deep)}",
  "@media (min-width:640px){.progress{grid-template-columns:minmax(0,1fr) 232px}}",
  ".steps-wrap{position:relative;min-width:0}",
  ".steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px}",
  ".thumb{position:absolute;border-radius:999px;background:var(--color-accent-soft);transform-origin:0 0}",
  ".step{position:relative;display:flex;align-items:center;gap:6px;min-height:32px;padding:0 12px 0 8px;border-radius:999px;font-weight:700;color:var(--color-ink-faint)}",
  ".step.reached,.step.current{color:var(--color-ink)}",
  ".stage-nav{flex-wrap:nowrap;justify-content:flex-end;align-self:end}",
  ".stage-next{gap:6px}",
  ".stage-back{gap:0;white-space:pre}",
  ".timer-slot{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:34px}",
  ".timer-face{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px 0 6px;border:1px solid transparent;border-radius:999px;font-size:16px;font-weight:700;white-space:nowrap}",
  ".timer-face .track{stroke:var(--color-line-strong);opacity:.35}",
  ".timer-face .arc{stroke:var(--color-accent)}",
  // The last ten seconds are brass, not red: a nudge, not an alarm. The
  // ring is nearly empty and the digits still count, so the color is not
  // the only sign.
  ".timer-face.ending{border-color:var(--color-brass);background:color-mix(in srgb,var(--color-brass) 16%,transparent)}",
  ".timer-face.ending .arc{stroke:var(--color-brass)}",
  ".timer-text{display:inline-block}",
  ".timer-open{padding:5px 9px}",
  ".step-mark{display:grid;place-items:center;width:16px;font:11px var(--mono);color:var(--color-ink-faint)}",
  ".step svg{color:var(--color-go)}",
  ".hints{display:grid;margin:0 8px}",
  ".hint-more{display:none}",
  ".hint{grid-area:1/1;max-width:65ch;color:var(--color-ink-soft);text-wrap:pretty;visibility:hidden}",
  ".hint.shown{visibility:visible}",
  ".authorship{flex:0 1 27rem;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0;padding:12px 16px 12px 20px}",
  ".auth-text{flex:1 1 11rem;min-width:0}",
  // The confirmation needs more room than the resting control. It takes it
  // sideways, from the progress strip, so the board below does not move.
  ".authorship.armed{flex-basis:36rem}",
  ".auth-title{font-size:15px;font-weight:700;text-wrap:pretty}",
  ".brass-dot{width:10px;height:10px;border-radius:50%;background:var(--color-brass)}",
];

