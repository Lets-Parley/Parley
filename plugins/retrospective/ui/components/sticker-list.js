import { GLYPH } from "../assets/glyphs.js";
import { UNKNOWN_KIND } from "../assets/stickers.js";
import { contains, el, icon, setText } from "../utils/dom.js";
import { short } from "../utils/text.js";
import { cardById, view } from "../bridge/state.js";
import { viewerRole } from "./people.js";
import { live, notify } from "./notices.js";
import { closePop, openPop, placePop, tabStops } from "./popover.js";
import {
  face, nameOf, notMine, stampHelp,
} from "../features/sticker-layout.js";
import {
  drawnPile, frontStamp, ownStamp, removeStamp, stampById,
} from "../features/sticker-actions.js";
import { openStamps } from "./sticker-book.js";

// Stickers lie one over another, and then the one underneath is hard to
// hit. This list reaches every sticker on a note without aiming.
export function openStampList(cardId, opener) {
  const card = cardById(cardId);
  const gone = "That sticker is no longer on the board.";
  // Icon buttons, as in the options menu; each keeps its whole name.
  const control = function (glyph, label, said, id, run) {
    const btn = el("button", { type: "button", class: "st-do" + (label === "Remove" ? " danger" : ""), "aria-label": said, title: label }, [icon(glyph)]);
    btn.addEventListener("click", function () {
      closePop(true);
      // A teammate may have removed it since the list was drawn.
      if (stampById(id) && view.stamps[id]) run();
      else notify(gone);
    });
    return btn;
  };
  const list = el("ul", { class: "st-list" });
  const note = el("p", { class: "off-why", tabindex: -1 });
  const words = (viewerRole() === "facilitator" ? "You can move or remove any sticker." : "You can move ones you placed in this visit, and remove yours.") + " Bottom of the pile first.";
  // Drawn again whenever the board changes, so a row never outlives its sticker.
  const fill = function () {
    const pile = drawnPile(cardId);
    const held = contains(list, document.activeElement);
    while (list.children.length) list.removeChild(list.lastChild);
    pile.forEach(function (s, i) {
      const name = (s.kind === UNKNOWN_KIND ? "Sticker, " : nameOf(s.kind) + " sticker, ") + (i + 1) + " of " + pile.length;
      const parts = [face(s.kind, " small"), el("span", { class: "w", text: nameOf(s.kind) })];
      if (ownStamp(s.id)) {
        parts.push(
          control(GLYPH.drag, "Move", "Move " + name, s.id, function () {
            view.stamps[s.id].btn.focus();
            setText(live, name + ". " + stampHelp.textContent);
          }),
          control(GLYPH.top, "To front", "Bring to front " + name, s.id, function () {
            view.stamps[s.id].btn.focus();
            frontStamp(s.id);
          }),
        );
      }
      if (ownStamp(s.id) || !notMine[s.id]) {
        parts.push(
          control(GLYPH.trash, "Remove", "Remove " + name, s.id, function () {
            removeStamp(s.id);
          }),
        );
      }
      list.appendChild(el("li", {}, parts));
    });
    setText(note, pile.length ? words : "There are no stickers on this note now.");
    const first = tabStops(list, [])[0];
    if (held || document.activeElement === document.body) (first || note).focus();
  };
  const add = el("button", { type: "button", class: "menu-item" }, [icon(GLYPH.plus), el("span", { class: "w", text: "Add a sticker\u2026" })]);
  add.addEventListener("click", function () {
    closePop(false);
    openStamps(cardId, opener);
  });
  const sheet = el("div", { class: "pop sheet st-sheet", role: "dialog", "aria-label": "Stickers on: " + short(card.text) }, [el("p", { class: "label menu-title", text: "Stickers on this note" }), list, note, el("div", { class: "sep" }), add]);
  openPop(opener, sheet, fill);
  fill();
  // Placed again now that it holds its rows: empty, it fitted anywhere.
  placePop();
}

