export const NOTE_STYLES = [
  // Notes stand 26px apart, under a group's heading and under the composer
  // too, and the last one stands clear of the foot of its lane: a sticker
  // hangs at most 27px over a note's top or bottom edge, and that room is
  // always there, so nothing moves when the first one lands.
  ".notes{display:flex;flex-direction:column;gap:26px}",
  ".notes:not(:empty){padding-bottom:12px}",
  ".lane>.notes:not(:empty){margin-top:10px}",
  ".note{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;column-gap:6px;padding:5px 8px 5px 4px;background:var(--color-surface-hi);border:1px solid var(--color-line);border-radius:14px;box-shadow:var(--shadow-rest);transition:background-color .15s,border-color .15s}",
  ".note.selected{background:var(--color-accent-soft);border-color:var(--color-accent);box-shadow:0 0 0 1px var(--color-accent),var(--shadow-rest)}",
  // A note's controls are drawn over its stickers, and over a neighbor's:
  // a sticker may cover text, and steps back when the text is pointed at,
  // but it never covers a control.
  ".lead,.trail{position:relative;z-index:2;display:flex;align-items:center}",
  // In front of the text: the handle, and the checkbox while notes are being
  // picked. After it: the note's menu, always the last thing on the row.
  // The vote and the action count are a row of their own under the words,
  // there only when there is one to show, so the words are never squeezed
  // between controls and a one-line note with nothing to show stays one line.
  ".trail{gap:4px;min-height:32px}",
  "@media (pointer:fine){.narrow .lead,.note.narrow .lead{flex-direction:column}.narrow .note .grip,.narrow .note .pick,.note.narrow .grip,.note.narrow .pick{height:24px}}",
  // A note being edited: its words are a box of the same face and measure,
  // with Save and Cancel in a row of the note's own under it, so they are
  // never over a neighbor and never cut off; the note is that much taller
  // while it is edited. It stands over its stickers, which step back.
  ".note.editing{border-color:var(--color-accent);box-shadow:0 0 0 1px var(--color-accent),var(--shadow-rest);z-index:3}",
  ".note.editing .note-text{display:none}",
  ".note-edit{position:relative;z-index:2;display:block;width:100%;margin:0;padding:6px 0;border:0;outline:0;background:transparent;color:inherit;font:inherit;resize:none;overflow:hidden;overflow-wrap:break-word}",
  ".edit-row{grid-column:2/-1;position:relative;z-index:2;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;padding:2px 0 6px}",
  ".edit-said{flex:1 1 6rem;font-size:12px;color:var(--color-ink-soft)}",
  // The question has a line to itself, and its two answers the next.
  ".edit-row.asking .edit-said{flex-basis:100%}",
  ".edit-row .btn{white-space:nowrap}",
  ".note.editing .st.over{opacity:.2}",
  ".note.editing .rx{display:none}",
  ".edited{font:11px/16px var(--mono);color:var(--color-ink-soft);margin-right:auto}",
  // What a note has gathered besides votes: the word "edited" and the
  // count of its actions. They stand at the start of a row of their own,
  // clear above the buttons on the note's lower edge.
  ".chips{grid-column:2/-1;justify-self:start;max-width:100%;position:relative;z-index:2;display:flex;align-items:center;gap:4px;padding-bottom:13px}",
  ".pick,.grip,.more,.target{display:grid;place-items:center;width:28px;height:32px}",
  ".pick{cursor:pointer}",
  ".grip,.more,.target{padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-ink-faint);transition:background-color .15s,color .15s}",
  ".grip:hover,.more:hover,.target:hover{background:var(--color-felt-deep);color:var(--color-ink)}",
  ".grip{cursor:grab;touch-action:none}",
  ".more{width:32px;color:var(--color-ink-soft)}",
  '.more[aria-expanded="true"]{background:var(--color-felt-deep);color:var(--color-ink)}',
  ".target{color:var(--color-ink-soft)}",
  ".target.linked{display:inline-flex;align-items:center;gap:4px;width:auto;padding:0 6px;color:var(--color-brass);font-size:13px;font-weight:700}",
  ".lit{outline:2px solid var(--color-accent);outline-offset:1px}",
  ".note.spot,.group.spot{box-shadow:0 0 0 2px var(--color-accent),var(--shadow-rest)}",
  // A note being dragged: the copy under the pointer, and the slot it left.
  ".scroll-spot{position:absolute;left:0;width:1px;height:1px;pointer-events:none}",
  ".drag{position:fixed;z-index:4;margin:0;list-style:none;pointer-events:none;box-shadow:var(--shadow-lift);font-size:14px;line-height:20px}",
  ".note.slot{border:1.5px dashed var(--color-accent);background:transparent;box-shadow:none}",
  ".group.slot{outline:1.5px dashed var(--color-accent);outline-offset:-1px;background:transparent;box-shadow:none}",
  ".slot>*{visibility:hidden}",
  // Where a drop would go: the lane it would change to, the group it would
  // join, or the note it would be grouped with. While a note is the target
  // the slot steps back, so there is one answer on screen, not two.
  ".lane.dropzone{border-color:var(--color-accent);background:color-mix(in srgb,var(--color-accent) 7%,var(--color-surface));box-shadow:0 0 0 2px var(--color-accent),var(--shadow-rest)}",
  ".group.dropzone{box-shadow:0 0 0 2px var(--color-accent),var(--shadow-well)}",
  ".note.merge{border-color:var(--color-accent);background:var(--color-accent-soft);box-shadow:0 0 0 2px var(--color-accent),var(--shadow-rest)}",
  '.note.merge::after{content:"Group with this";position:absolute;z-index:3;top:-12px;right:10px;padding:1px 10px;border-radius:999px;background:var(--color-accent);color:var(--color-accent-ink);font-size:12px;font-weight:700;line-height:20px}',
  ".note.slot.faded{border-color:transparent}",
  ".dragging,.dragging *{user-select:none;cursor:grabbing!important}",
  ".pick input{appearance:none;display:grid;place-items:center;width:14px;height:14px;margin:0;border:1px solid var(--color-line-strong);border-radius:4px;background:transparent;cursor:pointer;transition:background-color .15s,border-color .15s}",
  ".pick input:checked{border-color:var(--color-accent);background:var(--color-accent)}",
  '.pick input:checked::after{content:"";width:4px;height:7px;margin-top:-2px;border:solid var(--color-accent-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}',
  ".note-text{padding:6px 0;white-space:pre-wrap;overflow-wrap:break-word;border-radius:4px}",
  ".person{grid-column:2/-1;display:flex;align-items:center;gap:8px;min-width:0;padding-bottom:5px;font-size:13px;color:var(--color-ink-soft)}",
  ".person-name{min-width:0;overflow-wrap:anywhere}",
  ".disc{flex:none;display:grid;place-items:center;width:24px;height:24px;margin:3px;border-radius:50%;font-size:9px;font-weight:700;color:#F4F8FB;background:#3F5466;box-shadow:0 0 0 2px var(--color-surface-hi),0 0 0 3px var(--color-line)}",
  // The score: a small tag on the note's top corner, its ups less its
  // downs with the sign written. Green above nothing and red below it agree
  // with the sign and say nothing by themselves; a note with both ups and
  // downs has a rule under the number, drawn to the share that is up, so a
  // tie never looks like a note nobody has voted on. It is not a control: a
  // press on that corner reaches the menu button under it. The split is
  // written beside it while the note is pointed at or holds focus.
  ".tally{position:absolute;top:-10px;right:-6px;z-index:3;display:flex;flex-direction:row-reverse;align-items:center;gap:4px;pointer-events:none}",
  ".score,.brk{display:grid;place-items:center;height:20px;border:1px solid var(--st-edge);border-radius:999px;background:var(--color-surface-hi);font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".score{position:relative;min-width:28px;padding:0 6px;font-size:12px;font-weight:700;line-height:18px;color:var(--color-ink-soft);box-shadow:var(--shadow-rest)}",
  ".score.pos{color:color-mix(in srgb,var(--color-go) 78%,var(--color-ink))}",
  ".score.neg{color:color-mix(in srgb,var(--color-stop) 78%,var(--color-ink))}",
  '.score.mixed::after{content:"";position:absolute;left:6px;right:6px;bottom:2px;height:2px;border-radius:1px;background:linear-gradient(90deg,currentColor calc(var(--u) - 1px),transparent calc(var(--u) - 1px),transparent calc(var(--u) + 1px),var(--color-line-strong) calc(var(--u) + 1px))}',
  ".score b{display:block}",
  ".score.mixed b{translate:0 -1px}",
  ".brk{padding:0 7px;font-size:11px;line-height:18px;color:var(--color-ink-soft);border-color:var(--color-line-strong);opacity:0;transition:opacity .15s}",
  // Keyboard focus, not any focus: a thumb pressed with the mouse keeps
  // focus, and the split must still go when the pointer leaves.
  ".note:hover .brk,.note:has(:focus-visible) .brk{opacity:1}",
  // Under the words, on the note's lower edge: the dashed plus for a
  // sticker, a thumb up and a thumb down. They take no room from the note,
  // and are shown with it: pointed at, focused, in the Vote stage, or once
  // the viewer's own vote is known. Hidden is not gone: each is a Tab stop
  // and shows when it has focus. Pressed is a filled thumb and a ring.
  ".rx{position:absolute;right:40px;bottom:-12px;z-index:2;display:flex;gap:4px}",
  ".rb{position:relative;flex:none;display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--color-line-strong);border-radius:50%;background:var(--color-surface-hi);color:var(--color-ink-soft);opacity:0;transition:opacity .15s,background-color .15s,color .15s,transform .07s ease-out}",
  ".rb.add-st{border-style:dashed}",
  ".rb svg{display:block;width:16px;height:16px;overflow:visible}",
  ".add-st svg{width:14px;height:14px}",
  ".rate.down svg{transform:scaleY(-1)}",
  '.rb:hover,.add-st[aria-expanded="true"]{background:var(--color-felt-deep);color:var(--color-ink)}',
  ".rb:active{transform:translateY(1px) scale(.94)}",
  '.note:hover .rb,.note:focus-within .rb,.stage-2 .rate,.rate.known,.add-st[aria-expanded="true"]{opacity:1}',
  "@media (hover:none){.rb{opacity:1}}",
  '.rate[aria-pressed="true"]{border-color:var(--color-accent);background:var(--color-accent-soft);box-shadow:0 0 0 1px var(--color-accent);color:var(--color-accent)}',
  '.rate[aria-pressed="true"] path{fill:currentColor}',
  ".rb:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}",
  ".rate.failed{border-style:dashed;border-color:var(--color-stop)}",
  // A vote that did not go through says so on its note, with the way to
  // send it again.
  ".oops{position:absolute;right:8px;top:calc(100% + 18px);z-index:5;display:flex;align-items:center;gap:8px;max-width:calc(100% - 16px);padding:6px 6px 6px 12px;border:1px solid var(--color-line);border-radius:14px;background:var(--color-surface-hi);box-shadow:var(--shadow-lift);font-size:13px;line-height:18px}",
  ".oops-x{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-ink-soft)}",
  ".oops-x:hover{background:var(--color-felt-deep)}",
  ".board:not(.stage-3) .target{min-height:24px;height:24px;padding:0 8px;border-color:var(--color-line);font-size:12px}",
  // A note on its way to the server: same place, drawn as not yet real.
  ".ghost{border-style:dashed;background:transparent;box-shadow:none}",
  ".ghost .note-text{grid-column:2/-1;color:var(--color-ink-soft)}",
  ".ghost-foot{grid-column:2/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-bottom:5px;font-size:13px;color:var(--color-ink-faint)}",
  ".group{padding:8px;border-radius:14px;background:var(--color-felt-deep);box-shadow:var(--shadow-well)}",
  ".group-head{position:relative;z-index:2;display:flex;align-items:flex-start;gap:6px;margin:0 0 26px}",
  ".group-title{flex:1;min-width:0;padding-top:4px}",
];

