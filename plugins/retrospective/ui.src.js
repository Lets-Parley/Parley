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
  };

  // A lane is told apart by its glyph and its title; the hue only agrees.
  const LANES = {
    "went-well": { hue: "go", glyph: GLYPH.wentWell, prompt: "What made the sprint better?", empty: "No wins written down yet." },
    "to-improve": { hue: "brass", glyph: GLYPH.toImprove, prompt: "What slowed us down?", empty: "Nothing flagged yet." },
    puzzles: { hue: "settled", glyph: GLYPH.puzzles, prompt: "What are we still unsure about?", empty: "No open questions yet." },
  };
  const OTHER_LANE = { hue: "accent", glyph: GLYPH.other, prompt: "What belongs here?", empty: "No notes yet." };

  const STEPS = ["Write", "Group", "Vote", "Decide"];
  const HINTS = {
    blank: "Write what went well, what to improve and what still puzzles you.",
    0: "Keep writing. When it slows down, select notes that belong together and group them.",
    1: "Vote for the notes that matter most. Each person has one vote per note.",
    2: "When the votes settle, agree on what to change and write it down as an action.",
    3: "Decide what changes, and who owns it.",
  };

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
    ".steps,.authorship,.lane,.actions,.select-bar,.toast{font-size:14px;line-height:20px}",
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
    ".progress{flex:1 1 24rem;min-width:0;padding:12px 16px;border:1px solid var(--color-line);border-radius:20px;background:var(--color-felt-deep)}",
    ".steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px}",
    ".step{display:flex;align-items:center;gap:6px;min-height:32px;padding:0 12px 0 8px;border-radius:999px;font-weight:700;color:var(--color-ink-faint)}",
    ".step.reached{color:var(--color-ink)}",
    ".step.current{background:var(--color-accent-soft);color:var(--color-ink)}",
    ".step-mark{display:grid;place-items:center;width:16px;font:11px var(--mono);color:var(--color-ink-faint)}",
    ".step svg,.badge svg{color:var(--color-go)}",
    ".hint{margin:6px 8px 0;max-width:65ch;color:var(--color-ink-soft);text-wrap:pretty}",
    ".authorship{flex:0 1 27rem;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0;padding:12px 16px 12px 20px}",
    ".auth-text{flex:1 1 11rem;min-width:0}",
    // The confirmation needs more room than the resting control. It takes it
    // sideways, from the progress strip, so the board below does not move.
    ".authorship.armed{flex-basis:36rem}",
    ".auth-title{font-size:15px;font-weight:700;text-wrap:pretty}",
    ".brass-dot{width:10px;height:10px;border-radius:50%;background:var(--color-brass)}",
    ".badge{display:inline-flex;align-items:center;gap:6px;font-weight:700}",

    ".main{flex:1;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}",
    ".lanes{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}",
    "@media (min-width:860px){.lanes{grid-template-columns:repeat(3,minmax(0,1fr))}}",
    ".lane{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px}",
    ".lane-head{display:flex;align-items:flex-start;gap:10px}",
    ".lane-title{flex:1;min-width:0}",
    ".prompt{font-size:13px;line-height:18px;color:var(--color-ink-soft);text-wrap:pretty}",
    ".lane-glyph{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:var(--hue);background:color-mix(in srgb,var(--hue) 14%,transparent)}",
    ".count{display:inline-block;margin-left:auto;font:12px/24px var(--mono);font-variant-numeric:tabular-nums;color:var(--color-ink-faint)}",
    ".composer-row{display:flex;align-items:flex-end;gap:8px}",
    ".composer-row .btn{padding:11px 18px}",
    ".reopen{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 12px;border:1px dashed var(--color-line-strong);border-radius:8px;background:transparent;color:var(--color-ink-soft);font-weight:700;transition:background-color .15s}",
    ".reopen:hover{background:var(--color-felt-deep)}",
    ".left{margin-top:6px;font-size:13px;color:var(--color-ink-faint)}",
    ".empty{font-size:13px;color:var(--color-ink-faint);text-wrap:pretty}",

    ".notes{display:flex;flex-direction:column;gap:8px}",
    ".note{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:start;column-gap:6px;padding:5px 8px 5px 4px;background:var(--color-surface-hi);border:1px solid var(--color-line);border-radius:14px;box-shadow:var(--shadow-rest);transition:background-color .15s,border-color .15s}",
    ".note.selected{background:var(--color-accent-soft);border-color:var(--color-accent);box-shadow:0 0 0 1px var(--color-accent),var(--shadow-rest)}",
    ".pick{display:grid;place-items:center;width:28px;height:32px;cursor:pointer}",
    ".pick input{appearance:none;display:grid;place-items:center;width:14px;height:14px;margin:0;border:1px solid var(--color-line-strong);border-radius:4px;background:transparent;cursor:pointer;transition:background-color .15s,border-color .15s}",
    ".pick input:checked{border-color:var(--color-accent);background:var(--color-accent)}",
    '.pick input:checked::after{content:"";width:4px;height:7px;margin-top:-2px;border:solid var(--color-accent-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}',
    ".note-text{padding:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".person{grid-column:2/-1;display:flex;align-items:center;gap:8px;min-width:0;padding-bottom:5px;font-size:13px;color:var(--color-ink-soft)}",
    ".person-name{min-width:0;overflow-wrap:anywhere}",
    ".disc{flex:none;display:grid;place-items:center;width:24px;height:24px;margin:3px;border-radius:50%;font-size:9px;font-weight:700;color:#F4F8FB;background:#3F5466;box-shadow:0 0 0 2px var(--color-surface-hi),0 0 0 3px var(--color-line)}",
    ".vote{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--color-line-strong);border-radius:999px;background:transparent;color:var(--color-ink-soft);font-size:13px;font-weight:700;transition:background-color .15s,border-color .15s}",
    ".vote:hover{background:var(--color-felt-deep)}",
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
    ".group-head{margin:2px 6px 8px}",
    "h3{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:14px;font-weight:700;line-height:20px;overflow-wrap:anywhere}",
    ".group-meta{font:11px/16px var(--mono);color:var(--color-ink-faint)}",

    ".actions{min-width:0;padding:16px 20px 20px}",
    ".actions-head{display:flex;align-items:baseline;gap:10px}",
    ".action-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}",
    ".action{padding:8px 12px;border:1px solid var(--color-line);border-radius:14px}",
    ".action-text{font-weight:700;overflow-wrap:anywhere}",
    ".action .person{padding:4px 0 0}",
    ".actions .empty{margin-top:8px}",
    ".action-form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--color-line)}",
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

    "@media (pointer:coarse){.btn,.vote{min-height:44px}.pick{width:36px;height:44px}.note{grid-template-columns:36px minmax(0,1fr) auto}.note-text{padding:12px 0}}",

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

  function boardOf(next) {
    const b = next && typeof next.state === "object" && next.state ? next.state : {};
    return {
      revealed: b.revealed === true,
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
        return { id: a.id, text: words(a.text), owner: words(a.owner) };
      }),
    };
  }

  const view = { lanes: {}, notes: {}, groups: {}, actions: {} };
  let session = null;
  let board = boardOf(null);
  let drawn = false;
  let selected = {};

  function cardById(id) {
    return board.cards.filter(function (c) {
      return c.id === id;
    })[0];
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
    while (step < 480 && (Math.abs(1 - x) > 0.001 || Math.abs(v) > 0.01)) {
      v += (stiffness * (1 - x) - damping * v) * dt;
      x += v * dt;
      if (step % 4 === 0) points.push(x.toFixed(3));
      step += 1;
    }
    points.push(1);
    const linear = !!window.CSS && window.CSS.supports("animation-timing-function", "linear(0,1)");
    return {
      duration: Math.round(step * dt * 1000),
      easing: linear ? "linear(" + points.join(",") + ")" : "cubic-bezier(0.22,1,0.36,1)",
      fill: "backwards",
    };
  }
  const POP = spring(380, 22);
  const GLIDE = spring(260, 30);
  const TICK = spring(900, 44);

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
    for (const id in view.notes) boxes[id] = view.notes[id].el.getBoundingClientRect();
    return boxes;
  }

  // Notes that changed place glide there from where they were.
  function glideFrom(before) {
    for (const id in before) {
      const note = view.notes[id];
      if (!note || note.el.classList.contains("arriving")) continue;
      const now = note.el.getBoundingClientRect();
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
    const item = { landed: how.landed, settle: how.settle || function () {}, unsure: how.unsure, forbidden: how.forbidden };
    hideToast();
    watching.push(item);
    item.timer = setTimeout(function () {
      expire(item);
    }, WAIT_MS);
    const answer = parley.act(action, payload);
    if (answer && typeof answer.then === "function") {
      answer.then(function (result) {
        hear(item, result);
      });
    }
    return item;
  }

  function hear(item, result) {
    if (watching.indexOf(item) === -1 || item.expired || !result) return;
    if (result.ok === true) {
      item.accepted = true;
      item.settle("accepted");
      return;
    }
    if (result.reason === "unknown") return;
    const message = (result.reason === "forbidden" && item.forbidden) || REFUSALS[result.reason] || REFUSALS.failed;
    forget(item);
    item.settle("refused");
    notify(message);
  }

  function expire(item) {
    if (item.accepted) {
      forget(item);
      item.settle("landed");
      return;
    }
    item.expired = true;
    item.settle("unsure");
    item.notice = notify(item.unsure);
    item.timer = setTimeout(function () {
      forget(item);
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

    const hadActions = idsOf(before.actionItems);
    after.actionItems.forEach(function (a) {
      if (!hadActions[a.id]) said.push("New action: " + short(a.text) + ".");
    });
    return said.join(" ");
  }

  // --------------------------------------------------------------- progress

  const hint = el("p", { class: "hint" });
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

  // The strip reports what the board already holds and gates nothing. A step
  // is reached when there is evidence of it; revealing authors is not a step.
  function progressOf(b) {
    const grouped = b.cards.some(function (c) {
      return c.groupId;
    });
    const voted = b.cards.some(function (c) {
      return c.votes > 0;
    });
    const reached = [b.cards.length > 0, grouped, voted, b.actionItems.length > 0];
    return { reached: reached, current: Math.max(0, reached.lastIndexOf(true)) };
  }

  function patchProgress() {
    const progress = progressOf(board);
    stepViews.forEach(function (v, i) {
      const current = i === progress.current;
      const done = progress.reached[i] && !current;
      v.el.className = "step" + (current ? " current" : done ? " reached" : "");
      if (current) v.el.setAttribute("aria-current", "step");
      else v.el.removeAttribute("aria-current");
      v.number.hidden = done;
      v.check.hidden = !done;
      setText(v.status, current ? ", current" : done ? ", done" : "");
    });
    setText(hint, board.cards.length ? HINTS[progress.current] : HINTS.blank);
    return progress;
  }

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
  const revealDone = el("p", { class: "badge" }, [icon(GLYPH.check), el("span", { text: "Authors visible" })]);
  const authText = el("div", { class: "auth-text" }, [authTitle, authLine]);
  const authorship = el("section", { class: "authorship panel", "aria-label": "Authorship" }, [
    authText,
    revealButton,
    revealArmed,
    revealDone,
  ]);
  let armed = false;
  let revealing = false;

  function onlyFacilitator() {
    const who = facilitator();
    return "Only the facilitator" + (who ? ", " + who.name + "," : "") + " can reveal authors.";
  }

  // The server decides who may reveal. What is shown follows what the frame
  // knows: the facilitator gets the control, everyone else is told who holds
  // it, and a host that does not say who is looking gets both.
  function patchAuthorship() {
    const role = viewerRole();
    const who = facilitator();
    const offered = !board.revealed && role !== "participant" && board.cards.length > 0;
    if (!offered) armed = false;
    authorship.classList.toggle("armed", armed);

    authText.hidden = board.revealed;
    revealDone.hidden = !board.revealed;
    revealButton.hidden = !offered || armed;
    revealArmed.hidden = !offered || !armed;
    revealConfirm.disabled = revealing;
    setText(revealConfirm, revealing ? "Revealing…" : "Reveal to everyone");

    if (armed) {
      setText(authTitle, "Show everyone who wrote each note?");
      setText(authLine, "This cannot be undone.");
    } else {
      setText(authTitle, "Notes are anonymous");
      if (role === "facilitator") setText(authLine, "Only you can reveal who wrote them.");
      else if (role === "unknown") setText(authLine, onlyFacilitator());
      else setText(authLine, (who ? who.name + ", the facilitator," : "The facilitator") + " reveals authors when the room is ready.");
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
      forbidden: onlyFacilitator(),
      unsure: "Could not confirm the reveal. " + onlyFacilitator(),
      settle: function (outcome) {
        if (outcome === "accepted") return;
        revealing = false;
        if (outcome !== "landed" && armed) arm(false);
        else patchAuthorship();
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

  // ------------------------------------------------------------------ lanes

  const lanes = el("div", { class: "lanes" });
  let deciding = false;

  function buildLane(col) {
    const meta = LANES[col.id] || OTHER_LANE;
    const headingId = "lane-" + col.id;
    const inputId = "note-" + col.id;
    const lane = {
      id: col.id,
      open: false,
      ghosts: [],
      title: el("h2", { id: headingId, dir: "auto" }),
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
    lane.el = el("section", { class: "lane panel", "aria-labelledby": headingId, style: "--hue:var(--color-" + meta.hue + ")" }, [
      el("div", { class: "lane-head" }, [
        el("span", { class: "lane-glyph" }, [icon(meta.glyph)]),
        el("div", { class: "lane-title" }, [lane.title, el("p", { class: "prompt", text: meta.prompt })]),
        lane.count,
        lane.countWords,
      ]),
      el("div", { class: "composer" }, [lane.label, lane.row, lane.reopen, lane.left]),
      lane.empty,
      lane.list,
    ]);

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

  // One row that grows with what is typed. Once the board has moved on to
  // deciding, an idle composer steps back behind "Add a note"; both are the
  // same height, so nothing moves when it does.
  function patchComposer(lane) {
    const input = lane.input;
    const idle = !input.value && !lane.open && document.activeElement !== input;
    const room = NOTE_LIMIT - input.value.length;
    lane.row.hidden = deciding && idle;
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
    if (sending === ghost) sending = null;
    ghost.lane.ghosts = ghost.lane.ghosts.filter(function (other) {
      return other !== ghost;
    });
    patchLanes();
    sendNext();
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
    const had = idsOf(board.cards);
    sending = next;
    next.status = "saving";
    patchGhost(next);
    next.watch = propose("add-card", { columnId: next.lane.id, text: next.text }, {
      landed: function (b) {
        return b.cards.some(function (c) {
          return !had[c.id] && c.columnId === next.lane.id && c.text === next.text;
        });
      },
      unsure: "Could not confirm that your note was saved. It is waiting in its lane.",
      settle: function (outcome) {
        if (outcome === "accepted") return;
        if (sending === next) sending = null;
        if (outcome === "landed") {
          dropGhost(next);
          return;
        }
        next.status = outcome;
        patchGhost(next);
        sendNext();
      },
    });
  }

  // ------------------------------------------------------------------ notes

  function buildNote(id) {
    const note = {
      votes: null,
      mine: false,
      voting: false,
      box: el("input", { type: "checkbox" }),
      text: el("p", { class: "note-text", dir: "auto" }),
      author: buildPerson(),
      vote: el("button", { type: "button", class: "vote" }),
      word: el("span", { text: "Vote" }),
      count: el("span", { class: "mono" }),
    };
    note.vote.appendChild(el("span", { class: "vote-dot", "aria-hidden": "true" }));
    note.vote.appendChild(note.word);
    note.vote.appendChild(note.count);
    note.el = el("li", { class: "note" }, [el("label", { class: "pick" }, [note.box]), note.text, note.vote, note.author.el]);

    note.box.addEventListener("change", function () {
      selected[id] = note.box.checked;
      patchSelection();
    });
    note.vote.addEventListener("click", function () {
      castVote(id);
    });
    return note;
  }

  // The vote control is quiet until a note has votes: "Vote" at zero, the
  // count once there is one. It is marked as the viewer's own only when the
  // host has said so.
  function patchNote(note, card) {
    setText(note.text, card.text);
    note.box.setAttribute("aria-label", "Select note: " + short(card.text));
    note.vote.setAttribute(
      "aria-label",
      "Vote for: " + short(card.text) + ". " + plural(card.votes, "vote") + "." + (note.mine ? " You voted." : ""),
    );
    if (note.mine) note.vote.setAttribute("aria-pressed", "true");
    note.vote.classList.toggle("has-votes", card.votes > 0);
    note.word.hidden = card.votes > 0;
    note.count.hidden = card.votes === 0;
    if (note.votes !== card.votes) {
      setText(note.count, String(card.votes));
      if (note.votes !== null && card.votes > 0) tick(note.count);
      note.votes = card.votes;
    }
    const named = board.revealed && card.authorId;
    note.author.el.hidden = !named;
    if (named) showPerson(note.author, personById(card.authorId));
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

  function buildGroup() {
    const group = {
      title: el("h3", { tabindex: -1, dir: "auto" }),
      meta: el("p", { class: "group-meta" }),
      list: el("ul", { class: "notes" }),
    };
    group.el = el("li", { class: "group" }, [el("div", { class: "group-head" }, [group.title, group.meta]), group.list]);
    return group;
  }

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
      const cards = board.cards.filter(function (c) {
        return c.columnId === col.id;
      });
      const listed = [];
      const placed = {};
      board.groups.forEach(function (g) {
        const members = cards.filter(function (c) {
          return c.groupId === g.id;
        });
        if (g.columnId !== col.id || !members.length) return;
        const group = view.groups[g.id] || (view.groups[g.id] = buildGroup());
        const votes = members.reduce(function (sum, c) {
          return sum + c.votes;
        }, 0);
        setText(group.title, g.title);
        group.title.setAttribute("title", g.title);
        setText(group.meta, plural(members.length, "note") + " · " + plural(votes, "vote"));
        members.forEach(function (c) {
          placed[c.id] = true;
        });
        sync(group.list, members.map(noteEl));
        listed.push(group.el);
      });
      const loose = cards.filter(function (c) {
        return !placed[c.id];
      });
      const ghosts = lane.ghosts.map(function (ghost) {
        return ghost.el;
      });
      sync(lane.list, listed.concat(loose.map(noteEl), ghosts));

      setText(lane.title, col.title);
      setText(lane.label, "Add a note to " + col.title);
      lane.add.setAttribute("aria-label", "Add note to " + col.title);
      if (lane.count.textContent !== String(cards.length)) {
        const first = lane.count.textContent === "";
        setText(lane.count, String(cards.length));
        if (!first) tick(lane.count);
      }
      setText(lane.countWords, ", " + plural(cards.length, "note"));
      lane.empty.hidden = cards.length + ghosts.length > 0;
      patchComposer(lane);
    });
    forgetMissing(view.lanes, idsOf(board.columns));
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
    for (const id in view.notes) {
      view.notes[id].box.checked = !!selected[id];
      view.notes[id].el.classList.toggle("selected", !!selected[id]);
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
    if (first) view.notes[first].box.focus();
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
  const actions = el("section", { class: "actions panel", "aria-labelledby": "actions-title" }, [
    el("div", { class: "actions-head" }, [el("h2", { id: "actions-title", text: "What we will do about it" }), actionCount]),
    actionEmpty,
    actionList,
    el("div", { class: "action-form" }, [
      el("div", { class: "stack" }, [el("label", { class: "label", for: "action-text", text: "Action" }), actionText]),
      el("div", { class: "stack narrow" }, [
        el("label", { class: "label", for: "action-owner", text: "Owner (optional)" }),
        actionOwner,
      ]),
      actionAdd,
    ]),
  ]);
  let addingAction = false;

  function buildAction() {
    const row = { text: el("p", { class: "action-text", dir: "auto" }), owner: buildPerson() };
    row.el = el("li", { class: "action" }, [row.text, row.owner.el]);
    return row;
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

  function patchActionForm() {
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

  // ------------------------------------------------------------------ shell

  // No h1: the frame sits under the host page's own, and a screen reader reads
  // the two documents as one outline. The lanes and the actions are its h2s.
  const main = el("main", { class: "board", "aria-label": "Retrospective board" }, [
    el("div", { class: "top" }, [
      el("section", { class: "progress", "aria-label": "Progress" }, [
        el(
          "ol",
          { class: "steps" },
          stepViews.map(function (v) {
            return v.el;
          }),
        ),
        hint,
      ]),
      authorship,
    ]),
    el("div", { class: "main" }, [lanes, actions]),
    el("div", { class: "dock" }, [el("div", { role: "status" }, [toast]), selectBar]),
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
    const before = board;
    const wasFocused = document.activeElement;
    const boxes = motionOn() ? measure() : null;

    session = next;
    board = boardOf(next);
    deciding = patchProgress().current === 3;
    patchNotes();
    patchLanes();
    patchActions();
    patchAuthorship();
    patchSelection();
    // The board is first shown with its content already in it, so nothing
    // jumps into place a moment after it appears.
    if (!drawn) root.appendChild(main);
    settleLanded();
    sendNext();

    // Moving a node drops its focus. Nothing a teammate does may take focus
    // away or scroll the page, so it goes back, quietly, to whatever held it.
    if (wasFocused && wasFocused !== document.activeElement && wasFocused.isConnected && document.activeElement === document.body) {
      wasFocused.focus({ preventScroll: true });
    }
    if (boxes) glideFrom(boxes);
    if (motionOn() && board.revealed && !before.revealed) revealWave();
    if (drawn) setText(live, describeChanges(before, board));
    drawn = true;
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (armed) arm(false);
    else if (selectedIds().length) clearSelection();
  });
  window.addEventListener("resize", reserveForBar);

  document.head.appendChild(el("style", { text: fontFaces() + STYLES }));
  // A live region is only listened to if it was there before its first
  // message, so it is mounted now and the board joins it with the first state.
  root.appendChild(live);
  patchProgress();
  patchAuthorship();
  patchActionForm();
  patchSelection();
  parley.onTokens(applyScheme);
  parley.onState(onState);
  parley.ready();
})();
