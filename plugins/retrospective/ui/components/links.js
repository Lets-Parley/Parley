import { bag } from "../utils/bag.js";
import { NOTE_LIMIT, OWNER_LIMIT } from "../constants/board.js";
import { el, setText, sync } from "../utils/dom.js";
import { idsOf, short } from "../utils/text.js";
import { ui } from "../bridge/state.js";
import { closePop, openPop } from "./popover.js";
import { propose } from "../bridge/actions.js";
import { ACTIONS_FULL, LINKS_FULL, sourceOf } from "./action-list.js";

// ------------------------------------------------------------------ links

// An action can be started from a note or a group, and tied to more of
// them afterwards. This is the one place that is done: a small form that
// hangs from the target on the note, with every action listed under it.
export function openLinks(sourceId, opener) {
  const source = sourceOf(sourceId);
  const text = el("input", { id: "link-text", class: "field", maxlength: NOTE_LIMIT, placeholder: "What will we change?", dir: "auto" });
  const owner = el("input", { id: "link-owner", class: "field", maxlength: OWNER_LIMIT, placeholder: "Nobody yet", dir: "auto" });
  const add = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Add action" });
  const cancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Cancel" });
  const list = el("ul", { class: "link-list" });
  const listLabel = el("p", { class: "label", text: "Or tie it to an action already here" });
  const rows = bag();
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
    listLabel.hidden = ui.board.actionItems.length === 0;
    sync(
      list,
      ui.board.actionItems.map(function (item) {
        let row = rows[item.id];
        if (!row) {
          row = rows[item.id] = { text: el("span", { dir: "auto" }), btn: el("button", { type: "button", class: "btn btn-quiet btn-small" }) };
          row.el = el("li", {}, [row.text, row.btn]);
          row.btn.addEventListener("click", function () {
            const now = ui.board.actionItems.filter(function (a) {
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
              refused: { conflict: LINKS_FULL, failed: LINKS_FULL, "not-found": "That link was not made: the note or the action is no longer on the board." },
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
    const had = idsOf(ui.board.actionItems);
    adding = true;
    propose("add-action", { text: words, owner: owner.value.trim(), sourceIds: [sourceId] }, {
      landed: function (b) {
        return b.actionItems.some(function (a) {
          return !had[a.id] && a.text === words;
        });
      },
      refused: { conflict: ACTIONS_FULL },
      unsure: "Could not confirm that the action was saved. It is still in the box.",
      settle: function (outcome) {
        if (outcome === "accepted") return;
        adding = false;
        if (outcome === "landed" && ui.pop && ui.pop.el === panel) closePop(true);
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

