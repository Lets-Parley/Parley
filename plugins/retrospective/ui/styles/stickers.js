import { INKS, MEANINGS } from "../assets/stickers.js";

export const STICKER_STYLES = [
  // A sticker is die-cut: an ink line, a paper border, a hairline and one
  // soft shadow from above. Both sets are made the same way and only the
  // print differs. It is placed by its center, as a fraction of the note.
  ":root{" +
    INKS.map(function (k) {
      return "--k-" + k[0] + ":var(--color-" + k[1] + ");";
    }).join("") +
    "--st-paper:#FBFAF6;--st-ink:#16293A;--st-rest:drop-shadow(0 1px .6px rgb(var(--sh)/.3)) drop-shadow(0 2px 3px rgb(var(--sh)/.2))}",
  "@supports (color:oklch(from red l c h)){:root{" +
    INKS.map(function (k) {
      return "--k-" + k[0] + ":oklch(from var(--color-" + k[1] + ") " + k[2] + ");";
    }).join("") +
    "--st-paper:oklch(from var(--color-brass) .985 .008 h);--st-ink:oklch(from var(--color-accent) .25 .04 h)}}",
  MEANINGS.map(function (m) {
    return ".k-" + m[0] + "{--k:var(--k-" + m[0] + ")}";
  }).join("") + ".k-other{--k:var(--color-felt-deep)}",
  ".stamps{position:absolute;inset:0;z-index:1;pointer-events:none}",
  ".st{position:absolute;display:block;width:42px;height:42px;margin:-21px 0 0 -21px;padding:0;border:0;border-radius:50%;background:none;pointer-events:auto;cursor:grab;touch-action:none;transition:opacity .2s .15s}",
  ".st svg{display:block;width:100%;height:100%;overflow:visible;rotate:var(--rot,0deg);filter:var(--st-rest);transition:translate .18s cubic-bezier(.22,1,.36,1),scale .18s cubic-bezier(.22,1,.36,1),filter .18s}",
  ".st path{fill:none;stroke-linejoin:round;stroke-linecap:round}",
  ".st .e{stroke:var(--st-edge);stroke-width:10;fill:var(--st-edge)}",
  ".st .w{stroke:var(--st-paper);stroke-width:8;fill:var(--st-paper)}",
  ".st .o{stroke:var(--st-ink);stroke-width:3.2}",
  ".st .c{fill:var(--k)}.st .f{fill:var(--st-ink)}.st .q{fill:var(--st-paper)}",
  ".st .s{stroke:var(--st-ink);stroke-width:1.6}.st .p{stroke:var(--st-paper);stroke-width:1.8;opacity:.85}",
  // Pixel: the units are cells, three pixels each at this size, so the
  // sticker has to be exactly 42px or the cells leave the pixel grid.
  // It is never tilted, and its size is a whole number of device pixels
  // a cell (--px, set from the device's pixel ratio). With crisp edges
  // every cell then rounds the same way, wherever the sticker sits.
  ".st.px{width:var(--px,42px);height:var(--px,42px);margin:calc(var(--px,42px) / -2) 0 0 calc(var(--px,42px) / -2)}",
  ".st.px svg{rotate:none}",
  ".st.px path{stroke-linejoin:miter}",
  ".st.px .e{stroke-width:2.34}.st.px .w{stroke-width:1.6}.st.px .o{stroke:none;fill:var(--st-ink)}",
  ".st:hover svg{translate:0 -2px;scale:1.06;filter:drop-shadow(0 2px 1px rgb(var(--sh)/.26)) drop-shadow(0 6px 6px rgb(var(--sh)/.24))}",
  // Drawn on top while it is pointed at or focused; the pile does not change.
  ".st:hover,.st:focus-visible{z-index:3}",
  ".st:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}",
  ".st.lift{cursor:grabbing;z-index:4}",
  ".st.lift svg{translate:0 -5px;scale:1.14;filter:drop-shadow(0 3px 2px rgb(var(--sh)/.24)) drop-shadow(0 14px 12px rgb(var(--sh)/.3))}",
  // Somebody else's sticker, or one not known to be the viewer's: it opens,
  // and it does not offer to be dragged.
  ".st.fixed{cursor:pointer;touch-action:auto}",
  ".st.fixed:hover svg{translate:none;scale:1;filter:var(--st-rest)}",
  // Peek: stickers lying over a note's words go faint while the words are
  // pointed at, or while one of the note's controls has keyboard focus.
  ".note.peek .st.over:not(.lift):not(:focus-visible),.note:has(.lead :focus-visible,.trail :focus-visible,.chips :focus-visible,.rx :focus-visible) .st.over{opacity:.2;transition:opacity .12s}",
  // Dust: the few cells a pixel sticker kicks up where it lands.
  ".dust{position:absolute;z-index:1;pointer-events:none}",
  // A sticker on its way off the note is not there to be pressed.
  ".st.leaving{pointer-events:none}",
  // A group's name is at most 80 characters and is shown whole.
  "h3{font-size:14px;font-weight:700;line-height:20px;overflow-wrap:break-word}",
  ".group-meta{font:11px/16px var(--mono);color:var(--color-ink-soft)}",
];

