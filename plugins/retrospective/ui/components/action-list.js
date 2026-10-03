import { bag } from "../utils/bag.js";
import { GLYPH } from "../assets/glyphs.js";
import {
  FORMER, LANES, NOTE_LIMIT, OR_STORE, OTHER_LANE, OWNER_LIMIT,
} from "../constants/board.js";
import { contains, el, icon, setText, sync } from "../utils/dom.js";
import { idsOf, plural, short } from "../utils/text.js";
import { board, cardById, groupById, view } from "../bridge/state.js";
import { buildPerson, ownerOf, showPerson } from "./people.js";
import { animate, GLIDE, motionOn, NUDGE } from "../utils/motion.js";
import { closePop, openPop, toggles } from "./popover.js";
import { openConfirm, openMenu } from "./menu.js";
import { propose } from "../bridge/actions.js";
import { leadOf } from "./note.js";
import { forgetMissing } from "../features/render.js";

// ----------------------------------------------------------- action items

const actionCount = el("span", { class: "count", "aria-hidden": "true" });
const actionList = el("ul", { class: "action-list" });
const actionEmpty = el("p", {
  class: "empty",
  text: "Nothing decided yet. When the notes settle, name one change and who owns it.",
});
export const actionText = el("input", { id: "action-text", class: "field", maxlength: NOTE_LIMIT, dir: "auto" });
const actionOwner = el("input", { id: "action-owner", class: "field", maxlength: OWNER_LIMIT, placeholder: "Nobody yet", dir: "auto" });
const actionAdd = el("button", { type: "button", class: "btn btn-primary", text: "Add action" });
export const actionReopen = el("button", { type: "button", class: "reopen" }, [icon(GLYPH.plus), el("span", { text: "Add an action" })]);
export const actionForm = el("div", { class: "action-form" }, [
  el("div", { class: "stack" }, [el("label", { class: "label", for: "action-text", text: "Action" }), actionText]),
  el("div", { class: "stack narrow" }, [el("label", { class: "label", for: "action-owner", text: "Owner (optional)" }), actionOwner]),
  actionAdd,
]);
export const actions = el("section", { class: "actions panel", "aria-labelledby": "actions-title" }, [
  el("div", { class: "actions-head" }, [el("h2", { id: "actions-title", text: "What we will do about it" }), actionCount]),
  actionEmpty,
  actionList,
  el("div", { class: "action-foot" }, [actionReopen, actionForm]),
]);
export const ACTIONS_FULL = "That action was not saved. A board holds 30 action items." + OR_STORE;
export const LINKS_FULL = "That link was not made. An action holds twelve links." + OR_STORE;
let addingAction = false;
let actionOpen = false;

// Hovering or focusing one end of a link outlines the other end.
export function lights(node, others) {
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
export function sourceOf(id) {
  const card = cardById(id);
  const group = groupById(id);
  if (card && view.notes[id]) return { el: view.notes[id].el, focus: leadOf(view.notes[id]), kind: "note", name: card.text, lane: card.columnId };
  if (group && view.groups[id]) return { el: view.groups[id].el, focus: view.groups[id].more, kind: "group", name: group.title, lane: group.columnId };
  return null;
}

// Going to a source puts focus on it and rings it until the next key or
// press, so the eye finds what the keyboard already has.
let spot = null;

export function clearSpot() {
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

function actionById(id) {
  return board.actionItems.filter(function (a) {
    return a.id === id;
  })[0];
}

// Anyone can say who owns an action, or that nobody does yet.
function openOwner(id, anchor) {
  const item = actionById(id);
  const owner = el("input", { id: "owner-name", class: "field", maxlength: OWNER_LIMIT, placeholder: "Nobody yet", dir: "auto" });
  const save = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Save" });
  const cancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Cancel" });
  const panel = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Owner of action: " + short(item.text) }, [
    el("div", { class: "stack" }, [el("label", { class: "label", for: "owner-name", text: "Owner" }), owner]),
    el("p", { class: "fine", text: "Leave it empty and the action is unassigned." }),
    el("div", { class: "row" }, [save, cancel]),
  ]);
  const submit = function () {
    const name = owner.value.trim().slice(0, OWNER_LIMIT);
    closePop(true);
    propose("set-owner", { actionId: id, owner: name }, {
      landed: function (b) {
        return b.actionItems.some(function (a) {
          return a.id === id && a.owner === name;
        });
      },
      refused: { "not-found": "That action is no longer on the board." },
      unsure: "Could not confirm the owner.",
    });
  };
  owner.value = ownerOf(item.owner).name === FORMER ? "" : item.owner && ownerOf(item.owner).name;
  save.addEventListener("click", submit);
  cancel.addEventListener("click", function () {
    closePop(true);
  });
  owner.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.isComposing) submit();
  });
  openPop(anchor, panel);
  owner.focus();
}

function buildAction(id) {
  const row = {
    text: el("p", { class: "action-text", dir: "auto" }),
    owner: buildPerson(),
    sources: el("ul", { class: "sources", "aria-label": "From" }),
    unowned: el("p", { class: "unowned", text: "Unassigned" }),
    menu: el("button", { type: "button", class: "more", "aria-haspopup": "menu", title: "Options" }, [icon(GLYPH.dots, 3)]),
    more: el("button", { type: "button", class: "src" }),
    chips: bag(),
    wide: false,
  };
  row.moreItem = el("li", {}, [row.more]);
  row.el = el("li", { class: "action" }, [el("div", { class: "action-head" }, [row.text, row.menu]), row.sources, row.owner.el, row.unowned]);
  toggles(row.menu, function () {
    const item = actionById(id);
    if (!item) return;
    openMenu(row.menu, "Options for action: " + short(item.text), [
      {
        label: item.owner ? "Change owner…" : "Set an owner…",
        icon: GLYPH.owner,
        run: function () {
          openOwner(id, row.menu);
        },
      },
      { sep: true },
      {
        label: "Delete action…",
        icon: GLYPH.trash,
        danger: true,
        run: function () {
          openConfirm(row.menu, "Delete this action?", "Anyone in the room can delete an action. This cannot be undone.", "Delete action", function () {
            propose("delete-action", { actionId: id }, {
              landed: function (b) {
                return !b.actionItems.some(function (a) {
                  return a.id === id;
                });
              },
              refused: { "not-found": "That action is no longer on the board." },
              unsure: "Could not confirm that the action was deleted.",
            });
          });
        },
      },
    ], item.text);
  });
  row.more.addEventListener("click", function () {
    row.wide = true;
    patchActions();
    const last = row.sources.lastChild;
    if (last) last.children[0].focus();
  });
  return row;
}

// Up to three of the notes an action came from are shown. With more, two
// are, and the rest open in place: a chip that hides one chip saves nothing.
// A source that has left the board is simply not drawn.
function patchSources(row, item) {
  const sources = item.sourceIds.filter(sourceOf);
  const shown = row.wide || sources.length <= 3 ? sources : sources.slice(0, 2);
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

export function patchActions() {
  const fresh = [];
  const listed = board.actionItems.map(function (item) {
    if (!view.actions[item.id]) {
      view.actions[item.id] = buildAction(item.id);
      fresh.push(view.actions[item.id]);
    }
    const row = view.actions[item.id];
    setText(row.text, item.text);
    row.owner.el.hidden = !item.owner;
    row.unowned.hidden = !!item.owner;
    if (item.owner) showPerson(row.owner, ownerOf(item.owner));
    row.menu.setAttribute("aria-label", "Options for action: " + short(item.text));
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
export function patchActionForm() {
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
    refused: { conflict: ACTIONS_FULL },
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

