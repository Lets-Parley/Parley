import { bag } from "../utils/bag.js";
import { OR_STORE, TITLE_LIMIT } from "../constants/board.js";
import { contains, el, setText } from "../utils/dom.js";
import { graphemes, idsOf, short } from "../utils/text.js";
import {
  board, cardById, selected, selectedIds, view,
} from "../bridge/state.js";
import { closePop, openPop, pop } from "./popover.js";
import { propose } from "../bridge/actions.js";
import { leadOf } from "./note.js";
import { main } from "../main.js";

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
export const selectBar = el("section", { class: "select-bar", "aria-label": "Selected notes" }, [
  el("p", { class: "select-info" }, [selectCount, selectReason]),
  groupName,
  groupButton,
  clearButton,
]);
let grouping = false;

// board.js refuses a group of fewer than two notes, or of notes from more
// than one lane. Both are settled here, before the button can be pressed,
// and since a group cannot be renamed it has to be named first.
export function patchSelection() {
  const ids = selectedIds().filter(function (id) {
    return view.lanes[cardById(id).columnId];
  });
  const laneIds = bag();
  ids.forEach(function (id) {
    laneIds[cardById(id).columnId] = true;
  });
  const laneCount = Object.keys(laneIds).length;
  const groupable = ids.length >= 2 && laneCount === 1;
  const named = !!groupTitle.value.trim();
  // A note shows its checkbox while notes are being picked: in the Group
  // stage, and whenever it is itself selected. Its handle and its menu
  // button stay where they are.
  const held = document.activeElement;
  for (const id in view.notes) {
    const note = view.notes[id];
    const picking = board.stage === 1 || !!selected[id];
    note.box.checked = !!selected[id];
    note.el.classList.toggle("selected", !!selected[id]);
    note.pick.hidden = !picking;
    if (held === note.box && !picking) note.more.focus();
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
export function reserveForBar() {
  main.style.paddingBottom = selectBar.hidden ? "" : (selectBar.offsetHeight || 0) + 44 + "px";
}

export function clearSelection() {
  const first = selectedIds()[0];
  selected = bag();
  patchSelection();
  if (first) leadOf(view.notes[first]).focus();
}

function groupSelected() {
  if (groupButton.disabled) return;
  grouping = true;
  sendGroup(selectedIds(), groupTitle.value, "Could not confirm that the notes were grouped. They are still selected.", function (outcome, group) {
    grouping = false;
    if (outcome === "landed") {
      const heldFocus = contains(selectBar, document.activeElement);
      selected = bag();
      groupTitle.value = "";
      patchSelection();
      if (heldFocus && group) group.title.focus();
      return;
    }
    patchSelection();
  });
  patchSelection();
}

// Notes become a group one way, whether they were selected and grouped from
// the bar or one was dropped on another: the same request, in board order.
function sendGroup(ids, title, unsure, done) {
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
  propose("group-cards", { cardIds: ids, title: title.trim().slice(0, TITLE_LIMIT) }, {
    landed: made,
    refused: { "not-found": "Not grouped: one of those notes is no longer on the board.", conflict: "Not grouped. A board holds 40 groups." + OR_STORE },
    unsure: unsure,
    settle: function (outcome) {
      if (outcome !== "accepted") done(outcome, outcome === "landed" && made(board) && view.groups[made(board).id]);
    },
  });
}

// A note dropped on another makes a group of the two. A group has to be
// named and cannot be renamed, so the drop asks for the name before anything
// is sent: Cancel, Escape or a press elsewhere leaves both notes as they were.
export function openGroupName(targetId, draggedId) {
  const ids = board.cards
    .filter(function (c) {
      return c.id === targetId || c.id === draggedId;
    })
    .map(function (c) {
      return c.id;
    });
  const anchor = view.notes[targetId].more;
  const name = el("input", { id: "merge-title", class: "field", maxlength: TITLE_LIMIT, placeholder: "Name this group", dir: "auto" });
  const go = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Group" });
  const cancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Cancel" });
  const panel = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Group these two notes" }, [
    el("p", { class: "sheet-title", text: "Group these two notes" }),
    el(
      "ul",
      { class: "stack" },
      ids.map(function (id) {
        return el("li", { class: "from", dir: "auto", text: short(cardById(id).text) });
      }),
    ),
    el("div", { class: "stack" }, [el("label", { class: "label", for: "merge-title", text: "Group name" }), name]),
    el("div", { class: "row" }, [go, cancel]),
  ]);
  let sending = false;
  const patch = function () {
    go.disabled = sending || !name.value.trim();
    name.readOnly = sending;
  };
  const submit = function () {
    if (go.disabled) return;
    sending = true;
    sendGroup(ids, name.value, "Could not confirm that the notes were grouped.", function (outcome, group) {
      sending = false;
      if (outcome !== "landed") return patch();
      if (pop && pop.el === panel) closePop(false);
      if (group) group.title.focus();
    });
    patch();
  };
  // The first words of the note it was dropped on, selected: typing replaces
  // them, Enter takes them.
  name.value = firstWords(cardById(targetId).text);
  name.addEventListener("input", patch);
  name.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.isComposing) submit();
  });
  go.addEventListener("click", submit);
  cancel.addEventListener("click", function () {
    closePop(true);
  });
  patch();
  // Either note can be deleted by a teammate while the name is being typed.
  openPop(anchor, panel, patch, function () {
    return ids.every(cardById);
  });
  name.focus();
  if (name.select) name.select();
}

// The first three words of a note, as a name for a group: at most
// TITLE_LIMIT long, cut between characters as a reader sees them and never
// through one, and without the marks that change how text is laid out and
// show nothing themselves (controls, zero-width spaces, direction marks).
// The joiners inside an emoji or between letters are kept.
function firstWords(text) {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ");
  const three = clean.trim().split(/\s+/).slice(0, 3).join(" ");
  const parts = graphemes(three);
  let name = "";
  for (let i = 0; i < parts.length && name.length + parts[i].length <= TITLE_LIMIT; i++) name += parts[i];
  return name.replace(/[\u200c\u200d\ud800-\udbff]+$/, "").trim();
}

groupButton.addEventListener("click", groupSelected);
clearButton.addEventListener("click", clearSelection);
groupTitle.addEventListener("input", patchSelection);
groupTitle.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && !ev.isComposing) groupSelected();
});

