import { bag } from "../utils/bag.js";
import { MEANINGS, STAMPS } from "../assets/stickers.js";
import { PER_PERSON } from "../constants/board.js";
import { el, setText } from "../utils/dom.js";
import { short } from "../utils/text.js";
import { cardById, ui } from "../bridge/state.js";
import { closePop, layer, openPop } from "./popover.js";
import {
  countKnown, face, leftFor, nameOf, roomOn,
} from "../features/sticker-layout.js";
import { pressStamp } from "../features/sticker-actions.js";

// The sticker book: two sheets of the same seven stickers, vinyl and
// pixel, with what they mean written once between them. The marked sheet
// is the one the keys 1 to 7 place from.
// `back` is where focus goes when the book closes, when that is not the
// control it hangs from: S is pressed on the note's words.
export function openStamps(cardId, opener, back) {
  const card = cardById(cardId);
  const leaves = bag();
  let off = false;
  const mark = function (set) {
    ui.stickerSet = set;
    for (const name in leaves) {
      leaves[name].row.classList.toggle("active", name === set);
      leaves[name].tag.classList.toggle("active", name === set);
    }
  };
  const choose = function (kind) {
    if (off) return;
    mark(STAMPS[kind].set);
    closePop(true);
    pressStamp(cardId, kind);
  };
  [["vinyl", "Vinyl", ""], ["pixel", "Pixel", "p-"]].forEach(function (set) {
    const kinds = MEANINGS.map(function (m) {
      return set[2] + m[0];
    });
    const cells = kinds.map(function (kind, i) {
      const cell = el("button", { type: "button", class: "choice", "aria-label": nameOf(kind), "aria-keyshortcuts": String(i + 1), tabindex: -1 }, [face(kind)]);
      cell.addEventListener("click", function () {
        choose(kind);
      });
      cell.addEventListener("focus", function () {
        mark(set[0]);
      });
      return cell;
    });
    leaves[set[0]] = {
      kinds: kinds,
      cells: cells,
      row: el("div", { class: "leaf", role: "group", "aria-label": set[1] + " stickers" }, cells),
      tag: el("p", { class: "label set" }, [el("span", { class: "on", "aria-hidden": "true", text: "▸" }), el("span", { text: set[1] }), el("kbd", { text: set[1][0] })]),
    };
  });
  // Every choice already says what it means, so the middle is for the eye.
  const spine = el(
    "div",
    { class: "spine", "aria-hidden": "true" },
    MEANINGS.map(function (m, i) {
      return el("span", {}, [el("kbd", { text: String(i + 1) }), el("span", { text: m[1] })]);
    }),
  );
  const pips = [0, 1, 2].map(function () {
    return el("i");
  });
  const count = el("span");
  const fine = el("p", { class: "fine", tabindex: -1 });
  // Shown on a phone, where Escape and the dimmed page are not obvious ways out.
  const done = el("button", { type: "button", class: "btn btn-quiet btn-small book-done", text: "Done" });
  done.hidden = !(window.matchMedia && window.matchMedia("(max-width:480px)").matches);
  const sheet = el("div", { class: "pop sheet book-pop", role: "dialog", "aria-label": "Add a sticker to: " + short(card.text) }, [
    el("div", { class: "book-head" }, [el("p", { class: "label", text: "Add a sticker" }), el("span", { class: "left3" }, pips.concat([count]))]),
    el("div", { class: "book" }, [leaves.vinyl.tag, leaves.vinyl.row, spine, leaves.pixel.row, leaves.pixel.tag]),
    fine,
    done,
  ]);
  done.addEventListener("click", function () {
    closePop(true);
  });
  // A teammate can fill the note while the book is open.
  const patch = function () {
    const left = leftFor(cardId);
    const known = countKnown(cardId) || left < PER_PERSON;
    off = left === 0 || roomOn(cardId) === 0;
    pips.forEach(function (pip, i) {
      pip.className = i < left ? "have" : "";
      pip.hidden = !known;
    });
    // A number is shown only when it is one the board can know.
    setText(count, known ? left + " of " + PER_PERSON + " left on this note" : "Up to " + PER_PERSON + " of yours on a note");
    setText(fine, left === 0 ? "You have placed your three on this note." : off ? "This note is full: twelve stickers." : "Pick one and it lands clear of the words; then drag it anywhere. Nobody can see who placed a sticker.");
    for (const name in leaves) {
      leaves[name].cells.forEach(function (cell) {
        cell.disabled = off;
      });
    }
  };
  sheet.addEventListener("keydown", function (ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const here = leaves[ui.stickerSet];
    const col = Math.max(0, here.cells.indexOf(document.activeElement));
    const other = ui.stickerSet === "vinyl" ? "pixel" : "vinyl";
    let to = null;
    if (key >= "1" && key <= "7" && key.length === 1) choose(here.kinds[Number(key) - 1]);
    else if (key === "v" || key === "p") to = [key === "v" ? "vinyl" : "pixel", col];
    else if (key === "ArrowLeft" || key === "ArrowRight") to = [ui.stickerSet, (col + (key === "ArrowRight" ? 1 : 6)) % 7];
    else if (key === "Tab" && !done.hidden) {
      // With Done in sight, Tab goes round three stops: a sheet, the other
      // sheet, Done.
      ev.preventDefault();
      const stops = [leaves.vinyl.cells[col], leaves.pixel.cells[col], done];
      const at = document.activeElement === done ? 2 : ui.stickerSet === "vinyl" ? 0 : 1;
      const next = (at + (ev.shiftKey ? 2 : 1)) % 3;
      if (next < 2) mark(next === 0 ? "vinyl" : "pixel");
      if (next === 2 || !off) stops[next].focus();
      return;
    } else if (key === "ArrowUp" || key === "ArrowDown" || key === "Tab") to = [other, col];
    else return;
    ev.preventDefault();
    if (!to) return;
    // A choice that cannot be used cannot be focused; its sheet is still marked.
    mark(to[0]);
    if (!off) leaves[to[0]].cells[to[1]].focus();
  });
  patch();
  sheet.ownTab = true;
  openPop(opener, sheet, patch);
  ui.pop.back = back;
  // On a phone the book is a sheet along the bottom, over a scrim.
  ui.pop.under = el("div", { class: "scrim", "aria-hidden": "true" });
  layer.insertBefore(ui.pop.under, sheet);
  mark(ui.stickerSet);
  (off ? fine : leaves[ui.stickerSet].cells[0]).focus();
}

