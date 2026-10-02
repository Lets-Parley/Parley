(function () {
  "use strict";

  // The board is built once and then patched. A state push from the host
  // updates the notes, groups and action items it names, by id, and leaves
  // everything else alone: a teammate's vote must never cost somebody the
  // sentence they were typing.

  const parley = window.parley;
  const root = document.getElementById("root");

  // ---------------------------------------------------------------- content

  const CIRCLE = "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5z";
  const GLYPH = {
    check: "M3.5 8.4l3 3 6-6.4",
    plus: "M8 3.5v9M3.5 8h9",
    wentWell: CIRCLE + "M5.4 8.2l1.8 1.8 3.5-3.7",
    toImprove: "M2.5 11.5l3.5-3.5 2.5 2.5 5-5M9.5 5.5h4v4",
    puzzles: CIRCLE + "M6.4 6.3a1.7 1.7 0 1 1 2.5 1.5c-.6.3-.9.7-.9 1.3M8 11.4v.1",
    other: CIRCLE + "M8 8v.1",
    arrow: "M3.5 8h9M9 4.5L12.5 8 9 11.5",
    grip: "M6 4v.1M10 4v.1M6 8v.1M10 8v.1M6 12v.1M10 12v.1",
    dots: "M3.5 8v.1M8 8v.1M12.5 8v.1",
    bars: "M3 4h10M3 8h7M3 12h4",
    target: CIRCLE + "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z",
    clock: CIRCLE + "M8 4.5V8l2.4 1.6",
  };

  // A stamp is told apart by its glyph and its name; the hue only agrees.
  // `press` is where the glyph starts from as it settles after being pressed.
  const STAMPS = {
    "me-too": { label: "Me too", hue: "settled", press: "translateX(-5px) rotate(-8deg)", glyph: "M6 3.25a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 0 0 0-7.5zM10 5.25a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 0 0 0-7.5z" },
    thanks: { label: "Thank you", hue: "brass", press: "scale(1.45)", glyph: "M8 13.5S2.5 10.2 2.5 6.3A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.5 1.3C13.5 10.2 8 13.5 8 13.5z" },
    idea: { label: "Great idea", hue: "accent", press: "rotate(-80deg) scale(1.2)", glyph: "M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" },
    "quick-win": { label: "Quick win", hue: "go", press: "translate(-5px,3px) rotate(-14deg)", glyph: "M9 1.8L3.5 9h4l-.5 5.2L12.5 7h-4z" },
    chat: { label: "Needs a chat", hue: "accent", press: "rotate(-14deg) translateY(2px)", glyph: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" },
    blocker: { label: "Blocker", hue: "stop", press: "rotate(18deg)", glyph: "M4 14V2.5M4 3h8l-1.8 2.8L12 8.6H4" },
    laugh: { label: "Made me laugh", hue: "brass", press: "scaleX(1.2) scaleY(.7)", glyph: CIRCLE + "M5.2 9.2a3 3 0 0 0 5.6 0M6 6.4v.1M10 6.4v.1" },
  };
  const STAMP_SIZE = 32;
  const STAMP_STEP = 6;
  const ONLY_PRESSER = "Only the person who pressed a stamp, or the facilitator, can move or remove it.";

  // A lane is told apart by its glyph and its title; the hue only agrees.
  const LANES = {
    "went-well": { hue: "go", glyph: GLYPH.wentWell, prompt: "What made the sprint better?", empty: "No wins written down yet." },
    "to-improve": { hue: "brass", glyph: GLYPH.toImprove, prompt: "What slowed us down?", empty: "Nothing flagged yet." },
    puzzles: { hue: "settled", glyph: GLYPH.puzzles, prompt: "What are we still unsure about?", empty: "No open questions yet." },
  };
  const OTHER_LANE = { hue: "accent", glyph: GLYPH.other, prompt: "What belongs here?", empty: "No notes yet." };

  // The stage is the facilitator's to set. It changes what the board puts in
  // front of people and refuses nothing: a late note or vote is still taken.
  const STEPS = ["Write", "Group", "Vote", "Decide"];
  const HINTS = [
    "Write what went well, what to improve and what puzzles you. A note's menu holds the rest: stamps, moving, actions.",
    "Select notes that belong together and group them. Drag the important ones to the top.",
    "Vote for the notes that matter most. One vote per person per note.",
    "Agree on what to change and who owns it. Start an action from any note.",
  ];
  const TIMES_UP = "Time is up. Wrap up when you are ready.";
  const PRESETS = [1, 3, 5, 10];
  const MINUTE = 60000;

  // What the host's answer to a refused action means, in words. The host sends
  // a code from this list and nothing else.
  const REFUSALS = {
    forbidden: "You are not allowed to do that in this room.",
    invalid: "The server did not accept that as written.",
    "not-found": "This board is no longer available. Reload the page.",
    conflict: "This room has ended, so the board can no longer change.",
    "rate-limited": "Too many changes at once. Wait a moment, then try again.",
    ungranted: "This plugin is not allowed to change the room. An org admin can check its grants.",
    unreachable: "Could not reach the server. Check your connection, then try again.",
    failed: "The server could not do that. Try again.",
  };

  const NOTE_LIMIT = 500;
  const TITLE_LIMIT = 80;
  const OWNER_LIMIT = 64;
  const FORMER = "Former participant";
  // A host that reports results answers at once. An older one answers nothing,
  // so an action that has not shown up in the state after this long is called
  // unconfirmed. A change normally lands in a fifth of a second; three seconds
  // is long enough that a slow connection rarely trips it and short enough
  // that nobody is left wondering. A late arrival takes the message back.
  const WAIT_MS = 3000;
  const LATE_MS = 60000;
  const TOAST_MS = 6000;

  // ----------------------------------------------------------------- styles

  // Only colors cross the bridge, as --color-<token> on the root element. The
  // palettes below are what the board wears until they arrive. Radii, shadows,
  // type and spacing are the host's values written out as literals.
  const LIGHT = [
    "--color-felt:#E9E7E1;--color-felt-deep:#DBD8D0;--color-surface:#F7F6F2;--color-surface-hi:#FFFFFF;",
    "--color-ink:#12202F;--color-ink-soft:#46596B;--color-ink-faint:#4F5D6A;--color-line:#C7C4BA;",
    "--color-line-strong:#77746D;--color-accent:#1D4E6E;--color-accent-ink:#F4F8FB;--color-accent-soft:#D6E4EE;",
    "--color-brass:#725411;--color-settled:#5B3A63;--color-go:#266454;--color-stop:#B33326;",
  ].join("");
  const DARK = [
    "--color-felt:#0E1726;--color-felt-deep:#0A101B;--color-surface:#162032;--color-surface-hi:#1E2B3F;",
    "--color-ink:#E9E7E1;--color-ink-soft:#A3B1C0;--color-ink-faint:#8494A4;--color-line:#2A3648;",
    "--color-line-strong:#6D7A8A;--color-accent:#5FA8D3;--color-accent-ink:#08131F;--color-accent-soft:#1C3247;",
    "--color-brass:#D9AE54;--color-settled:#C89BD1;--color-go:#5FBFA6;--color-stop:#E3695C;",
  ].join("");
  const LIGHT_DEPTH = [
    "color-scheme:light;",
    "--shadow-rest:0 1px 2px rgb(18 32 47/.1),0 2px 8px rgb(18 32 47/.08);",
    "--shadow-lift:0 2px 4px rgb(18 32 47/.12),0 10px 24px rgb(18 32 47/.16);",
    "--shadow-well:inset 0 2px 6px rgb(18 32 47/.12);",
  ].join("");
  const DARK_DEPTH = [
    "color-scheme:dark;",
    "--shadow-rest:0 1px 2px rgb(0 0 0/.4),0 2px 8px rgb(0 0 0/.3);",
    "--shadow-lift:0 2px 4px rgb(0 0 0/.45),0 12px 28px rgb(0 0 0/.4);",
    "--shadow-well:inset 0 2px 6px rgb(0 0 0/.45);",
  ].join("");

  const STYLES = [
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
    ".board{flex:1;display:flex;flex-direction:column;gap:20px;width:100%;min-width:0;padding:20px}",
    "@media (min-width:640px){.board{gap:24px;padding:28px}}",
    ".panel{background:var(--color-surface);border:1px solid var(--color-line);border-radius:20px;box-shadow:var(--shadow-rest)}",
    ".label{font:10px/15px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--color-ink-faint)}",
    ".mono{font-family:var(--mono);font-variant-numeric:tabular-nums}",
    ".fine{font-size:13px;color:var(--color-ink-soft);text-wrap:pretty}",
    ".row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    "h2{font-size:18px;font-weight:700;line-height:24px;letter-spacing:-.025em;overflow-wrap:anywhere}",

    "button{font:inherit;cursor:pointer}",
    "button:disabled{cursor:default}",
    ".btn{flex:none;border-radius:999px;font-size:14px;font-weight:700;line-height:20px;transition:box-shadow .15s,background-color .15s,opacity .15s}",
    ".btn:disabled{opacity:.5}",
    ".btn-primary,.btn-brass{border:0;padding:10px 20px;color:var(--color-accent-ink);box-shadow:var(--shadow-rest)}",
    ".btn-primary{background:var(--color-accent)}",
    ".btn-brass{background:var(--color-brass)}",
    ".btn-primary:hover:not(:disabled),.btn-brass:hover:not(:disabled){box-shadow:var(--shadow-lift)}",
    ".btn-quiet{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--color-line-strong);padding:8px 16px;background:transparent;color:var(--color-ink-soft)}",
    ".btn-quiet:hover{background:var(--color-felt-deep)}",
    ".btn-small{padding:5px 12px;font-size:13px}",
    ".field{display:block;width:100%;min-width:0;border:1px solid var(--color-line-strong);border-radius:8px;background:var(--color-surface-hi);color:var(--color-ink);padding:10px 14px;font:inherit;font-size:14px;line-height:20px;caret-color:var(--color-accent)}",
    ".field:focus-visible{outline-offset:1px;border-color:var(--color-accent)}",
    ".field:read-only{color:var(--color-ink-soft)}",
    "textarea.field{height:42px;max-height:122px;padding:10px 12px;resize:none;overflow-y:auto}",

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
    ".stage-next{display:inline-flex;align-items:center;gap:6px}",
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
    ".hint{grid-area:1/1;max-width:65ch;color:var(--color-ink-soft);text-wrap:pretty;visibility:hidden}",
    ".hint.shown{visibility:visible}",
    ".authorship{flex:0 1 27rem;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0;padding:12px 16px 12px 20px}",
    ".auth-text{flex:1 1 11rem;min-width:0}",
    // The confirmation needs more room than the resting control. It takes it
    // sideways, from the progress strip, so the board below does not move.
    ".authorship.armed{flex-basis:36rem}",
    ".auth-title{font-size:15px;font-weight:700;text-wrap:pretty}",
    ".brass-dot{width:10px;height:10px;border-radius:50%;background:var(--color-brass)}",

    ".main{flex:1;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}",
    ".lanes{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}",
    "@media (min-width:860px){.lanes{grid-template-columns:repeat(3,minmax(0,1fr))}}",
    ".lane{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px}",
    ".lane-head{display:flex;align-items:flex-start;gap:10px}",
    ".lane-title{flex:1;min-width:0}",
    ".prompt{font-size:13px;line-height:18px;color:var(--color-ink-soft);text-wrap:pretty}",
    ".lane-glyph{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:var(--hue);background:color-mix(in srgb,var(--hue) 14%,transparent)}",
    ".sort{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid var(--color-line-strong);border-radius:8px;background:transparent;color:var(--color-ink-soft);transition:background-color .15s,border-color .15s}",
    ".sort:hover{background:var(--color-felt-deep)}",
    '.sort[aria-pressed="true"]{border-color:var(--color-accent);background:var(--color-accent-soft);color:var(--color-ink)}',
    ".sort-line .fine{flex:1 1 100%}",
    // Above the stamps: one that hangs over a note's edge must not sit on
    // top of the composer or the sort controls.
    ".composer,.sort-line{position:relative;z-index:2}",
    ".count{display:inline-block;font:12px/24px var(--mono);font-variant-numeric:tabular-nums;color:var(--color-ink-faint)}",
    ".composer-row{display:flex;align-items:flex-end;gap:8px}",
    ".composer-row .btn{padding:11px 18px}",
    ".reopen{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 12px;border:1px dashed var(--color-line-strong);border-radius:8px;background:transparent;color:var(--color-ink-soft);font-weight:700;transition:background-color .15s}",
    ".reopen:hover{background:var(--color-felt-deep)}",
    ".left{margin-top:6px;font-size:13px;color:var(--color-ink-faint)}",
    ".empty{font-size:13px;color:var(--color-ink-faint);text-wrap:pretty}",

    ".notes{display:flex;flex-direction:column;gap:8px}",
    ".note{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:start;column-gap:6px;padding:5px 8px 5px 4px;background:var(--color-surface-hi);border:1px solid var(--color-line);border-radius:14px;box-shadow:var(--shadow-rest);transition:background-color .15s,border-color .15s}",
    ".note.selected{background:var(--color-accent-soft);border-color:var(--color-accent);box-shadow:0 0 0 1px var(--color-accent),var(--shadow-rest)}",
    // A note's controls are drawn over its stamps, and over a neighbor's:
    // a stamp may cover text, which shows through it, but never a control.
    ".lead,.trail{position:relative;z-index:2;display:flex;align-items:center}",
    // After the text: the control the stage promotes, on top, and under it
    // what the note has already gathered, kept small.
    ".trail{flex-direction:column;align-items:flex-end;gap:2px}",
    ".more,.stage-2 .vote,.stage-3 .target{order:-1}",
    ".pick,.grip,.more,.target{display:grid;place-items:center;width:28px;height:32px}",
    ".pick{cursor:pointer}",
    ".grip,.more,.target{padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-ink-faint);transition:background-color .15s,color .15s}",
    ".grip:hover,.more:hover,.target:hover{background:var(--color-felt-deep);color:var(--color-ink)}",
    ".grip{cursor:grab;touch-action:none}",
    ".target{color:var(--color-ink-soft)}",
    ".target.linked{display:inline-flex;align-items:center;gap:4px;width:auto;padding:0 6px;color:var(--color-brass);font-size:13px;font-weight:700}",
    ".lit{outline:2px solid var(--color-accent);outline-offset:1px}",
    ".note.spot,.group.spot{box-shadow:0 0 0 2px var(--color-accent),var(--shadow-rest)}",
    // A note being dragged: the copy under the pointer, and the slot it left.
    ".note.drag{position:fixed;z-index:4;margin:0;pointer-events:none;box-shadow:var(--shadow-lift)}",
    ".note.slot{border:1.5px dashed var(--color-accent);background:transparent;box-shadow:none}",
    ".note.slot>*{visibility:hidden}",
    ".dragging,.dragging *{user-select:none;cursor:grabbing!important}",
    ".pick input{appearance:none;display:grid;place-items:center;width:14px;height:14px;margin:0;border:1px solid var(--color-line-strong);border-radius:4px;background:transparent;cursor:pointer;transition:background-color .15s,border-color .15s}",
    ".pick input:checked{border-color:var(--color-accent);background:var(--color-accent)}",
    '.pick input:checked::after{content:"";width:4px;height:7px;margin-top:-2px;border:solid var(--color-accent-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}',
    ".note-text{padding:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".person{grid-column:2/-1;display:flex;align-items:center;gap:8px;min-width:0;padding-bottom:5px;font-size:13px;color:var(--color-ink-soft)}",
    ".person-name{min-width:0;overflow-wrap:anywhere}",
    ".disc{flex:none;display:grid;place-items:center;width:24px;height:24px;margin:3px;border-radius:50%;font-size:9px;font-weight:700;color:#F4F8FB;background:#3F5466;box-shadow:0 0 0 2px var(--color-surface-hi),0 0 0 3px var(--color-line)}",
    ".vote{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--color-line-strong);border-radius:999px;background:var(--color-surface-hi);color:var(--color-ink-soft);font-size:13px;font-weight:700;transition:background-color .15s,border-color .15s}",
    ".vote:hover{background:var(--color-felt-deep)}",
    ".board:not(.stage-2) .vote,.board:not(.stage-3) .target{min-height:24px;height:24px;padding:0 8px;border-color:var(--color-line);font-size:12px}",
    ".vote-dot{width:8px;height:8px;border:1.5px solid currentColor;border-radius:50%}",
    ".vote.has-votes{color:var(--color-ink)}",
    ".vote.has-votes .vote-dot{background:currentColor}",
    ".vote .mono{display:inline-block}",
    '.vote[aria-pressed="true"]{border-color:var(--color-accent);background:var(--color-accent-soft)}',
    '.vote[aria-pressed="true"] .vote-dot{border-color:var(--color-accent);background:var(--color-accent)}',
    // A note on its way to the server: same place, drawn as not yet real.
    ".ghost{border-style:dashed;background:transparent;box-shadow:none}",
    ".ghost .note-text{grid-column:2/-1;color:var(--color-ink-soft)}",
    ".ghost-foot{grid-column:2/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-bottom:5px;font-size:13px;color:var(--color-ink-faint)}",
    ".group{padding:8px;border-radius:14px;background:var(--color-felt-deep);box-shadow:var(--shadow-well)}",
    ".group-head{position:relative;z-index:2;display:flex;align-items:flex-start;gap:6px;margin:0 0 6px}",
    ".group-title{flex:1;min-width:0;padding-top:4px}",

    // A stamp is an ink impression: a ring and a glyph in one hue, with
    // almost no fill, so the words under it stay readable. It is placed by
    // its center, as a fraction of the note, and may hang over the edge.
    ".stamps{position:absolute;inset:0;z-index:1;pointer-events:none}",
    ".stamp,.stamp-face{display:grid;place-items:center;width:32px;height:32px;padding:0;border:2px solid var(--hue);border-radius:50%;outline:1px solid var(--hue);outline-offset:-6px;color:var(--hue);background:color-mix(in srgb,var(--hue) 10%,transparent)}",
    ".stamp{position:absolute;margin:-16px 0 0 -16px;rotate:var(--rot);opacity:.9;pointer-events:auto;cursor:grab;touch-action:none;transition:opacity .15s}",
    ".stamp:hover,.stamp:focus-visible,.stamp.lift{opacity:1;background:color-mix(in srgb,var(--hue) 10%,var(--color-surface-hi))}",
    ".stamp:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}",
    ".stamp.lift{scale:1.15;box-shadow:var(--shadow-lift);cursor:grabbing}",
    ".stamp.fixed{cursor:default}",
    "h3{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:14px;font-weight:700;line-height:20px;overflow-wrap:anywhere}",
    ".group-meta{font:11px/16px var(--mono);color:var(--color-ink-faint)}",

    ".actions{min-width:0;padding:16px 20px 20px}",
    ".actions-head{display:flex;align-items:baseline;gap:10px}",
    ".actions-head h2{flex:1}",
    ".action-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}",
    ".action{padding:8px 12px;border:1px solid var(--color-line);border-radius:14px}",
    ".action-text{font-weight:700;overflow-wrap:anywhere}",
    ".actions.deciding{box-shadow:0 0 0 1px var(--color-accent),var(--shadow-rest)}",
    ".sources{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}",
    ".sources li{min-width:0;max-width:100%}",
    ".src{display:flex;align-items:center;gap:6px;max-width:100%;min-height:24px;padding:0 8px 0 6px;border:1px solid var(--color-line);border-radius:999px;background:transparent;color:var(--color-ink-soft);font-size:12px;line-height:16px;transition:background-color .15s}",
    ".src:hover{background:var(--color-felt-deep)}",
    ".src svg{width:12px;height:12px;color:var(--hue)}",
    ".src span{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".action .person{padding:4px 0 0}",
    ".actions .empty{margin-top:8px}",
    ".action-foot{margin-top:16px;padding-top:16px;border-top:1px solid var(--color-line)}",
    ".action-form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}",
    ".stack{display:flex;flex-direction:column;gap:4px;flex:1 1 12rem;min-width:0}",
    ".stack.narrow{flex:0 1 11rem}",
    // Wide enough for the poker room's split: the lanes, and the actions beside them.
    "@media (min-width:1200px){.main{grid-template-columns:minmax(0,1fr) 300px}.actions{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow-y:auto}.action-form{flex-flow:column nowrap;align-items:stretch}.stack,.stack.narrow{flex:none}.action-form .btn{align-self:flex-start}}",

    ".dock{position:fixed;z-index:2;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 12px 12px;pointer-events:none}",
    ".toast,.select-bar{pointer-events:auto}",
    ".select-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;width:100%;max-width:44rem;padding:12px 16px;background:var(--color-surface);border:1px solid var(--color-line);border-radius:20px;box-shadow:var(--shadow-lift)}",
    ".select-info{flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;min-width:0}",
    "@media (min-width:640px){.select-info{flex:1 1 12rem}}",
    ".select-count{font-weight:700}",
    ".select-name{flex:1 1 6rem;min-width:0}",
    ".toast{max-width:34rem;padding:12px 24px;border:1px solid var(--color-line);border-radius:22px;background:var(--color-surface-hi);box-shadow:var(--shadow-lift);font-weight:700;text-align:center;text-wrap:pretty}",

    // Menus and sheets float in one layer that scrolls with the page.
    ".layer{position:absolute;top:0;left:0;z-index:3}",
    ".pop{position:absolute;width:max-content;max-width:calc(100vw - 16px);border:1px solid var(--color-line);border-radius:14px;background:var(--color-surface-hi);box-shadow:var(--shadow-lift);transform-origin:0 0}",
    ".menu{display:flex;flex-direction:column;min-width:13rem;padding:6px}",
    ".menu-item{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--color-ink);text-align:left}",
    ".menu-item:hover,.menu-item:focus-visible{background:var(--color-felt-deep)}",
    ".menu-item:focus-visible{outline-offset:-2px}",
    '.menu-item[aria-disabled="true"]{color:var(--color-ink-faint)}',
    ".keys{font:11px/16px var(--mono);color:var(--color-ink-faint)}",
    ".sheet{display:flex;flex-direction:column;gap:10px;width:20rem;padding:14px}",
    ".sheet .row .field{flex:1 1 4rem;padding:5px 10px}",
    ".stamp-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}",
    ".stamp-choice{display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 2px;border:0;border-radius:10px;background:transparent;color:var(--color-ink-soft);font-size:12px;line-height:16px;text-wrap:balance}",
    ".stamp-choice:hover{background:var(--color-felt-deep);color:var(--color-ink)}",
    ".from{padding:6px 10px;border-radius:8px;background:var(--color-felt-deep);color:var(--color-ink-soft);font-size:13px;overflow-wrap:anywhere}",
    ".link-list{display:flex;flex-direction:column;gap:6px;max-height:10rem;overflow-y:auto}",
    ".link-list li{display:flex;align-items:center;gap:8px}",
    ".link-list span{flex:1;min-width:0;overflow-wrap:anywhere}",

    "@media (pointer:coarse){.btn,.menu-item,.stage-2 .vote{min-height:44px}.pick,.grip,.more,.stage-3 .target{width:36px;height:44px}.board:not(.stage-2) .vote,.board:not(.stage-3) .target{min-height:32px;height:32px}.sort{width:36px;height:36px}.note{grid-template-columns:36px minmax(0,1fr) auto}.note-text{padding:12px 0}}",

    // The host's own keyframes for a note being set down: a short fall under
    // gravity, then a slide that friction brings to a dead stop.
    "@keyframes note-set-down{",
    "0%{transform:translate(-14px,-10px) rotate(-3.2deg) scale(1.035);box-shadow:var(--shadow-lift);opacity:0}",
    "6.3%{transform:translate(-12.72px,-9.72px) rotate(-2.91deg) scale(1.034);opacity:1}",
    "12.6%{transform:translate(-11.43px,-8.89px) rotate(-2.61deg) scale(1.0311)}",
    "19%{transform:translate(-10.15px,-7.5px) rotate(-2.32deg) scale(1.0263)}",
    "25.3%{transform:translate(-8.87px,-5.56px) rotate(-2.03deg) scale(1.0194)}",
    "31.6%{transform:translate(-7.58px,-3.06px) rotate(-1.73deg) scale(1.0107)}",
    "37.9%{transform:translate(-6.3px,0) rotate(-1.44deg) scale(1);box-shadow:var(--shadow-rest)}",
    "45.7%{transform:translate(-4.82px,0) rotate(-1.1deg)}",
    "53.4%{transform:translate(-3.54px,0) rotate(-.81deg)}",
    "61.2%{transform:translate(-2.46px,0) rotate(-.56deg)}",
    "69%{transform:translate(-1.57px,0) rotate(-.36deg)}",
    "76.7%{transform:translate(-.89px,0) rotate(-.2deg)}",
    "84.5%{transform:translate(-.39px,0) rotate(-.09deg)}",
    "92.2%{transform:translate(-.1px,0) rotate(-.02deg)}",
    "100%{transform:translate(0,0) rotate(0)}}",
    ".arriving{animation:note-set-down 790ms linear both}",
    "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}",
  ].join("\n");

  // ui.fonts.js is put in front of this file by the build. Run on its own, as
  // the tests do, the board falls back to the system faces.
  function fontFaces() {
    if (typeof RETRO_FONTS === "undefined") return "";
    return RETRO_FONTS.map(function (font) {
      return (
        '@font-face{font-family:"' + font.family + '";font-weight:' + font.weight +
        ";font-style:normal;font-display:swap;src:url(data:font/woff2;base64," + font.data + ') format("woff2")}\n'
      );
    }).join("");
  }

  // ------------------------------------------------------------ DOM helpers

  function el(tag, props, kids) {
    const node = document.createElement(tag);
    for (const key in props || {}) {
      if (key === "class") node.className = props[key];
      else if (key === "text") node.textContent = props[key];
      else node.setAttribute(key, props[key]);
    }
    (kids || []).forEach(function (kid) {
      node.appendChild(kid);
    });
    return node;
  }

  function icon(d) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const path = document.createElementNS(NS, "path");
    const attrs = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" };
    for (const key in attrs) svg.setAttribute(key, attrs[key]);
    const stroke = { d: d, stroke: "currentColor", "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round" };
    for (const key in stroke) path.setAttribute(key, stroke[key]);
    svg.appendChild(path);
    return svg;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // Make `parent` hold exactly `wanted`, in order, touching only the nodes
  // that are out of place.
  function sync(parent, wanted) {
    wanted.forEach(function (node, i) {
      if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
    });
    while (parent.children.length > wanted.length) parent.removeChild(parent.lastChild);
  }

  function contains(parent, node) {
    for (let n = node; n; n = n.parentNode) if (n === parent) return true;
    return false;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function short(text) {
    return text.length > 80 ? text.slice(0, 77) + "..." : text;
  }

  function idsOf(rows) {
    const ids = {};
    rows.forEach(function (row) {
      ids[row.id] = true;
    });
    return ids;
  }

  // ------------------------------------------------------------------ state

  // The state is somebody else's JSON. Everything the board reads goes through
  // here first, so a missing list or a note with no text is drawn as far as it
  // makes sense instead of stopping the whole board.
  function rows(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (row) {
      return row && typeof row === "object" && (typeof row.id === "string" || typeof row.userId === "string");
    });
  }

  function words(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function unit(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function boardOf(next) {
    const b = next && typeof next.state === "object" && next.state ? next.state : {};
    const stage = Math.floor(Number(b.stage));
    const t = b.timer && typeof b.timer === "object" ? b.timer : null;
    return {
      revealed: b.revealed === true,
      stage: stage >= 0 && stage < STEPS.length ? stage : 0,
      timer: t && {
        rev: Number(t.rev) || 0,
        running: t.mode === "running",
        duration: Math.max(1, Number(t.durationMs) || 1),
        remaining: Math.max(0, Number(t.remainingMs) || 0),
      },
      stamps: rows(b.stamps)
        .filter(function (s) {
          return STAMPS[s.kind] && typeof s.cardId === "string";
        })
        .map(function (s) {
          return { id: s.id, cardId: s.cardId, kind: s.kind, x: unit(s.x), y: unit(s.y), rot: Math.max(-12, Math.min(12, Number(s.rot) || 0)) };
        }),
      columns: rows(b.columns).map(function (c) {
        return { id: c.id, title: words(c.title) || c.id };
      }),
      cards: rows(b.cards).map(function (c) {
        return {
          id: c.id,
          columnId: words(c.columnId),
          groupId: typeof c.groupId === "string" ? c.groupId : null,
          text: words(c.text),
          votes: Math.max(0, Math.floor(Number(c.voteCount)) || 0),
          authorId: typeof c.authorId === "string" ? c.authorId : null,
        };
      }),
      groups: rows(b.groups).map(function (g) {
        return { id: g.id, columnId: words(g.columnId), title: words(g.title) };
      }),
      actionItems: rows(b.actionItems).map(function (a) {
        const sources = Array.isArray(a.sourceIds) ? a.sourceIds : [];
        return {
          id: a.id,
          text: words(a.text),
          owner: words(a.owner),
          sourceIds: sources.filter(function (id) {
            return typeof id === "string";
          }),
        };
      }),
    };
  }

  const view = { lanes: {}, notes: {}, groups: {}, actions: {}, stamps: {} };
  let session = null;
  let board = boardOf(null);
  let drawn = false;
  let selected = {};

  function cardById(id) {
    return board.cards.filter(function (c) {
      return c.id === id;
    })[0];
  }

  function groupById(id) {
    return board.groups.filter(function (g) {
      return g.id === id;
    })[0];
  }

  function membersOf(groupId) {
    return board.cards.filter(function (c) {
      return c.groupId === groupId;
    });
  }

  // A lane is read top to bottom as items: a loose note, or a group standing
  // where its first note is. The order is the order of the notes in the state,
  // which is the one order everybody shares.
  function itemsOf(columnId) {
    const items = [];
    const seen = {};
    board.cards.forEach(function (c) {
      if (c.columnId !== columnId) return;
      const g = c.groupId && groupById(c.groupId);
      if (!g || g.columnId !== columnId) items.push({ id: c.id, cards: [c], votes: c.votes });
      else if (seen[g.id]) {
        seen[g.id].cards.push(c);
        seen[g.id].votes += c.votes;
      } else items.push((seen[g.id] = { id: g.id, group: g, cards: [c], votes: c.votes }));
    });
    return items;
  }

  function byVotes(a, b) {
    return b.votes - a.votes;
  }

  function actionsFrom(sourceId) {
    return board.actionItems.filter(function (a) {
      return a.sourceIds.indexOf(sourceId) !== -1;
    });
  }

  function columnTitle(columnId) {
    const col = board.columns.filter(function (c) {
      return c.id === columnId;
    })[0];
    return col ? col.title : columnId;
  }

  function selectedIds() {
    return board.cards
      .filter(function (c) {
        return selected[c.id];
      })
      .map(function (c) {
        return c.id;
      });
  }

  // ----------------------------------------------------------------- people

  function personById(userId) {
    const person = rows(session && session.participants).filter(function (p) {
      return p.userId === userId;
    })[0];
    return person && words(person.name).trim() ? person : null;
  }

  // An owner is either a participant's id (the server's default when the field
  // is left blank), a participant's name, or whatever somebody typed.
  function ownerOf(owner) {
    const typed = owner.trim().toLowerCase();
    const person =
      personById(owner) ||
      rows(session && session.participants).filter(function (p) {
        return typed && words(p.name).trim().toLowerCase() === typed;
      })[0];
    if (person) return person;
    const looksLikeId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(owner);
    return { name: looksLikeId || !owner ? FORMER : owner };
  }

  function facilitator() {
    return personById(session && session.facilitatorId);
  }

  // Who is looking. A host older than `selfId` leaves it out, and a newer one
  // may not know: both mean "unknown", never "nobody".
  function viewerRole() {
    const self = session && session.selfId;
    if (typeof self !== "string" || !self) return "unknown";
    return self === session.facilitatorId ? "facilitator" : "participant";
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function buildPerson() {
    const disc = el("span", { class: "disc", "aria-hidden": "true" });
    const name = el("span", { class: "person-name", dir: "auto" });
    return { el: el("span", { class: "person" }, [disc, name]), disc: disc, name: name };
  }

  // The disc is the host's avatar arc, a step darker: at this size the
  // initials are the only thing in it, so they are held to 4.5:1.
  function showPerson(person, who) {
    const name = who ? words(who.name).trim() : FORMER;
    setText(person.name, name);
    setText(person.disc, initials(name));
    if (who && typeof who.avatarHue === "number") {
      const arc = 185 + ((((who.avatarHue % 360) + 360) % 360) / 360) * 105;
      person.disc.style.background = "oklch(0.44 0.09 " + arc + ")";
    }
  }

  // ----------------------------------------------------------------- motion

  // A damped spring on a unit mass, integrated until it comes to rest, as a
  // CSS linear() easing plus the time it took. Nothing is cut short and no two
  // springs share a duration.
  function spring(stiffness, damping) {
    const dt = 1 / 240;
    const points = [];
    let x = 0;
    let v = 0;
    let step = 0;
    let hit = 0;
    while (step < 480 && (Math.abs(1 - x) > 0.001 || Math.abs(v) > 0.01)) {
      v += (stiffness * (1 - x) - damping * v) * dt;
      x += v * dt;
      if (!hit && x >= 1) hit = step;
      if (step % 4 === 0 && points.length < 200) points.push(x.toFixed(3));
      step += 1;
    }
    points.push(1);
    const linear = !!window.CSS && window.CSS.supports("animation-timing-function", "linear(0,1)");
    return {
      duration: Math.round(step * dt * 1000),
      // When it first reaches where it is going: the moment of impact.
      hit: Math.round((hit || step) * dt * 1000),
      easing: linear ? "linear(" + points.join(",") + ")" : "cubic-bezier(0.22,1,0.36,1)",
      fill: "backwards",
    };
  }
  const POP = spring(380, 22);
  const GLIDE = spring(260, 30);
  const TICK = spring(900, 44);
  const SLAP = spring(520, 15);
  const NUDGE = spring(700, 26);
  const FLICK = spring(900, 14);

  // The frame's own clock, used only to count a timer down from the time
  // remaining the server sent. It is never compared with the server's.
  function clockNow() {
    return window.performance ? window.performance.now() : Date.now();
  }

  function rectOf(node) {
    return node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  // Nothing moves on the first paint, and nothing moves for someone who has
  // asked for less motion.
  function motionOn() {
    if (!drawn || typeof root.animate !== "function") return false;
    return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function animate(node, from, timing, delay) {
    node.animate([from, { transform: "none", opacity: 1 }], Object.assign({}, timing, { delay: delay || 0 }));
  }

  function tick(node) {
    if (motionOn()) animate(node, { transform: "translateY(60%)", opacity: 0 }, TICK);
  }

  function arrive(node) {
    node.classList.add("arriving");
    node.addEventListener("animationend", function () {
      node.classList.remove("arriving");
    });
  }

  function measure() {
    const boxes = {};
    for (const id in view.notes) boxes[id] = rectOf(view.notes[id].el);
    return boxes;
  }

  // Notes that changed place glide there from where they were.
  function glideFrom(before) {
    for (const id in before) {
      const note = view.notes[id];
      if (!note || note.el.classList.contains("arriving")) continue;
      const now = rectOf(note.el);
      const dx = before[id].left - now.left;
      const dy = before[id].top - now.top;
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        animate(note.el, { transform: "translate(" + dx + "px," + dy + "px)" }, GLIDE);
      }
    }
  }

  // The reveal is the one beat that is staged: names are uncovered across the
  // board in reading order, each sooner after the last, and then it is over.
  function revealWave() {
    const named = board.cards
      .map(function (c) {
        return view.notes[c.id];
      })
      .filter(function (note) {
        return note && !note.author.el.hidden;
      });
    named.forEach(function (note, i) {
      const delay = 1000 * Math.pow(i / named.length, 0.7);
      note.author.el.animate(
        [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
        { duration: 320, delay: delay, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "backwards" },
      );
      animate(note.author.disc, { transform: "scale(.6)" }, POP, delay);
    });
  }

  // Hiding them again is the same wave run backwards and quicker: it is a
  // return to the usual state, not an occasion.
  function concealWave(named) {
    named.forEach(function (note, i) {
      note.author.el.hidden = false;
      const cover = note.author.el.animate(
        [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 100% 0 0)" }],
        { duration: 220, delay: 600 * Math.pow(i / named.length, 0.7), easing: "cubic-bezier(0.22,1,0.36,1)", fill: "forwards" },
      );
      cover.onfinish = function () {
        const boxes = measure();
        note.author.el.hidden = true;
        cover.cancel();
        glideFrom(boxes);
      };
    });
  }

  // ---------------------------------------------------------------- notices

  const live = el("div", { class: "live sr-only", role: "status" });
  const toast = el("div", { class: "toast" });
  toast.hidden = true;
  let toastTimer = 0;

  function hideToast() {
    clearTimeout(toastTimer);
    toast.hidden = true;
    setText(toast, "");
  }

  function notify(message) {
    hideToast();
    setText(toast, message);
    toast.hidden = false;
    if (motionOn()) animate(toast, { transform: "translateY(12px)", opacity: 0 }, POP);
    toastTimer = setTimeout(hideToast, TOAST_MS);
    return message;
  }

  // Take a message back, if it is still the one on screen.
  function retract(message) {
    if (message && toast.textContent === message) hideToast();
  }

  // --------------------------------------------------------------- popovers

  // One floating thing at a time: a menu, the stamp sheet, the action form or
  // the timer controls. It hangs from the control that opened it, closes on
  // Escape or a press elsewhere, and hands focus back to that control.
  const layer = el("div", { class: "layer" });
  let pop = null;

  function openPop(anchor, node, patch) {
    closePop(false);
    pop = { anchor: anchor, el: node, patch: patch };
    anchor.setAttribute("aria-expanded", "true");
    layer.appendChild(node);
    placePop();
    if (motionOn()) animate(node, { transform: "translateY(-6px) scale(.97)", opacity: 0 }, POP);
  }

  // Under its control, or above it when there is no room below; never off
  // either side. The layer scrolls with the page, so it stays put.
  function placePop() {
    if (!pop) return;
    const a = rectOf(pop.anchor);
    const width = pop.el.offsetWidth || 0;
    const height = pop.el.offsetHeight || 0;
    const below = a.bottom + 6 + height <= (window.innerHeight || 0) || a.top - 6 - height < 0;
    const left = Math.max(8, Math.min(a.left, (window.innerWidth || 0) - width - 8));
    pop.el.style.left = left + (window.scrollX || 0) + "px";
    pop.el.style.top = (below ? a.bottom + 6 : a.top - 6 - height) + (window.scrollY || 0) + "px";
  }

  function closePop(refocus) {
    if (!pop) return;
    const was = pop;
    pop = null;
    was.anchor.setAttribute("aria-expanded", "false");
    layer.removeChild(was.el);
    if (refocus) was.anchor.focus();
  }

  // The control that opens a popover also closes it.
  function toggles(anchor, open) {
    anchor.setAttribute("aria-expanded", "false");
    anchor.addEventListener("click", function () {
      if (pop && pop.anchor === anchor) closePop(true);
      else open();
    });
  }

  // A menu is a list of { label, keys, run }. `off` holds the reason an item
  // cannot be used just now, which is said when it is chosen; `stay` keeps
  // the menu open, for an item that is pressed several times running.
  function openMenu(anchor, label, items) {
    const menu = el("div", { class: "pop menu", role: "menu", "aria-label": label });
    const buttons = items.map(function (item) {
      const row = el("button", { type: "button", class: "menu-item", role: "menuitem", tabindex: -1 }, [el("span", { text: item.label })]);
      if (item.keys) row.appendChild(el("span", { class: "keys", "aria-hidden": "true", text: item.keys }));
      if (item.off) row.setAttribute("aria-disabled", "true");
      row.addEventListener("click", function () {
        if (item.off) {
          notify(item.off);
          return;
        }
        if (!item.stay) closePop(true);
        item.run();
      });
      menu.appendChild(row);
      return row;
    });
    menu.addEventListener("keydown", function (ev) {
      const at = buttons.indexOf(document.activeElement);
      const n = buttons.length;
      let to = -1;
      if (ev.key === "ArrowDown") to = (at + 1) % n;
      else if (ev.key === "ArrowUp") to = (at - 1 + n) % n;
      else if (ev.key === "Home") to = 0;
      else if (ev.key === "End") to = n - 1;
      else if (ev.key === "Tab") closePop(true);
      else if (ev.key.length === 1) {
        // Type a letter to reach the next item that starts with it.
        for (let i = 1; i <= n && to === -1; i++) {
          if (items[(at + i) % n].label.toLowerCase().indexOf(ev.key.toLowerCase()) === 0) to = (at + i) % n;
        }
      }
      if (to === -1) return;
      ev.preventDefault();
      buttons[to].focus();
    });
    openPop(anchor, menu);
    buttons[0].focus();
  }

  // ---------------------------------------------------------------- actions

  // Every change the board makes goes through propose(). An action has three
  // possible ends, and `settle` hears each of them:
  //
  //   "landed"   the state now shows it
  //   "refused"  the host said no, and said why
  //   "unsure"   nobody said anything in time
  //
  // A host that reports results answers through the promise `parley.act`
  // returns. An older host returns nothing, and so does a newer one that
  // cannot tell ("unknown"); then the only evidence is the state itself, and
  // the board waits for it. "unsure" is not the end: if the change turns up
  // late, the message is taken back and `settle` hears "landed" after all.
  let watching = [];

  function propose(action, payload, how) {
    const item = { landed: how.landed, settle: how.settle || function () {}, unsure: how.unsure, refused: how.refused || {} };
    const unsent = function () {
      refuse(item, "That could not be sent. Try again.");
    };
    hideToast();
    watching.push(item);
    item.timer = setTimeout(function () {
      expire(item);
    }, WAIT_MS);
    // The bridge throws for a message it will not carry, and a promise can
    // reject. Either way the action never left, and the board says so now.
    try {
      const answer = parley.act(action, payload);
      if (answer && typeof answer.then === "function") {
        answer.then(function (result) {
          hear(item, result);
        }, unsent);
      }
    } catch (err) {
      unsent();
    }
    return item;
  }

  // The host's answer. It is heard for as long as the action is watched, so
  // one that comes after the wait still counts: a late yes is a yes, and a
  // late no replaces "could not confirm" with the reason.
  function hear(item, result) {
    if (!result) return;
    if (watching.indexOf(item) === -1) {
      // The state showed the change before the answer came. The yes still
      // says something the state cannot: that the change was this viewer's.
      if (item.shown && result.ok === true) item.settle("accepted");
      return;
    }
    if (result.ok === true) {
      retract(item.notice);
      item.accepted = true;
      item.settle("accepted");
      return;
    }
    if (result.reason === "unknown") return;
    item.reason = result.reason;
    refuse(item, item.refused[result.reason] || REFUSALS[result.reason] || REFUSALS.failed);
  }

  function refuse(item, message) {
    if (watching.indexOf(item) === -1) return;
    forget(item);
    item.settle("refused");
    notify(message);
  }

  // The wait is over and the state does not show the change. If the host said
  // yes, the state is only slow and nothing is reported. Otherwise it is
  // "unsure". In both cases the action stays watched for a while longer.
  function expire(item) {
    if (!item.accepted) {
      item.settle("unsure");
      item.notice = notify(item.unsure);
    }
    item.timer = setTimeout(function () {
      forget(item);
      if (item.accepted) item.settle("landed");
    }, LATE_MS);
  }

  function forget(item) {
    clearTimeout(item.timer);
    watching = watching.filter(function (other) {
      return other !== item;
    });
  }

  function settleLanded() {
    watching.slice().forEach(function (item) {
      if (!item.landed(board)) return;
      item.shown = true;
      forget(item);
      retract(item.notice);
      item.settle("landed");
    });
  }

  // What changed between two boards, in words, for the live region.
  function describeChanges(before, after) {
    const said = [];
    const had = idsOf(before.cards);
    const fresh = after.cards.filter(function (c) {
      return !had[c.id];
    });
    if (fresh.length === 1) said.push("New note in " + columnTitle(fresh[0].columnId) + ".");
    if (fresh.length > 1) said.push(fresh.length + " new notes.");

    const hadGroups = idsOf(before.groups);
    after.groups.forEach(function (g) {
      if (!hadGroups[g.id]) said.push("Notes grouped as " + g.title + " in " + columnTitle(g.columnId) + ".");
    });

    const voted = after.cards.filter(function (c) {
      const old = before.cards.filter(function (o) {
        return o.id === c.id;
      })[0];
      return old && old.votes !== c.votes;
    });
    if (voted.length === 1) said.push(plural(voted[0].votes, "vote") + " on: " + short(voted[0].text) + ".");
    if (voted.length > 1) said.push("Votes changed on " + voted.length + " notes.");

    if (after.revealed && !before.revealed) said.push("Authors are now visible to everyone.");
    if (!after.revealed && before.revealed) said.push("Authors are hidden again.");

    if (after.stage !== before.stage) {
      const who = facilitator();
      const back = after.stage < before.stage;
      const where = (back ? "back to " : "to ") + STEPS[after.stage] + ".";
      if (viewerRole() === "facilitator") said.push("Moved " + where);
      else said.push((who ? who.name : "The facilitator") + " moved the room " + where + (back ? "" : " " + HINTS[after.stage]));
    }

    after.columns.forEach(function (col) {
      const sequence = function (b, other) {
        const shared = idsOf(other.cards);
        return b.cards
          .filter(function (c) {
            return c.columnId === col.id && shared[c.id];
          })
          .map(function (c) {
            return c.id + "/" + c.groupId;
          })
          .join(" ");
      };
      if (sequence(before, after) !== sequence(after, before)) said.push("Notes were reordered in " + col.title + ".");
    });

    // A stamp is announced by what it is and how many there are, never by who.
    const hadStamps = idsOf(before.stamps);
    const hasStamps = idsOf(after.stamps);
    const pressed = after.stamps.filter(function (s) {
      return !hadStamps[s.id];
    });
    const lifted = before.stamps.filter(function (s) {
      return !hasStamps[s.id];
    });
    const stampWords = function (s, verb) {
      const on = after.cards.filter(function (c) {
        return c.id === s.cardId;
      })[0];
      const count = after.stamps.filter(function (o) {
        return o.cardId === s.cardId;
      }).length;
      return STAMPS[s.kind].label + " stamp " + verb + ": " + short(on ? on.text : "a note") + ". " + plural(count, "stamp") + " on that note.";
    };
    if (pressed.length === 1 && !lifted.length) said.push(stampWords(pressed[0], "pressed on"));
    else if (lifted.length === 1 && !pressed.length) said.push(stampWords(lifted[0], "removed from"));
    else if (pressed.length + lifted.length) said.push("Stamps changed on the board.");

    const a = after.timer;
    const b = before.timer;
    if (a && (!b || a.rev !== b.rev)) {
      if (!b) said.push("Timer started: " + clockFace(a.remaining) + ".");
      else if (a.running !== b.running) said.push(a.running ? "Timer resumed." : "Timer paused at " + clockFace(a.remaining) + ".");
      else if (a.remaining > b.remaining) said.push("Timer now at " + clockFace(a.remaining) + ".");
    }
    if (b && !a && after.stage === before.stage) said.push("Timer cleared.");

    const hadActions = idsOf(before.actionItems);
    after.actionItems.forEach(function (a) {
      if (!hadActions[a.id]) said.push("New action: " + short(a.text) + ".");
    });
    before.actionItems.forEach(function (old) {
      const now = after.actionItems.filter(function (a) {
        return a.id === old.id;
      })[0];
      if (now && now.sourceIds.join() !== old.sourceIds.join()) said.push("The notes behind an action changed: " + short(now.text) + ".");
    });
    return said.join(" ");
  }

  // ------------------------------------------------------------------ stage

  // All four hints are laid in the same cell and only the current one shows,
  // so the strip is as tall as the longest and a stage change moves nothing.
  const hints = HINTS.map(function (text) {
    return el("p", { class: "hint", text: text });
  });
  const thumb = el("span", { class: "thumb", "aria-hidden": "true" });
  const stepViews = STEPS.map(function (name, i) {
    const number = el("span", { text: String(i + 1) });
    const check = el("span", {}, [icon(GLYPH.check)]);
    const status = el("span", { class: "sr-only" });
    const item = el("li", { class: "step" }, [
      el("span", { class: "step-mark", "aria-hidden": "true" }, [number, check]),
      el("span", { text: name }),
      status,
    ]);
    return { el: item, number: number, check: check, status: status };
  });
  const stageNextWord = el("span");
  const stageNext = el("button", { type: "button", class: "btn btn-primary btn-small stage-next" }, [stageNextWord, icon(GLYPH.arrow)]);
  const stageBack = el("button", { type: "button", class: "btn btn-quiet btn-small" });
  const stageNav = el("div", { class: "row stage-nav" }, [stageBack, stageNext]);
  let staging = false;

  function onlyFacilitator(what) {
    const who = facilitator();
    return "Only the facilitator" + (who ? ", " + who.name + "," : "") + " can " + what + ".";
  }

  // The facilitator gets the two buttons, and so does a viewer the host has
  // not identified: the server decides, and says so if the answer is no.
  function patchProgress() {
    const stage = board.stage;
    const held = document.activeElement;
    main.className = "board stage-" + stage;
    stepViews.forEach(function (v, i) {
      const current = i === stage;
      const done = i < stage;
      v.el.className = "step" + (current ? " current" : done ? " reached" : "");
      if (current) v.el.setAttribute("aria-current", "step");
      else v.el.removeAttribute("aria-current");
      v.number.hidden = done;
      v.check.hidden = !done;
      setText(v.status, current ? ", current" : done ? ", done" : "");
    });
    hints.forEach(function (hint, i) {
      hint.classList.toggle("shown", i === stage);
      if (i === stage) hint.removeAttribute("aria-hidden");
      else hint.setAttribute("aria-hidden", "true");
    });
    stageNav.hidden = viewerRole() === "participant";
    stageNext.hidden = stage === STEPS.length - 1;
    stageBack.hidden = stage === 0;
    stageNext.disabled = stageBack.disabled = staging;
    if (!stageNext.hidden) setText(stageNextWord, "Move to " + STEPS[stage + 1]);
    if (!stageBack.hidden) setText(stageBack, "Back to " + STEPS[stage - 1]);
    // The button that was pressed may be the one that just went away.
    if (held === stageNext && stageNext.hidden) stageBack.focus();
    if (held === stageBack && stageBack.hidden) stageNext.focus();
  }

  // One pill sits behind the current step and slides to the next one, the
  // same way forward and back: it is one object, moved.
  function placeThumb(glide) {
    const step = stepViews[board.stage].el;
    const from = rectOf(thumb);
    thumb.style.left = (step.offsetLeft || 0) + "px";
    thumb.style.top = (step.offsetTop || 0) + "px";
    thumb.style.width = (step.offsetWidth || 0) + "px";
    thumb.style.height = (step.offsetHeight || 0) + "px";
    if (!glide || !motionOn()) return;
    const to = rectOf(thumb);
    const stretch = to.width ? from.width / to.width : 1;
    animate(thumb, { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scaleX(" + stretch + ")" }, GLIDE);
  }

  function setStage(stage) {
    if (staging) return;
    staging = true;
    propose("set-stage", { stage: stage }, {
      landed: function (b) {
        return b.stage === stage;
      },
      refused: { forbidden: onlyFacilitator("change the stage") },
      unsure: "Could not confirm the stage change. " + onlyFacilitator("change the stage"),
      settle: function (outcome) {
        if (outcome === "accepted") return;
        staging = false;
        patchProgress();
      },
    });
    patchProgress();
  }

  stageNext.addEventListener("click", function () {
    setStage(board.stage + 1);
  });
  stageBack.addEventListener("click", function () {
    setStage(board.stage - 1);
  });

  // ------------------------------------------------------------------ timer

  // The server sends the time remaining, stamped as it builds each state. The
  // frame counts down from there on its own clock, and takes a new reading
  // only when the timer itself changes (its `rev`), so a teammate's vote that
  // arrives a little late cannot nudge the countdown.
  const RING = 2 * Math.PI * 8;
  const timerArc = ringPart("arc");
  const timerText = el("span", { class: "mono timer-text" });
  const timerFace = el("span", { class: "timer-face", role: "timer", "aria-live": "off" }, [
    ringSvg([ringPart("track"), timerArc]),
    timerText,
  ]);
  const timerWord = el("span", { text: "Timer" });
  const timerButton = el("button", { type: "button", class: "btn btn-quiet btn-small timer-open", "aria-haspopup": "dialog" }, [
    icon(GLYPH.clock),
    timerWord,
  ]);
  const timerSlot = el("div", { class: "timer-slot" }, [timerFace, timerButton]);
  let timerRev = null;
  let timerEnd = 0;
  let timerLoop = 0;
  let timerSecond = null;
  let timerSaid = {};

  function ringPart(name) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const attrs = { class: name, cx: 10, cy: 10, r: 8, fill: "none", "stroke-width": 2.5, "stroke-dasharray": RING, transform: "rotate(-90 10 10)" };
    for (const key in attrs) circle.setAttribute(key, attrs[key]);
    return circle;
  }

  function ringSvg(parts) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const attrs = { width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": "true" };
    for (const key in attrs) svg.setAttribute(key, attrs[key]);
    parts.forEach(function (part) {
      svg.appendChild(part);
    });
    return svg;
  }

  function clockFace(ms) {
    const seconds = Math.ceil(ms / 1000);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  function timeLeft() {
    const t = board.timer;
    return t.running ? Math.max(0, timerEnd - clockNow()) : t.remaining;
  }

  function patchTimer() {
    const t = board.timer;
    timerButton.hidden = viewerRole() === "participant";
    timerWord.hidden = !!t;
    timerButton.setAttribute("aria-label", t ? "Timer controls" : "Set a timer");
    timerFace.hidden = !t;
    clearTimeout(timerLoop);
    if (!t) {
      timerRev = null;
      return;
    }
    if (t.rev !== timerRev) {
      timerRev = t.rev;
      timerEnd = clockNow() + t.remaining;
      timerSecond = null;
      // What had already gone by when this viewer first saw the timer is
      // not announced: a late joiner is not told "time's up" on arrival.
      timerSaid = { 60000: t.remaining <= 60000, 10000: t.remaining <= 10000, 0: t.remaining <= 0 };
    }
    tickTimer();
  }

  // Runs four times a second while a timer is running, and not at all
  // otherwise. Screen readers hear three moments, never the ticking.
  function tickTimer() {
    const t = board.timer;
    const left = timeLeft();
    const second = Math.ceil(left / 1000);
    setText(timerText, left <= 0 ? "Time's up" : (t.running ? "" : "Paused ") + clockFace(left));
    timerFace.classList.toggle("ending", left <= 10000);
    timerArc.setAttribute("stroke-dashoffset", (RING * (1 - Math.min(1, left / t.duration))).toFixed(2));
    if (second !== timerSecond) {
      if (timerSecond !== null && t.running && left > 0 && left <= 10000) tick(timerText);
      timerSecond = second;
    }
    [
      [60000, t.duration >= 3 * MINUTE && "One minute left."],
      [10000, "10 seconds left."],
      [0, "Time's up."],
    ].forEach(function (moment) {
      if (left > moment[0] || timerSaid[moment[0]]) return;
      timerSaid[moment[0]] = true;
      if (moment[1]) setText(live, moment[1]);
      if (moment[0] === 0 && motionOn()) animate(timerFace, { transform: "scale(1.14)" }, POP);
    });
    if (t.running && left > 0) timerLoop = setTimeout(tickTimer, 250);
  }

  function sendTimer(body) {
    const key = function (b) {
      return b.timer ? b.timer.rev : "none";
    };
    const was = key(board);
    closePop(true);
    propose("timer", body, {
      landed: function (b) {
        return key(b) !== was;
      },
      refused: { forbidden: onlyFacilitator("set the timer") },
      unsure: "Could not confirm the timer change. " + onlyFacilitator("set the timer"),
    });
  }

  function timerControl(label, body, kind) {
    const control = el("button", { type: "button", class: "btn btn-small " + (kind || "btn-quiet"), text: label });
    control.addEventListener("click", function () {
      sendTimer(body);
    });
    return control;
  }

  function openTimer() {
    const t = board.timer;
    const panel = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Timer" });
    if (t) {
      const first = !t.running ? timerControl("Resume", { op: "resume" }, "btn-primary") : timeLeft() > 0 ? timerControl("Pause", { op: "pause" }) : null;
      const controls = [timerControl("+1 min", { op: "add" }), timerControl("Clear", { op: "clear" })];
      panel.appendChild(el("div", { class: "row" }, first ? [first].concat(controls) : controls));
    } else {
      const minutes = el("input", { id: "timer-minutes", class: "field", inputmode: "numeric", maxlength: 3, placeholder: "1 to 180" });
      const start = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Start" });
      const custom = function () {
        const n = Number(minutes.value.trim());
        if (!Number.isInteger(n) || n < 1 || n > 180) notify("A timer runs from 1 to 180 minutes.");
        else sendTimer({ op: "start", durationMs: n * MINUTE });
      };
      start.addEventListener("click", custom);
      minutes.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") custom();
      });
      panel.appendChild(el("p", { class: "label", text: "Start a timer for " + STEPS[board.stage] }));
      panel.appendChild(
        el(
          "div",
          { class: "row" },
          PRESETS.map(function (m) {
            return timerControl(m + " min", { op: "start", durationMs: m * MINUTE });
          }),
        ),
      );
      panel.appendChild(el("div", { class: "row" }, [el("label", { class: "label", for: "timer-minutes", text: "Minutes" }), minutes, start]));
    }
    openPop(timerButton, panel);
    panel.children[t ? 0 : 1].children[0].focus();
  }

  toggles(timerButton, openTimer);

  // ------------------------------------------------------------- authorship

  const authTitle = el("p", { class: "auth-title" });
  const authLine = el("p", { class: "fine" });
  const revealButton = el("button", { type: "button", class: "btn btn-quiet" }, [
    el("span", { class: "brass-dot", "aria-hidden": "true" }),
    el("span", { text: "Reveal authors" }),
  ]);
  const revealConfirm = el("button", { type: "button", class: "btn btn-brass", text: "Reveal to everyone" });
  const revealCancel = el("button", { type: "button", class: "btn btn-quiet", text: "Not yet" });
  const revealArmed = el("div", { class: "row" }, [revealConfirm, revealCancel]);
  const concealButton = el("button", { type: "button", class: "btn btn-quiet", text: "Hide authors again" });
  const authorship = el("section", { class: "authorship panel", "aria-label": "Authorship" }, [
    el("div", { class: "auth-text" }, [authTitle, authLine]),
    revealButton,
    revealArmed,
    concealButton,
  ]);
  let armed = false;
  let revealing = false;
  let concealing = false;
  // Set when this viewer watched the names go away, so the panel can say
  // "again" to someone who would otherwise wonder where they went.
  let hiddenAgain = false;

  // The server decides who may reveal and who may hide. What is shown follows
  // what the frame knows: the facilitator gets the control, everyone else is
  // told who holds it, and a host that does not say who is looking gets both.
  function patchAuthorship() {
    const role = viewerRole();
    const who = facilitator();
    const offered = !board.revealed && role !== "participant" && board.cards.length > 0;
    if (!offered) armed = false;
    authorship.classList.toggle("armed", armed);

    revealButton.hidden = !offered || armed;
    revealArmed.hidden = !offered || !armed;
    revealConfirm.disabled = revealing;
    setText(revealConfirm, revealing ? "Revealing…" : "Reveal to everyone");
    concealButton.hidden = !board.revealed || role === "participant";
    concealButton.disabled = concealing;

    const facilitatorName = who ? who.name + ", the facilitator," : "The facilitator";
    if (board.revealed) {
      setText(authTitle, "Authors are visible");
      setText(authLine, "Everyone can see who wrote each note.");
    } else if (armed) {
      setText(authTitle, "Show everyone who wrote each note?");
      setText(authLine, "You can hide them again, but anyone looking now will have seen them.");
    } else {
      setText(authTitle, "Notes are anonymous");
      if (role === "facilitator") setText(authLine, "Only you can reveal who wrote them.");
      else if (role === "unknown") setText(authLine, onlyFacilitator("reveal authors"));
      else if (hiddenAgain) setText(authLine, "Notes are anonymous again. " + facilitatorName + " can reveal them.");
      else setText(authLine, facilitatorName + " reveals authors when the room is ready.");
    }
  }

  function arm(on) {
    armed = on;
    patchAuthorship();
    (on ? revealCancel : revealButton).focus();
  }

  function confirmReveal() {
    if (revealing) return;
    revealing = true;
    propose("reveal", {}, {
      landed: function (b) {
        return b.revealed;
      },
      refused: { forbidden: onlyFacilitator("reveal authors") },
      unsure: "Could not confirm the reveal. " + onlyFacilitator("reveal authors"),
      settle: function (outcome) {
        if (outcome === "accepted") return;
        revealing = false;
        if (outcome !== "landed" && armed) arm(false);
        else patchAuthorship();
        if (outcome === "landed" && !concealButton.hidden) concealButton.focus();
      },
    });
    patchAuthorship();
  }

  // Hiding is not confirmed: it moves toward privacy, it can be taken back,
  // and it deletes nothing.
  function conceal() {
    if (concealing) return;
    concealing = true;
    propose("conceal", {}, {
      landed: function (b) {
        return !b.revealed;
      },
      refused: { forbidden: onlyFacilitator("hide authors") },
      unsure: "Could not confirm that authors were hidden. " + onlyFacilitator("hide authors"),
      settle: function (outcome) {
        if (outcome === "accepted") return;
        concealing = false;
        patchAuthorship();
        if (outcome === "landed" && !revealButton.hidden) revealButton.focus();
      },
    });
    patchAuthorship();
  }

  revealButton.addEventListener("click", function () {
    arm(true);
  });
  revealCancel.addEventListener("click", function () {
    arm(false);
  });
  revealConfirm.addEventListener("click", confirmReveal);
  concealButton.addEventListener("click", conceal);

  // ------------------------------------------------------------------ lanes

  const lanes = el("div", { class: "lanes" });
  const SORTED_OFF = "Sorted by votes. Show shared order to move notes here.";

  function buildLane(col) {
    const meta = LANES[col.id] || OTHER_LANE;
    const headingId = "lane-" + col.id;
    const inputId = "note-" + col.id;
    const lane = {
      id: col.id,
      open: false,
      ghosts: [],
      title: el("h2", { id: headingId, dir: "auto" }),
      // "Most votes" is a lens for one reader: `sorted` holds the ranking as
      // it stood when it was switched on, and nothing is written anywhere.
      sorted: null,
      sortToggle: el("button", { type: "button", class: "sort", "aria-pressed": "false" }, [icon(GLYPH.bars), el("span", { class: "sr-only", text: "Most votes" })]),
      resort: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Re-sort" }),
      unsort: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Show shared order" }),
      share: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Use this order for everyone" }),
      prompt: el("p", { class: "prompt", text: meta.prompt }),
      count: el("span", { class: "count", "aria-hidden": "true" }),
      countWords: el("span", { class: "sr-only" }),
      label: el("label", { class: "sr-only", for: inputId }),
      input: el("textarea", { id: inputId, class: "field", rows: 1, maxlength: NOTE_LIMIT, placeholder: "Add a note", dir: "auto" }),
      add: el("button", { type: "button", class: "btn btn-primary", text: "Add" }),
      reopen: el("button", { type: "button", class: "reopen" }, [icon(GLYPH.plus), el("span", { text: "Add a note" })]),
      left: el("p", { class: "left" }),
      empty: el("p", { class: "empty", text: meta.empty }),
      list: el("ul", { class: "notes" }),
    };
    lane.row = el("div", { class: "composer-row" }, [lane.input, lane.add]);
    lane.sortLine = el("div", { class: "sort-line row" }, [
      el("p", { class: "fine", text: "Sorted by votes, only for you." }),
      lane.resort,
      lane.unsort,
      lane.share,
    ]);
    lane.el = el("section", { class: "lane panel", "aria-labelledby": headingId, style: "--hue:var(--color-" + meta.hue + ")" }, [
      el("div", { class: "lane-head" }, [
        el("span", { class: "lane-glyph" }, [icon(meta.glyph)]),
        el("div", { class: "lane-title" }, [lane.title, lane.prompt]),
        lane.sortToggle,
        lane.count,
        lane.countWords,
      ]),
      lane.sortLine,
      el("div", { class: "composer" }, [lane.label, lane.row, lane.reopen, lane.left]),
      lane.empty,
      lane.list,
    ]);

    const sortBy = function (rank) {
      reflow(function () {
        lane.sorted = rank;
        patchLanes();
      });
    };
    lane.sortToggle.addEventListener("click", function () {
      sortBy(lane.sorted ? null : rankOf(itemsOf(lane.id)));
    });
    lane.resort.addEventListener("click", function () {
      sortBy(rankOf(itemsOf(lane.id)));
      lane.unsort.focus();
    });
    lane.unsort.addEventListener("click", function () {
      sortBy(null);
      lane.sortToggle.focus();
    });
    lane.share.addEventListener("click", function () {
      propose("order-by-votes", { columnId: lane.id }, {
        // The new order is in whatever state comes next.
        landed: function () {
          return true;
        },
        refused: { forbidden: onlyFacilitator("reorder a lane for everyone") },
        unsure: "Could not confirm the new order. " + onlyFacilitator("reorder a lane for everyone"),
        settle: function (outcome) {
          if (outcome !== "landed" && outcome !== "accepted") return;
          const held = document.activeElement === lane.share;
          sortBy(null);
          if (held) lane.sortToggle.focus();
        },
      });
    });

    lane.input.addEventListener("input", function () {
      patchComposer(lane);
    });
    lane.input.addEventListener("blur", function () {
      lane.open = false;
      patchComposer(lane);
    });
    // The frame is sandboxed without allow-forms, so a form would never
    // submit. Enter is handled here; Shift+Enter still makes a new line.
    lane.input.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
      ev.preventDefault();
      addNote(lane);
    });
    lane.add.addEventListener("click", function () {
      addNote(lane);
    });
    lane.reopen.addEventListener("click", function () {
      lane.open = true;
      patchComposer(lane);
      lane.input.focus();
    });
    return lane;
  }

  // The ranking of a lane by votes: a group by the votes of its notes
  // together, and the notes inside it by their own. Ties keep the shared order.
  function rankOf(items) {
    const rank = {};
    items.slice().sort(byVotes).forEach(function (item, i) {
      rank[item.id] = i;
      if (!item.group) return;
      item.cards.slice().sort(byVotes).forEach(function (c, j) {
        rank[c.id] = j;
      });
    });
    return rank;
  }

  // Items in a ranking taken earlier. What has arrived since goes last.
  function ranked(items, rank) {
    const by = function (a, b) {
      return (a.id in rank ? rank[a.id] : 1e9) - (b.id in rank ? rank[b.id] : 1e9);
    };
    return items.slice().sort(by).map(function (item) {
      return item.group ? Object.assign({}, item, { cards: item.cards.slice().sort(by) }) : item;
    });
  }

  // Make a change that moves notes, and let them glide to where they end up.
  // Moving a node drops its focus, so focus is handed back afterwards.
  function reflow(change) {
    const held = document.activeElement;
    const boxes = motionOn() ? measure() : null;
    change();
    if (held && held !== document.activeElement && held.isConnected && document.activeElement === document.body) {
      held.focus({ preventScroll: true });
    }
    if (boxes) glideFrom(boxes);
  }

  // One row that grows with what is typed. After the Write stage an idle
  // composer steps back behind "Add a note"; both are the same height, so
  // nothing moves when it does. It never closes: a late note is still a note.
  function patchComposer(lane) {
    const input = lane.input;
    const idle = !input.value && !lane.open && document.activeElement !== input;
    const room = NOTE_LIMIT - input.value.length;
    lane.row.hidden = board.stage !== 0 && idle;
    lane.reopen.hidden = !lane.row.hidden;
    lane.add.disabled = !input.value.trim();
    setText(lane.left, room <= 100 ? plural(room, "character") + " left" : "");
    lane.left.hidden = room > 100;
    input.style.height = "";
    if (input.scrollHeight > 42) input.style.height = input.scrollHeight + 2 + "px";
  }

  // ------------------------------------------------------- notes on the way

  // Enter empties the box at once, so the next thought can follow, and the
  // note waits in its lane as a ghost until the state shows the real one. The
  // board is one stored document, so notes are sent one at a time, in order.
  let sending = null;

  function addNote(lane) {
    const text = lane.input.value.trim().slice(0, NOTE_LIMIT);
    if (!text) return;
    lane.input.value = "";
    lane.input.focus();
    patchComposer(lane);
    lane.ghosts.push(buildGhost(lane, text));
    patchLanes();
    sendNext();
  }

  function buildGhost(lane, text) {
    const ghost = {
      lane: lane,
      text: text,
      status: "queued",
      words: el("span"),
      retry: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Send again" }),
      discard: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Discard" }),
    };
    ghost.el = el("li", { class: "note ghost" }, [
      el("span", { class: "pick", "aria-hidden": "true" }),
      el("p", { class: "note-text", dir: "auto", text: text }),
      el("div", { class: "ghost-foot" }, [ghost.words, ghost.retry, ghost.discard]),
    ]);
    ghost.retry.addEventListener("click", function () {
      if (ghost.watch) forget(ghost.watch);
      // The first send may have landed since it was called unconfirmed.
      if (ghostLanded(ghost, board)) {
        dropGhost(ghost);
        return;
      }
      ghost.status = "queued";
      patchGhost(ghost);
      sendNext();
    });
    ghost.discard.addEventListener("click", function () {
      dropGhost(ghost);
      lane.input.focus();
    });
    patchGhost(ghost);
    return ghost;
  }

  function patchGhost(ghost) {
    const stuck = ghost.status === "refused" || ghost.status === "unsure";
    setText(ghost.words, ghost.status === "refused" ? "Not saved." : ghost.status === "unsure" ? "Not confirmed yet." : "Saving…");
    ghost.retry.hidden = !stuck;
    ghost.discard.hidden = !stuck;
  }

  function dropGhost(ghost) {
    if (ghost.watch) forget(ghost.watch);
    ghost.watch = null;
    if (sending === ghost) sending = null;
    ghost.lane.ghosts = ghost.lane.ghosts.filter(function (other) {
      return other !== ghost;
    });
    patchLanes();
    sendNext();
  }

  // A ghost has landed when the state holds a note that was not there when
  // the ghost was first sent, in its lane, with its text.
  function ghostLanded(ghost, b) {
    return (
      !!ghost.had &&
      b.cards.some(function (c) {
        return !ghost.had[c.id] && c.columnId === ghost.lane.id && c.text === ghost.text;
      })
    );
  }

  // Run on every state push, whether or not the send is still being watched:
  // a note that turns up a minute late must not leave its ghost beside it.
  function reconcileGhosts() {
    for (const id in view.lanes) {
      view.lanes[id].ghosts.slice().forEach(function (ghost) {
        if (ghost.status !== "refused" && ghostLanded(ghost, board)) dropGhost(ghost);
      });
    }
  }

  // A lane can leave the state while a note for it is still waiting. The note
  // cannot be saved any more, and it is not allowed to vanish without a word.
  function loseGhosts(lane) {
    lane.ghosts.slice().forEach(function (ghost) {
      if (ghost.watch) forget(ghost.watch);
      if (sending === ghost) sending = null;
      notify("That lane is gone, so your note was not saved: " + short(ghost.text));
    });
    lane.ghosts = [];
  }

  function sendNext() {
    if (sending) return;
    let next = null;
    for (const id in view.lanes) {
      view.lanes[id].ghosts.forEach(function (ghost) {
        if (!next && ghost.status === "queued") next = ghost;
      });
    }
    if (!next) return;
    next.had = next.had || idsOf(board.cards);
    sending = next;
    next.status = "saving";
    patchGhost(next);
    next.watch = propose("add-card", { columnId: next.lane.id, text: next.text }, {
      landed: function (b) {
        return ghostLanded(next, b);
      },
      unsure: "Could not confirm that your note was saved. It is waiting in its lane.",
      settle: function (outcome) {
        if (outcome === "landed") {
          dropGhost(next);
          return;
        }
        if (outcome !== "accepted" && sending === next) sending = null;
        next.status = outcome === "accepted" ? "saving" : outcome;
        patchGhost(next);
        sendNext();
      },
    });
  }

  // ------------------------------------------------------------------ notes

  // A note's face holds one control in front of its text and at most a
  // couple after it; which ones depends on the stage. Everything else a note
  // can do is in its menu, which is also the keyboard and touch path for
  // every pointer gesture on the board.
  function buildNote(id) {
    const note = {
      votes: null,
      linked: null,
      mine: false,
      voting: false,
      box: el("input", { type: "checkbox" }),
      grip: el("button", { type: "button", class: "grip", "aria-haspopup": "menu" }, [icon(GLYPH.grip)]),
      more: el("button", { type: "button", class: "more", "aria-haspopup": "menu" }, [icon(GLYPH.dots)]),
      text: el("p", { class: "note-text", dir: "auto" }),
      author: buildPerson(),
      target: el("button", { type: "button", class: "target", "aria-haspopup": "dialog" }, [icon(GLYPH.target)]),
      targetCount: el("span", { class: "mono" }),
      vote: el("button", { type: "button", class: "vote" }),
      word: el("span", { text: "Vote" }),
      count: el("span", { class: "mono" }),
      stamps: el("ul", { class: "stamps", "aria-label": "Stamps" }),
    };
    note.pick = el("label", { class: "pick" }, [note.box]);
    note.target.appendChild(note.targetCount);
    note.vote.appendChild(el("span", { class: "vote-dot", "aria-hidden": "true" }));
    note.vote.appendChild(note.word);
    note.vote.appendChild(note.count);
    note.el = el("li", { class: "note" }, [
      el("span", { class: "lead" }, [note.pick, note.grip]),
      note.text,
      el("span", { class: "trail" }, [note.target, note.vote, note.more]),
      note.author.el,
      note.stamps,
    ]);

    note.box.addEventListener("change", function () {
      selected[id] = note.box.checked;
      patchSelection();
    });
    note.vote.addEventListener("click", function () {
      castVote(id);
    });
    [note.grip, note.more].forEach(function (opener) {
      toggles(opener, function () {
        if (!note.dragged) openNoteMenu(id, opener);
      });
    });
    toggles(note.target, function () {
      openLinks(id, note.target);
    });
    lights(note.target, function () {
      return actionsFrom(id).map(function (a) {
        return view.actions[a.id] && view.actions[a.id].el;
      });
    });
    note.el.addEventListener("keydown", function (ev) {
      if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      ev.preventDefault();
      const up = ev.key === "ArrowUp";
      moveNote(id, ev.shiftKey ? (up ? "top" : "bottom") : up ? "up" : "down");
    });
    dragsNote(note.grip, id);
    dragsNote(note.el, id);
    return note;
  }

  // The control in front of a note's text: its checkbox while notes are being
  // picked, its handle otherwise.
  function leadOf(note) {
    return note.pick.hidden ? note.grip : note.box;
  }

  // The vote control is quiet until a note has votes: "Vote" at zero, the
  // count once there is one. It is marked as the viewer's own only when the
  // host has said so.
  function patchNote(note, card) {
    const held = document.activeElement;
    const linked = actionsFrom(card.id).length;
    const brief = short(card.text);
    setText(note.text, card.text);
    note.box.setAttribute("aria-label", "Select note: " + brief);
    note.grip.setAttribute("aria-label", "Options for note: " + brief);
    note.more.setAttribute("aria-label", "Options for note: " + brief);

    note.vote.hidden = board.stage !== 2 && card.votes === 0;
    note.vote.setAttribute("aria-label", "Vote for: " + brief + ". " + plural(card.votes, "vote") + "." + (note.mine ? " You voted." : ""));
    if (note.mine) note.vote.setAttribute("aria-pressed", "true");
    note.vote.classList.toggle("has-votes", card.votes > 0);
    note.word.hidden = card.votes > 0;
    note.count.hidden = card.votes === 0;
    if (note.votes !== card.votes) {
      setText(note.count, String(card.votes));
      if (note.votes !== null && card.votes > 0) tick(note.count);
      note.votes = card.votes;
    }

    note.target.hidden = board.stage !== 3 && linked === 0;
    note.target.classList.toggle("linked", linked > 0);
    note.target.setAttribute("aria-label", linked ? plural(linked, "action") + " from: " + brief + ". Open." : "Start an action from: " + brief);
    note.targetCount.hidden = linked === 0;
    setText(note.targetCount, String(linked));
    if (note.linked === 0 && linked > 0 && motionOn()) animate(note.target, { transform: "scale(.4)" }, POP);
    note.linked = linked;

    const named = board.revealed && card.authorId;
    note.author.el.hidden = !named;
    if (named) showPerson(note.author, personById(card.authorId));
    // A stage change can take away the control somebody was on.
    if ((held === note.vote && note.vote.hidden) || (held === note.target && note.target.hidden)) leadOf(note).focus();
  }

  // The state carries a count per note and nothing about whose votes they
  // are, so "mine" is only ever what the host confirmed in this sitting. On a
  // host that reports nothing, a count that did not move is the only signal.
  function castVote(id) {
    const note = view.notes[id];
    const card = cardById(id);
    if (!note || !card) return;
    if (note.mine) {
      notify("You have already voted for this note. Each person has one vote per note.");
      return;
    }
    if (note.voting) return;
    const before = card.votes;
    note.voting = true;
    propose("vote", { cardId: id }, {
      landed: function () {
        const now = cardById(id);
        return !now || now.votes > before;
      },
      unsure: "No change. Each person has one vote per note, so yours may already be counted.",
      settle: function (outcome) {
        if (outcome === "accepted") {
          note.mine = true;
          if (cardById(id)) patchNote(note, cardById(id));
          return;
        }
        note.voting = false;
      },
    });
  }

  function openNoteMenu(id, opener) {
    const card = cardById(id);
    const note = view.notes[id];
    const off = view.lanes[card.columnId].sorted ? SORTED_OFF : "";
    const linked = actionsFrom(id).length;
    const items = [];
    if (!note.mine) {
      items.push({
        label: "Vote for this note",
        run: function () {
          castVote(id);
        },
      });
    }
    items.push({
      label: "Add a stamp…",
      run: function () {
        openStamps(id, opener);
      },
    });
    items.push({
      label: linked ? "Actions from this note (" + linked + ")…" : "Start an action from this note…",
      run: function () {
        openLinks(id, opener);
      },
    });
    items.push({
      label: selected[id] ? "Deselect" : "Select to group",
      run: function () {
        selected[id] = !selected[id];
        patchSelection();
        leadOf(note).focus();
      },
    });
    if (card.groupId) {
      items.push({
        label: "Take out of group",
        off: off,
        run: function () {
          sendMove("move-card", { cardId: id, groupId: null }, "Taken out of its group.");
        },
      });
    }
    [["up", "Move up", "Alt+Up"], ["down", "Move down", "Alt+Down"], ["top", "Move to top", "Alt+Shift+Up"], ["bottom", "Move to bottom", "Alt+Shift+Down"]].forEach(function (way) {
      items.push({
        label: way[1],
        keys: way[2],
        off: off,
        run: function () {
          moveNote(id, way[0]);
        },
      });
    });
    board.columns.forEach(function (col) {
      if (col.id === card.columnId) return;
      items.push({
        label: "Move to " + col.title,
        run: function () {
          sendMove("move-card", { cardId: id, columnId: col.id }, "Moved to " + col.title + ".");
        },
      });
    });
    openMenu(opener, "Options for note: " + short(card.text), items);
  }

  // ----------------------------------------------------------------- groups

  function buildGroup(id) {
    const group = {
      grip: el("button", { type: "button", class: "grip", "aria-haspopup": "menu" }, [icon(GLYPH.grip)]),
      title: el("h3", { tabindex: -1, dir: "auto" }),
      meta: el("p", { class: "group-meta" }),
      target: el("button", { type: "button", class: "target", "aria-haspopup": "dialog" }, [icon(GLYPH.target)]),
      targetCount: el("span", { class: "mono" }),
      list: el("ul", { class: "notes" }),
    };
    group.target.appendChild(group.targetCount);
    group.head = el("div", { class: "group-head" }, [group.grip, el("div", { class: "group-title" }, [group.title, group.meta]), group.target]);
    group.el = el("li", { class: "group" }, [group.head, group.list]);

    const ways = [["up", "Move group up", "Alt+Up"], ["down", "Move group down", "Alt+Down"], ["top", "Move group to top", "Alt+Shift+Up"], ["bottom", "Move group to bottom", "Alt+Shift+Down"]];
    toggles(group.grip, function () {
      const g = groupById(id);
      const off = view.lanes[g.columnId].sorted ? SORTED_OFF : "";
      const linked = actionsFrom(id).length;
      const items = ways.map(function (way) {
        return {
          label: way[1],
          keys: way[2],
          off: off,
          run: function () {
            moveGroup(id, way[0]);
          },
        };
      });
      items.unshift({
        label: linked ? "Actions from this group (" + linked + ")…" : "Start an action from this group…",
        run: function () {
          openLinks(id, group.grip);
        },
      });
      openMenu(group.grip, "Options for group: " + g.title, items);
    });
    toggles(group.target, function () {
      openLinks(id, group.target);
    });
    group.head.addEventListener("keydown", function (ev) {
      if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      ev.preventDefault();
      const up = ev.key === "ArrowUp";
      moveGroup(id, ev.shiftKey ? (up ? "top" : "bottom") : up ? "up" : "down");
    });
    return group;
  }

  function patchGroup(group, item) {
    const linked = actionsFrom(item.id).length;
    const title = item.group.title;
    setText(group.title, title);
    group.title.setAttribute("title", title);
    setText(group.meta, plural(item.cards.length, "note") + " · " + plural(item.votes, "vote"));
    group.grip.setAttribute("aria-label", "Options for group: " + title);
    group.target.hidden = board.stage !== 3 && linked === 0;
    group.target.classList.toggle("linked", linked > 0);
    group.target.setAttribute("aria-label", linked ? plural(linked, "action") + " from group: " + title + ". Open." : "Start an action from group: " + title);
    group.targetCount.hidden = linked === 0;
    setText(group.targetCount, String(linked));
  }

  // ------------------------------------------------------------------ moves

  // The order of the notes is shared: whoever moves one moves it for
  // everybody. The move is made here first, so the note is already where it
  // was put, and taken back if the host says no.
  function orderKey(b) {
    return b.cards
      .map(function (c) {
        return c.id + "/" + c.columnId + "/" + c.groupId;
      })
      .join(" ");
  }

  // The same splice board.js makes: the note, or the group's notes together,
  // taken out and set down in front of `beforeId`, or at the end without one.
  function applyMove(action, body) {
    const moved = action === "move-group" ? membersOf(body.groupId) : [cardById(body.cardId)];
    const rest = board.cards.filter(function (c) {
      return moved.indexOf(c) === -1;
    });
    let at = rest.length;
    rest.forEach(function (c, i) {
      if (at === rest.length && (c.id === body.beforeId || c.groupId === body.beforeId)) at = i;
    });
    if (action === "move-card") {
      const card = moved[0];
      if (body.columnId && body.columnId !== card.columnId) {
        card.columnId = body.columnId;
        card.groupId = null;
      }
      if (body.groupId === null) card.groupId = null;
      else if (body.groupId) {
        card.groupId = body.groupId;
        card.columnId = groupById(body.groupId).columnId;
      }
    }
    board.cards = rest.slice(0, at).concat(moved, rest.slice(at));
  }

  function sendMove(action, body, said) {
    const mine = board;
    const was = board.cards.map(function (c) {
      return { card: c, columnId: c.columnId, groupId: c.groupId };
    });
    reflow(function () {
      applyMove(action, body);
      patchLanes();
      patchSelection();
    });
    const key = orderKey(board);
    setText(live, typeof said === "function" ? said() : said);
    propose(action, body, {
      landed: function (b) {
        return orderKey(b) === key;
      },
      unsure: "Could not confirm that move. The order may not have changed for everyone.",
      settle: function (outcome) {
        // A state that arrived since is the server's own order already.
        if (outcome !== "refused" || board !== mine) return;
        reflow(function () {
          board.cards = was.map(function (w) {
            w.card.columnId = w.columnId;
            w.card.groupId = w.groupId;
            return w.card;
          });
          patchLanes();
          patchSelection();
        });
      },
    });
  }

  // Where `at` ends up when it goes up, down, to the top or to the bottom of
  // `count` places, or -1 when it is already there.
  function placeFor(at, count, way) {
    const to = way === "up" ? at - 1 : way === "down" ? at + 1 : way === "top" ? 0 : count - 1;
    if (to < 0 || to >= count || to === at) {
      setText(live, "Already at the " + (way === "up" || way === "top" ? "top" : "bottom") + ".");
      return -1;
    }
    return to;
  }

  // A note moves among the notes of its group, or among the items of its lane.
  function moveNote(id, way) {
    const card = cardById(id);
    if (!card) return;
    if (view.lanes[card.columnId].sorted) {
      notify(SORTED_OFF);
      return;
    }
    const group = card.groupId && groupById(card.groupId);
    const places = group ? membersOf(group.id) : itemsOf(card.columnId);
    const at = places.findIndex(function (p) {
      return p.id === id;
    });
    const to = placeFor(at, places.length, way);
    if (to === -1) return;
    // Going down, it is set in front of whatever follows its new neighbor.
    const before = places[to > at ? to + 1 : to];
    const body = { cardId: id };
    if (before) body.beforeId = before.id;
    const where = group ? "the group " + group.title : columnTitle(card.columnId);
    sendMove("move-card", body, "Moved " + way.replace("top", "to top").replace("bottom", "to bottom") + ". Position " + (to + 1) + " of " + places.length + " in " + where + ".");
  }

  function moveGroup(id, way) {
    const group = groupById(id);
    if (!group) return;
    if (view.lanes[group.columnId].sorted) {
      notify(SORTED_OFF);
      return;
    }
    const places = itemsOf(group.columnId);
    const at = places.findIndex(function (p) {
      return p.id === id;
    });
    const to = placeFor(at, places.length, way);
    if (to === -1) return;
    const before = places[to > at ? to + 1 : to];
    const body = { groupId: id };
    if (before) body.beforeId = before.id;
    sendMove("move-group", body, "Group " + group.title + " moved to position " + (to + 1) + " of " + plural(places.length, "item") + " in " + columnTitle(group.columnId) + ".");
  }

  // ------------------------------------------------------------------- drag

  // Dragging is the pointer's way to do what the menu and Alt+Arrow do. The
  // note itself stays in the list as an empty slot that shows where it would
  // land; a copy follows the pointer. State pushes wait until it is put down,
  // so a teammate's change cannot shuffle the lane under the hand.
  let drag = null;
  let heldState = null;

  function ownerOfNode(node) {
    for (const id in view.notes) if (view.notes[id].el === node) return id;
    for (const id in view.groups) if (view.groups[id].el === node || view.groups[id].list === node) return id;
    return null;
  }

  // Hear a pointer from a press until it is let go, wherever it goes. The
  // listeners are on the window because the thing pressed may itself be moved
  // in the document while it is dragged, which would drop them.
  function follow(move, stop) {
    const end = function (e) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stop(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  // Keep hearing the pointer if it leaves the frame mid-drag.
  function hold(ev) {
    if (main.setPointerCapture) main.setPointerCapture(ev.pointerId);
  }

  // A drag ends with a release, and a release on a button is a click. That
  // one click is not a request to open anything.
  function swallowClick(owner) {
    owner.dragged = true;
    setTimeout(function () {
      owner.dragged = false;
    }, 0);
  }

  function dragsNote(handle, id) {
    handle.addEventListener("pointerdown", function (ev) {
      const note = view.notes[id];
      if (ev.button || drag || !note) return;
      // On the note's body only a mouse drags, and never from a control: a
      // finger there is scrolling, and a press on a button is a press.
      if (handle === note.el) {
        if (ev.pointerType !== "mouse") return;
        for (let n = ev.target; n && n !== handle; n = n.parentNode) {
          if (/^(BUTTON|INPUT|LABEL)$/.test(n.tagName)) return;
        }
      }
      const start = { x: ev.clientX, y: ev.clientY };
      let over = false;
      follow(
        function (e) {
          if (over) return;
          if (!drag) {
            if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
            over = !lift(id, start);
            if (over) return;
            hold(ev);
          }
          e.preventDefault();
          dragTo(e.clientX, e.clientY);
        },
        function (e) {
          if (!drag || over) return;
          // The press that ends a drag is not a click on the handle.
          swallowClick(note);
          putDown(e.type === "pointerup");
        },
      );
    });
  }

  function lift(id, start) {
    const card = cardById(id);
    const node = view.notes[id].el;
    if (view.lanes[card.columnId].sorted) {
      notify(SORTED_OFF);
      return false;
    }
    closePop(false);
    const box = rectOf(node);
    const copy = node.cloneNode(true);
    copy.className = "note drag";
    copy.setAttribute("aria-hidden", "true");
    copy.style.width = box.width + "px";
    main.appendChild(copy);
    node.classList.add("slot");
    document.documentElement.classList.add("dragging");
    drag = { id: id, node: node, copy: copy, lane: view.lanes[card.columnId], dx: start.x - box.left, dy: start.y - box.top, lastX: start.x, tilt: 0, home: node.parentNode, next: node.nextElementSibling };
    return true;
  }

  function dragTo(x, y) {
    const lively = motionOn();
    // The copy leans into the direction it is being carried.
    drag.tilt += (Math.max(-4, Math.min(4, (x - drag.lastX) * 0.6)) - drag.tilt) * 0.25;
    drag.lastX = x;
    drag.copy.style.left = x - drag.dx + "px";
    drag.copy.style.top = y - drag.dy + "px";
    drag.copy.style.transform = lively ? "rotate(" + drag.tilt.toFixed(2) + "deg) scale(1.025)" : "";

    // Over a group, the slot goes among that group's notes; otherwise among
    // the lane's items. It sits in front of the first one the pointer is above.
    let home = drag.lane.list;
    for (const gid in view.groups) {
      const list = view.groups[gid].list;
      const box = rectOf(list);
      if (contains(drag.lane.list, list) && y >= box.top && y <= box.bottom) home = list;
    }
    let before = null;
    for (let i = 0; i < home.children.length && !before; i++) {
      const child = home.children[i];
      if (child === drag.node) continue;
      const box = rectOf(child);
      if (child.classList.contains("ghost") || y < box.top + box.height / 2) before = child;
    }
    if (drag.node.parentNode !== home || drag.node.nextElementSibling !== before) {
      reflow(function () {
        home.insertBefore(drag.node, before);
      });
    }
    if (y < 48) window.scrollBy(0, -12);
    else if (y > window.innerHeight - 48) window.scrollBy(0, 12);
  }

  function putDown(commit) {
    const d = drag;
    const from = rectOf(d.copy);
    const home = d.node.parentNode;
    const next = d.node.nextElementSibling;
    drag = null;
    main.removeChild(d.copy);
    d.node.classList.remove("slot");
    document.documentElement.classList.remove("dragging");
    if (heldState) {
      const waiting = heldState;
      heldState = null;
      onState(waiting);
    }
    if (commit && (home !== d.home || next !== d.next) && cardById(d.id)) {
      const groupId = home === d.lane.list ? null : ownerOfNode(home);
      const body = { cardId: d.id, groupId: groupId };
      const beforeId = next && ownerOfNode(next);
      if (beforeId) body.beforeId = beforeId;
      sendMove("move-card", body, function () {
        const places = groupId ? membersOf(groupId) : itemsOf(d.lane.id);
        const at = places.findIndex(function (p) {
          return p.id === d.id;
        });
        return "Moved. Position " + (at + 1) + " of " + places.length + " in " + (groupId ? "the group " + groupById(groupId).title : columnTitle(d.lane.id)) + ".";
      });
    } else {
      patchLanes();
    }
    // The note itself comes to rest from where the copy was let go.
    if (motionOn()) {
      const to = rectOf(d.node);
      animate(d.node, { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) rotate(" + d.tilt.toFixed(2) + "deg)", boxShadow: "var(--shadow-lift)" }, GLIDE);
    }
  }

  // ----------------------------------------------------------------- stamps

  // A stamp is pressed onto a note and stays where it was put: it sits over
  // the note, may hang over its edge, and takes up no room, so nothing moves
  // when one arrives. The state says what each stamp is and where, and never
  // who pressed it. Which ones are this viewer's own is known only from what
  // happened in this visit: a stamp that appeared exactly as it was sent, and
  // a move the server accepted or refused.
  const stampHelp = el("p", { id: "stamp-help", class: "sr-only", text: "Arrow keys move it. Delete removes it. Enter opens its options." });
  const mineStamps = {};
  const notMine = {};
  // Where a stamp has been put by this viewer, until the state agrees.
  const stampAt = {};
  let pressing = [];

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  // The size a note is taken to be when it cannot be measured.
  function noteBox(cardId) {
    const box = rectOf(view.notes[cardId].el);
    return { left: box.left, top: box.top, width: box.width || 240, height: box.height || 44 };
  }

  // Where a stamp lands when no spot is pointed at: along the bottom edge
  // from the right, clear of the text and of the stamps already there.
  function freeSpot(cardId) {
    const box = noteBox(cardId);
    const n = board.stamps.filter(function (s) {
      return s.cardId === cardId;
    }).length;
    const perRow = Math.max(1, Math.floor((box.width - 40) / 30));
    const cx = box.width - 20 - 30 * (n % perRow) - 15 * (Math.floor(n / perRow) % 2);
    return { x: round3(cx / box.width), y: round3((box.height - 2) / box.height) };
  }

  function isPress(s, wait) {
    const sent = wait.body;
    return !wait.had[s.id] && s.cardId === sent.cardId && s.kind === sent.kind && s.x === sent.x && s.y === sent.y && s.rot === sent.rot;
  }

  function pressStamp(cardId, kind) {
    const spot = freeSpot(cardId);
    // The tilt is the hand's: a little different every time.
    const wait = { had: idsOf(board.stamps), body: { cardId: cardId, kind: kind, x: spot.x, y: spot.y, rot: Math.round((Math.random() * 18 - 9) * 10) / 10 } };
    pressing.push(wait);
    propose("stamp", wait.body, {
      landed: function (b) {
        return b.stamps.some(function (s) {
          return isPress(s, wait);
        });
      },
      refused: { failed: "That stamp was not pressed. A note holds twelve stamps, three from each person." },
      unsure: "Could not confirm that the stamp was pressed.",
      settle: function (outcome) {
        if (outcome !== "refused") return;
        pressing = pressing.filter(function (other) {
          return other !== wait;
        });
      },
    });
  }

  function mayChange(id) {
    if (viewerRole() === "facilitator" || !notMine[id]) return true;
    notify(ONLY_PRESSER);
    return false;
  }

  // The facilitator moves and removes any stamp, through an action the host
  // keeps for the facilitator. Everyone else asks as themselves, and the
  // server answers no unless the stamp is theirs.
  function sendStamp(id, remove) {
    const lead = viewerRole() === "facilitator";
    const at = stampAt[id];
    const body = { stampId: id };
    if (remove && lead) body.remove = true;
    if (!remove) {
      body.x = at.x;
      body.y = at.y;
    }
    const watch = propose(lead ? "moderate-stamp" : remove ? "remove-stamp" : "move-stamp", body, {
      landed: function (b) {
        const now = b.stamps.filter(function (s) {
          return s.id === id;
        })[0];
        return remove ? !now : !now || (now.x === at.x && now.y === at.y);
      },
      refused: { failed: ONLY_PRESSER },
      unsure: remove ? "Could not confirm that the stamp was removed." : "Could not confirm that the stamp moved.",
      settle: function (outcome) {
        if (outcome === "accepted") mineStamps[id] = true;
        if (outcome !== "refused" && outcome !== "unsure") return;
        if (watch && watch.reason === "failed") notMine[id] = true;
        if (stampAt[id] === at) delete stampAt[id];
        patchStamps();
      },
    });
  }

  function nudgeStamp(id, dx, dy) {
    const s = stampById(id);
    if (!s || !mayChange(id)) return;
    const box = noteBox(s.cardId);
    const from = stampAt[id] || s;
    stampAt[id] = { x: round3(unit(from.x + (dx * STAMP_STEP) / box.width)), y: round3(unit(from.y + (dy * STAMP_STEP) / box.height)) };
    patchStamps();
    // Several presses of an arrow key are one move.
    const stamp = view.stamps[id];
    clearTimeout(stamp.timer);
    stamp.timer = setTimeout(function () {
      settleStamp(id);
    }, 500);
  }

  function settleStamp(id) {
    const stamp = view.stamps[id];
    const s = stampById(id);
    if (!stamp || !stamp.timer) return;
    clearTimeout(stamp.timer);
    stamp.timer = 0;
    if (s && stampAt[id] && (stampAt[id].x !== s.x || stampAt[id].y !== s.y)) sendStamp(id, false);
  }

  function removeStamp(id) {
    if (mayChange(id)) sendStamp(id, true);
  }

  function stampById(id) {
    return board.stamps.filter(function (s) {
      return s.id === id;
    })[0];
  }

  function buildStamp(s) {
    const id = s.id;
    const kind = STAMPS[s.kind];
    const stamp = { cardId: s.cardId, timer: 0, glyph: icon(kind.glyph) };
    stamp.btn = el("button", { type: "button", class: "stamp", "aria-describedby": "stamp-help", "aria-haspopup": "menu", style: "--hue:var(--color-" + kind.hue + ")" }, [stamp.glyph]);
    stamp.el = el("li", {}, [stamp.btn]);

    stamp.btn.addEventListener("keydown", function (ev) {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (step && !ev.altKey) nudgeStamp(id, step[0], step[1]);
      else if (ev.key === "Delete" || ev.key === "Backspace") removeStamp(id);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    stamp.btn.addEventListener("blur", function () {
      settleStamp(id);
    });
    toggles(stamp.btn, function () {
      if (stamp.dragged) return;
      const nudge = function (label, dx, dy) {
        return {
          label: label,
          stay: true,
          run: function () {
            nudgeStamp(id, dx, dy);
          },
        };
      };
      openMenu(stamp.btn, kind.label + " stamp", [
        nudge("Move left", -1, 0),
        nudge("Move right", 1, 0),
        nudge("Move up", 0, -1),
        nudge("Move down", 0, 1),
        {
          label: "Remove stamp",
          keys: "Delete",
          run: function () {
            removeStamp(id);
          },
        },
      ]);
    });
    // Dragging puts the stamp anywhere on its note. It follows the pointer
    // directly, and is sent once, when it is let go.
    stamp.btn.addEventListener("pointerdown", function (ev) {
      if (ev.button) return;
      ev.stopPropagation();
      const start = { x: ev.clientX, y: ev.clientY };
      let moved = false;
      let over = false;
      follow(
        function (e) {
          const now = stampById(id);
          if (!now || over) return;
          if (!moved) {
            if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
            over = !mayChange(id);
            if (over) return;
            moved = true;
            closePop(false);
            hold(ev);
            stamp.btn.classList.add("lift");
          }
          const box = noteBox(now.cardId);
          stampAt[id] = { x: round3(unit((e.clientX - box.left) / box.width)), y: round3(unit((e.clientY - box.top) / box.height)) };
          patchStamps();
        },
        function (e) {
          if (over) swallowClick(stamp);
          if (!moved) return;
          swallowClick(stamp);
          stamp.btn.classList.remove("lift");
          if (e.type !== "pointerup") delete stampAt[id];
          else {
            if (motionOn()) animate(stamp.btn, { transform: "scale(1.2)" }, SLAP);
            sendStamp(id, false);
          }
          patchStamps();
        },
      );
    });
    return stamp;
  }

  // The press: the stamp comes down from above the note, overshoots as it
  // meets the paper, the note gives under it, and the glyph settles. Each
  // part is a spring run to rest; the note is hit when the stamp arrives.
  function pressDown(stamp, s) {
    animate(stamp.btn, { transform: "translate(-10px,-30px) rotate(-22deg) scale(1.9)", opacity: 0.25 }, SLAP);
    const after = function (spring) {
      return Object.assign({}, spring, { delay: SLAP.hit, fill: "none" });
    };
    view.notes[s.cardId].el.animate([{ transform: "translateY(2.5px)" }, { transform: "none" }], after(NUDGE));
    stamp.glyph.animate([{ transform: STAMPS[s.kind].press }, { transform: "none" }], after(FLICK));
  }

  function patchStamps() {
    const kept = idsOf(board.stamps);
    const byNote = {};
    const fresh = [];
    let orphan = null;
    let claimed = null;
    for (const id in view.stamps) {
      if (kept[id]) continue;
      if (view.stamps[id].btn === document.activeElement) orphan = view.stamps[id].cardId;
      if (pop && pop.anchor === view.stamps[id].btn) closePop(false);
      clearTimeout(view.stamps[id].timer);
      delete stampAt[id];
    }
    board.stamps.forEach(function (s) {
      if (view.notes[s.cardId]) (byNote[s.cardId] = byNote[s.cardId] || []).push(s);
    });
    for (const cardId in view.notes) {
      const list = byNote[cardId] || [];
      const note = view.notes[cardId];
      sync(
        note.stamps,
        list.map(function (s, i) {
          let stamp = view.stamps[s.id];
          if (!stamp) {
            stamp = view.stamps[s.id] = buildStamp(s);
            fresh.push(s);
            const wait = pressing.filter(function (w) {
              return isPress(s, w);
            })[0];
            if (wait) {
              pressing.splice(pressing.indexOf(wait), 1);
              mineStamps[s.id] = true;
              claimed = stamp;
            }
          }
          const at = stampAt[s.id] || s;
          if (stampAt[s.id] && !stamp.timer && at.x === s.x && at.y === s.y) delete stampAt[s.id];
          stamp.btn.style.left = at.x * 100 + "%";
          stamp.btn.style.top = at.y * 100 + "%";
          stamp.btn.style.setProperty("--rot", s.rot + "deg");
          stamp.btn.classList.toggle("fixed", !!notMine[s.id] && viewerRole() !== "facilitator");
          stamp.btn.setAttribute("aria-label", STAMPS[s.kind].label + " stamp, " + (i + 1) + " of " + list.length + " on this note");
          return stamp.el;
        }),
      );
      note.stamps.hidden = list.length === 0;
    }
    forgetMissing(view.stamps, kept);
    if (orphan && view.notes[orphan]) leadOf(view.notes[orphan]).focus();
    // The stamp this viewer just pressed takes focus, so the arrow keys can
    // move it at once; unless they have already gone on to something else.
    if (claimed) {
      const held = document.activeElement;
      if (held === document.body || contains(view.notes[claimed.cardId].el, held)) claimed.btn.focus({ preventScroll: true });
    }
    if (!motionOn() || fresh.length > 3) return;
    fresh.forEach(function (s) {
      const stamp = view.stamps[s.id];
      if (stamp === claimed) pressDown(stamp, s);
      else animate(stamp.btn, { transform: "scale(.5)", opacity: 0 }, POP);
    });
  }

  function openStamps(cardId, opener) {
    const card = cardById(cardId);
    const choices = Object.keys(STAMPS).map(function (kind) {
      const choice = el("button", { type: "button", class: "stamp-choice" }, [
        el("span", { class: "stamp-face", style: "--hue:var(--color-" + STAMPS[kind].hue + ")" }, [icon(STAMPS[kind].glyph)]),
        el("span", { text: STAMPS[kind].label }),
      ]);
      choice.addEventListener("click", function () {
        closePop(true);
        pressStamp(cardId, kind);
      });
      return choice;
    });
    const grid = el("div", { class: "stamp-grid" }, choices);
    grid.addEventListener("keydown", function (ev) {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      const at = choices.indexOf(document.activeElement);
      choices[(at + step + choices.length) % choices.length].focus();
    });
    const sheet = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Stamps for: " + short(card.text) }, [
      el("p", { class: "label", text: "Press a stamp" }),
      grid,
      el("p", { class: "fine", text: "Nobody can see who pressed a stamp. Drag yours to move it, or use the arrow keys." }),
    ]);
    openPop(opener, sheet);
    choices[0].focus();
  }

  // ----------------------------------------------------------- lanes, drawn

  function noteEl(card) {
    return view.notes[card.id].el;
  }

  function forgetMissing(views, kept) {
    for (const id in views) if (!kept[id]) delete views[id];
  }

  function patchNotes() {
    const fresh = [];
    board.cards.forEach(function (card) {
      if (!view.notes[card.id]) {
        view.notes[card.id] = buildNote(card.id);
        fresh.push(view.notes[card.id]);
      }
      patchNote(view.notes[card.id], card);
    });
    const kept = idsOf(board.cards);
    forgetMissing(view.notes, kept);
    forgetMissing(selected, kept);
    // A handful of new notes each get set down. A flood (a reconnect, a paste
    // storm) simply appears.
    if (motionOn() && fresh.length <= 6) {
      fresh.forEach(function (note) {
        arrive(note.el);
      });
    }
  }

  function patchLanes() {
    board.columns.forEach(function (col) {
      const lane = view.lanes[col.id] || (view.lanes[col.id] = buildLane(col));
      const shared = itemsOf(col.id);
      const count = shared.reduce(function (sum, item) {
        return sum + item.cards.length;
      }, 0);
      const listed = (lane.sorted ? ranked(shared, lane.sorted) : shared).map(function (item) {
        if (!item.group) return noteEl(item.cards[0]);
        const group = view.groups[item.id] || (view.groups[item.id] = buildGroup(item.id));
        patchGroup(group, item);
        sync(group.list, item.cards.map(noteEl));
        return group.el;
      });
      const ghosts = lane.ghosts.map(function (ghost) {
        return ghost.el;
      });
      sync(lane.list, listed.concat(ghosts));

      setText(lane.title, col.title);
      setText(lane.label, "Add a note to " + col.title);
      lane.add.setAttribute("aria-label", "Add note to " + col.title);
      if (lane.count.textContent !== String(count)) {
        const first = lane.count.textContent === "";
        setText(lane.count, String(count));
        if (!first) tick(lane.count);
      }
      setText(lane.countWords, ", " + plural(count, "note"));
      lane.empty.hidden = count + ghosts.length > 0;
      lane.prompt.hidden = board.stage !== 0;

      // The lens is offered once there is something to rank by.
      const voted = shared.some(function (item) {
        return item.votes > 0;
      });
      lane.sortToggle.hidden = !lane.sorted && (shared.length < 2 || !(voted || board.stage >= 2));
      lane.sortToggle.setAttribute("aria-pressed", lane.sorted ? "true" : "false");
      lane.sortToggle.setAttribute("aria-label", "Most votes first in " + col.title + ", only for you");
      lane.sortToggle.setAttribute("title", "Most votes first, only for you");
      lane.sortLine.hidden = !lane.sorted;
      lane.resort.hidden = !lane.sorted || JSON.stringify(lane.sorted) === JSON.stringify(rankOf(shared));
      lane.share.hidden = viewerRole() === "participant";
      patchComposer(lane);
    });
    const columns = idsOf(board.columns);
    for (const id in view.lanes) if (!columns[id]) loseGhosts(view.lanes[id]);
    forgetMissing(view.lanes, columns);
    forgetMissing(view.groups, idsOf(board.groups));
    sync(
      lanes,
      board.columns.map(function (col) {
        return view.lanes[col.id].el;
      }),
    );
  }

  // ---------------------------------------------------------- selection bar

  const selectCount = el("span", { class: "select-count" });
  const selectReason = el("span", { class: "fine" });
  const groupTitle = el("input", { id: "group-title", class: "field", maxlength: TITLE_LIMIT, placeholder: "Name this group", dir: "auto" });
  const groupName = el("div", { class: "select-name" }, [
    el("label", { class: "sr-only", for: "group-title", text: "Group name" }),
    groupTitle,
  ]);
  const groupButton = el("button", { type: "button", class: "btn btn-primary", text: "Group" });
  const clearButton = el("button", { type: "button", class: "btn btn-quiet", text: "Clear" });
  const selectBar = el("section", { class: "select-bar", "aria-label": "Selected notes" }, [
    el("p", { class: "select-info" }, [selectCount, selectReason]),
    groupName,
    groupButton,
    clearButton,
  ]);
  let grouping = false;

  // board.js refuses a group of fewer than two notes, or of notes from more
  // than one lane. Both are settled here, before the button can be pressed,
  // and since a group cannot be renamed it has to be named first.
  function patchSelection() {
    const ids = selectedIds().filter(function (id) {
      return view.lanes[cardById(id).columnId];
    });
    const laneIds = {};
    ids.forEach(function (id) {
      laneIds[cardById(id).columnId] = true;
    });
    const laneCount = Object.keys(laneIds).length;
    const groupable = ids.length >= 2 && laneCount === 1;
    const named = !!groupTitle.value.trim();
    // A note shows its checkbox while notes are being picked: in the Group
    // stage, and whenever it is itself selected. Otherwise it shows its
    // handle, and the menu moves from the handle to the end of the note.
    const held = document.activeElement;
    for (const id in view.notes) {
      const note = view.notes[id];
      const picking = board.stage === 1 || !!selected[id];
      note.box.checked = !!selected[id];
      note.el.classList.toggle("selected", !!selected[id]);
      note.pick.hidden = !picking;
      note.grip.hidden = picking;
      note.more.hidden = !picking;
      if (held === note.grip && picking) note.more.focus();
      if ((held === note.more || held === note.box) && !picking) note.grip.focus();
    }
    selectBar.hidden = ids.length === 0;
    setText(selectCount, ids.length + " selected");
    if (laneCount > 1) setText(selectReason, "Groups stay inside one lane.");
    else if (ids.length < 2) setText(selectReason, "Select one more in the same lane.");
    else setText(selectReason, named ? "" : "Name the group.");
    groupName.hidden = !groupable;
    groupTitle.readOnly = grouping;
    groupButton.disabled = !groupable || !named || grouping;
    reserveForBar();
  }

  // The bar floats over the page, so the page keeps that much room at its
  // foot and the last thing on it can always be scrolled clear.
  function reserveForBar() {
    main.style.paddingBottom = selectBar.hidden ? "" : (selectBar.offsetHeight || 0) + 44 + "px";
  }

  function clearSelection() {
    const first = selectedIds()[0];
    selected = {};
    patchSelection();
    if (first) leadOf(view.notes[first]).focus();
  }

  function groupSelected() {
    if (groupButton.disabled) return;
    const ids = selectedIds();
    const had = idsOf(board.groups);
    const made = function (b) {
      return b.groups.filter(function (g) {
        return (
          !had[g.id] &&
          b.cards.some(function (c) {
            return c.groupId === g.id && c.id === ids[0];
          })
        );
      })[0];
    };
    grouping = true;
    propose("group-cards", { cardIds: ids, title: groupTitle.value.trim().slice(0, TITLE_LIMIT) }, {
      landed: made,
      unsure: "Could not confirm that the notes were grouped. They are still selected.",
      settle: function (outcome) {
        if (outcome === "accepted") return;
        grouping = false;
        const group = outcome === "landed" && made(board) && view.groups[made(board).id];
        if (outcome === "landed") {
          const heldFocus = contains(selectBar, document.activeElement);
          selected = {};
          groupTitle.value = "";
          patchSelection();
          if (heldFocus && group) group.title.focus();
          return;
        }
        patchSelection();
      },
    });
    patchSelection();
  }

  groupButton.addEventListener("click", groupSelected);
  clearButton.addEventListener("click", clearSelection);
  groupTitle.addEventListener("input", patchSelection);
  groupTitle.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.isComposing) groupSelected();
  });

  // ----------------------------------------------------------- action items

  const actionCount = el("span", { class: "count", "aria-hidden": "true" });
  const actionList = el("ul", { class: "action-list" });
  const actionEmpty = el("p", {
    class: "empty",
    text: "Nothing decided yet. When the notes settle, name one change and who owns it.",
  });
  const actionText = el("input", { id: "action-text", class: "field", maxlength: NOTE_LIMIT, dir: "auto" });
  const actionOwner = el("input", { id: "action-owner", class: "field", maxlength: OWNER_LIMIT, placeholder: "Me", dir: "auto" });
  const actionAdd = el("button", { type: "button", class: "btn btn-primary", text: "Add action" });
  const actionReopen = el("button", { type: "button", class: "reopen" }, [icon(GLYPH.plus), el("span", { text: "Add an action" })]);
  const actionForm = el("div", { class: "action-form" }, [
    el("div", { class: "stack" }, [el("label", { class: "label", for: "action-text", text: "Action" }), actionText]),
    el("div", { class: "stack narrow" }, [el("label", { class: "label", for: "action-owner", text: "Owner (optional)" }), actionOwner]),
    actionAdd,
  ]);
  const actions = el("section", { class: "actions panel", "aria-labelledby": "actions-title" }, [
    el("div", { class: "actions-head" }, [el("h2", { id: "actions-title", text: "What we will do about it" }), actionCount]),
    actionEmpty,
    actionList,
    el("div", { class: "action-foot" }, [actionReopen, actionForm]),
  ]);
  let addingAction = false;
  let actionOpen = false;

  // Hovering or focusing one end of a link outlines the other end.
  function lights(node, others) {
    const light = function (on) {
      return function () {
        others().forEach(function (other) {
          if (other) other.classList.toggle("lit", on);
        });
      };
    };
    node.addEventListener("mouseenter", light(true));
    node.addEventListener("focus", light(true));
    node.addEventListener("mouseleave", light(false));
    node.addEventListener("blur", light(false));
  }

  // The note or group an action came from: where it is drawn, the control to
  // put focus on, and what to call it.
  function sourceOf(id) {
    const card = cardById(id);
    const group = groupById(id);
    if (card && view.notes[id]) return { el: view.notes[id].el, focus: leadOf(view.notes[id]), kind: "note", name: card.text, lane: card.columnId };
    if (group && view.groups[id]) return { el: view.groups[id].el, focus: view.groups[id].grip, kind: "group", name: group.title, lane: group.columnId };
    return null;
  }

  // Going to a source puts focus on it and rings it until the next key or
  // press, so the eye finds what the keyboard already has.
  let spot = null;

  function clearSpot() {
    if (spot) spot.classList.remove("spot");
    spot = null;
  }

  function goTo(id) {
    const source = sourceOf(id);
    if (!source) return;
    source.focus.focus();
    if (source.el.scrollIntoView) source.el.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" });
    source.el.classList.add("spot");
    if (motionOn()) animate(source.el, { transform: "translateY(2px)" }, NUDGE);
    // Set after this event has finished, so the press that asked for it
    // does not also clear it.
    setTimeout(function () {
      spot = source.el;
    }, 0);
  }

  function buildSource(id) {
    const chip = { glyph: null, text: el("span", { dir: "auto" }) };
    chip.btn = el("button", { type: "button", class: "src" }, [chip.text]);
    chip.el = el("li", {}, [chip.btn]);
    chip.btn.addEventListener("click", function () {
      goTo(id);
    });
    lights(chip.btn, function () {
      const source = sourceOf(id);
      return [source && source.el];
    });
    return chip;
  }

  function buildAction() {
    const row = {
      text: el("p", { class: "action-text", dir: "auto" }),
      owner: buildPerson(),
      sources: el("ul", { class: "sources", "aria-label": "From" }),
      more: el("button", { type: "button", class: "src" }),
      chips: {},
      wide: false,
    };
    row.moreItem = el("li", {}, [row.more]);
    row.el = el("li", { class: "action" }, [row.text, row.sources, row.owner.el]);
    row.more.addEventListener("click", function () {
      row.wide = true;
      patchActions();
      const last = row.sources.lastChild;
      if (last) last.children[0].focus();
    });
    return row;
  }

  // Up to two of the notes an action came from are shown; the rest open in
  // place. A source that has left the board is simply not drawn.
  function patchSources(row, item) {
    const sources = item.sourceIds.filter(sourceOf);
    const shown = row.wide ? sources : sources.slice(0, 2);
    const listed = shown.map(function (id) {
      const chip = row.chips[id] || (row.chips[id] = buildSource(id));
      const source = sourceOf(id);
      const meta = LANES[source.lane] || OTHER_LANE;
      if (chip.lane !== source.lane) {
        if (chip.glyph) chip.btn.removeChild(chip.glyph);
        chip.glyph = icon(meta.glyph);
        chip.btn.insertBefore(chip.glyph, chip.text);
        chip.btn.setAttribute("style", "--hue:var(--color-" + meta.hue + ")");
        chip.lane = source.lane;
      }
      setText(chip.text, source.kind === "group" ? "Group: " + source.name : source.name);
      chip.btn.setAttribute("aria-label", "From " + source.kind + ": " + short(source.name) + ". Go to " + source.kind + ".");
      return chip.el;
    });
    if (sources.length > shown.length) {
      setText(row.more, "+" + (sources.length - shown.length) + " more");
      row.more.setAttribute("aria-label", "Show " + plural(sources.length - shown.length, "more source"));
      listed.push(row.moreItem);
    }
    sync(row.sources, listed);
    row.sources.hidden = listed.length === 0;
  }

  function patchActions() {
    const fresh = [];
    const listed = board.actionItems.map(function (item) {
      if (!view.actions[item.id]) {
        view.actions[item.id] = buildAction();
        fresh.push(view.actions[item.id]);
      }
      const row = view.actions[item.id];
      setText(row.text, item.text);
      showPerson(row.owner, ownerOf(item.owner));
      patchSources(row, item);
      return row.el;
    });
    forgetMissing(view.actions, idsOf(board.actionItems));
    sync(actionList, listed);
    actionEmpty.hidden = listed.length > 0;
    setText(actionCount, listed.length ? String(listed.length) : "");
    if (motionOn()) {
      fresh.forEach(function (row) {
        animate(row.el, { transform: "translateY(-10px)", opacity: 0 }, GLIDE);
      });
    }
  }

  // Outside the Decide stage an idle form steps back behind "Add an action",
  // the way a lane's composer does; an action can still be added in any stage.
  function patchActionForm() {
    const idle = !actionText.value && !actionOwner.value && !actionOpen && !contains(actionForm, document.activeElement);
    actionForm.hidden = board.stage !== 3 && idle;
    actionReopen.hidden = !actionForm.hidden;
    actions.classList.toggle("deciding", board.stage === 3);
    actionText.readOnly = addingAction;
    actionOwner.readOnly = addingAction;
    actionAdd.disabled = addingAction || !actionText.value.trim();
  }

  // The fields are held as they are while the action is on its way, so what
  // was typed is what gets cleared, and a refusal costs nothing.
  function addAction() {
    const text = actionText.value.trim().slice(0, NOTE_LIMIT);
    if (!text || addingAction) return;
    const had = idsOf(board.actionItems);
    addingAction = true;
    propose("add-action", { text: text, owner: actionOwner.value.trim() }, {
      landed: function (b) {
        return b.actionItems.some(function (a) {
          return !had[a.id] && a.text === text;
        });
      },
      unsure: "Could not confirm that the action was saved. It is still in the box.",
      settle: function (outcome) {
        if (outcome === "accepted") return;
        addingAction = false;
        if (outcome === "landed") {
          const heldFocus = contains(actions, document.activeElement);
          actionText.value = "";
          actionOwner.value = "";
          if (heldFocus) actionText.focus();
        }
        patchActionForm();
      },
    });
    patchActionForm();
  }

  actionText.addEventListener("input", patchActionForm);
  [actionText, actionOwner].forEach(function (input) {
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.isComposing) addAction();
    });
  });
  actionAdd.addEventListener("click", addAction);
  actionReopen.addEventListener("click", function () {
    actionOpen = true;
    patchActionForm();
    actionText.focus();
  });
  [actionText, actionOwner].forEach(function (input) {
    input.addEventListener("blur", function () {
      actionOpen = false;
      // Focus may be on its way to the other field or to the button.
      setTimeout(patchActionForm, 0);
    });
  });

  // ------------------------------------------------------------------ links

  // An action can be started from a note or a group, and tied to more of
  // them afterwards. This is the one place that is done: a small form that
  // hangs from the target on the note, with every action listed under it.
  function openLinks(sourceId, opener) {
    const source = sourceOf(sourceId);
    const text = el("input", { id: "link-text", class: "field", maxlength: NOTE_LIMIT, placeholder: "What will we change?", dir: "auto" });
    const owner = el("input", { id: "link-owner", class: "field", maxlength: OWNER_LIMIT, placeholder: "Me", dir: "auto" });
    const add = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Add action" });
    const cancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Cancel" });
    const list = el("ul", { class: "link-list" });
    const listLabel = el("p", { class: "label", text: "Or tie it to an action already here" });
    const rows = {};
    const panel = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Actions from " + source.kind + ": " + short(source.name) }, [
      el("p", { class: "from", dir: "auto", text: (source.kind === "group" ? "Group: " : "From: ") + short(source.name) }),
      el("div", { class: "stack" }, [el("label", { class: "label", for: "link-text", text: "Action" }), text]),
      el("div", { class: "stack" }, [el("label", { class: "label", for: "link-owner", text: "Owner (optional)" }), owner]),
      el("div", { class: "row" }, [add, cancel]),
      listLabel,
      list,
    ]);
    let adding = false;

    const linkedTo = function (item) {
      return item.sourceIds.indexOf(sourceId) !== -1;
    };
    const patch = function () {
      add.disabled = adding || !text.value.trim();
      text.readOnly = owner.readOnly = adding;
      listLabel.hidden = board.actionItems.length === 0;
      sync(
        list,
        board.actionItems.map(function (item) {
          let row = rows[item.id];
          if (!row) {
            row = rows[item.id] = { text: el("span", { dir: "auto" }), btn: el("button", { type: "button", class: "btn btn-quiet btn-small" }) };
            row.el = el("li", {}, [row.text, row.btn]);
            row.btn.addEventListener("click", function () {
              const now = board.actionItems.filter(function (a) {
                return a.id === item.id;
              })[0];
              if (!now) return;
              const want = !linkedTo(now);
              propose("link-action", { actionId: item.id, sourceId: sourceId, linked: want }, {
                landed: function (b) {
                  return b.actionItems.some(function (a) {
                    return a.id === item.id && linkedTo(a) === want;
                  });
                },
                refused: { failed: "That link was not made. An action holds twelve links." },
                unsure: "Could not confirm that link.",
              });
            });
          }
          const on = linkedTo(item);
          setText(row.text, item.text);
          setText(row.btn, on ? "Remove link" : "Link");
          row.btn.setAttribute("aria-label", (on ? "Remove the link to action: " : "Link to action: ") + short(item.text));
          return row.el;
        }),
      );
    };
    const submit = function () {
      const words = text.value.trim().slice(0, NOTE_LIMIT);
      if (!words || adding) return;
      const had = idsOf(board.actionItems);
      adding = true;
      propose("add-action", { text: words, owner: owner.value.trim(), sourceIds: [sourceId] }, {
        landed: function (b) {
          return b.actionItems.some(function (a) {
            return !had[a.id] && a.text === words;
          });
        },
        unsure: "Could not confirm that the action was saved. It is still in the box.",
        settle: function (outcome) {
          if (outcome === "accepted") return;
          adding = false;
          if (outcome === "landed" && pop && pop.el === panel) closePop(true);
          else patch();
        },
      });
      patch();
    };
    text.addEventListener("input", patch);
    [text, owner].forEach(function (input) {
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.isComposing) submit();
      });
    });
    add.addEventListener("click", submit);
    cancel.addEventListener("click", function () {
      closePop(true);
    });
    patch();
    openPop(opener, panel, patch);
    text.focus();
  }

  // ------------------------------------------------------------------ shell

  // No h1: the frame sits under the host page's own, and a screen reader reads
  // the two documents as one outline. The lanes and the actions are its h2s.
  const main = el("main", { class: "board", "aria-label": "Retrospective board" }, [
    el("div", { class: "top" }, [
      el("section", { class: "progress", "aria-label": "Stage" }, [
        el("div", { class: "steps-wrap" }, [
          thumb,
          el(
            "ol",
            { class: "steps" },
            stepViews.map(function (v) {
              return v.el;
            }),
          ),
        ]),
        timerSlot,
        el("div", { class: "hints" }, hints),
        stageNav,
      ]),
      authorship,
    ]),
    el("div", { class: "main" }, [lanes, actions]),
    el("div", { class: "dock" }, [el("div", { role: "status" }, [toast]), selectBar]),
    layer,
    stampHelp,
  ]);

  // A host that sends the scheme has already set color-scheme on the root. An
  // older one sends only colors, and the surface token says which theme it is.
  function applyScheme(tokens) {
    let scheme = typeof parley.scheme === "function" ? parley.scheme() : null;
    if (scheme !== "light" && scheme !== "dark") {
      const hex = /^#([0-9a-f]{6})$/i.exec((tokens && tokens.surface) || "");
      if (!hex) return;
      const n = parseInt(hex[1], 16);
      const luminance = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      scheme = luminance < 0.5 ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-scheme", scheme);
  }

  function onState(next) {
    // null means the viewer is in a room this plugin does not provide.
    if (!next) return;
    if (drag) {
      heldState = next;
      return;
    }
    const before = board;
    const named = board.revealed
      ? board.cards
          .map(function (c) {
            return view.notes[c.id];
          })
          .filter(function (note) {
            return note && !note.author.el.hidden;
          })
      : [];
    const wasFocused = document.activeElement;
    const boxes = motionOn() ? measure() : null;

    session = next;
    board = boardOf(next);
    if (drawn && before.revealed && !board.revealed) hiddenAgain = true;
    patchProgress();
    patchNotes();
    patchStamps();
    patchLanes();
    patchActions();
    patchActionForm();
    patchAuthorship();
    patchSelection();
    patchTimer();
    if (pop && pop.patch) pop.patch();
    // The board is first shown with its content already in it, so nothing
    // jumps into place a moment after it appears.
    if (!drawn) root.appendChild(main);
    placeThumb(before.stage !== board.stage);
    settleLanded();
    reconcileGhosts();
    sendNext();

    // Moving a node drops its focus. Nothing a teammate does may take focus
    // away or scroll the page, so it goes back, quietly, to whatever held it.
    if (wasFocused && wasFocused !== document.activeElement && wasFocused.isConnected && document.activeElement === document.body) {
      wasFocused.focus({ preventScroll: true });
    }
    if (boxes) glideFrom(boxes);
    if (motionOn() && board.revealed && !before.revealed) revealWave();
    if (motionOn() && !board.revealed && before.revealed) concealWave(named);
    if (drawn) setText(live, describeChanges(before, board));
    drawn = true;
  }

  document.addEventListener("keydown", function (ev) {
    clearSpot();
    if (ev.key !== "Escape") return;
    if (drag) putDown(false);
    else if (pop) closePop(true);
    else if (armed) arm(false);
    else if (selectedIds().length) clearSelection();
  });
  document.addEventListener("pointerdown", function (ev) {
    clearSpot();
    if (pop && !contains(pop.el, ev.target) && !contains(pop.anchor, ev.target)) closePop(false);
  });
  window.addEventListener("resize", function () {
    reserveForBar();
    placeThumb(false);
    closePop(false);
  });
  // The step pill is measured, and the measure changes when the faces load.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      placeThumb(false);
    });
  }

  document.head.appendChild(el("style", { text: fontFaces() + STYLES }));
  // A live region is only listened to if it was there before its first
  // message, so it is mounted now and the board joins it with the first state.
  root.appendChild(live);
  patchProgress();
  patchTimer();
  patchAuthorship();
  patchActionForm();
  patchSelection();
  parley.onTokens(applyScheme);
  parley.onState(onState);
  parley.ready();
})();
