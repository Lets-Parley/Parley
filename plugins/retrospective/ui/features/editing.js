import {
  NOTE_GONE, NOTE_LIMIT, ONLY_AUTHOR, ONLY_AUTHOR_EDITS,
} from "../constants/board.js";
import { contains, el, setText } from "../utils/dom.js";
import { plural, short } from "../utils/text.js";
import { board, cardById, session, view } from "../bridge/state.js";
import { viewerRole } from "../components/people.js";
import { live, notify } from "../components/notices.js";
import { closePop } from "../components/popover.js";
import { forget, propose } from "../bridge/actions.js";
import { patchComposer } from "../components/lane.js";
import { notMyNotes } from "../components/note-menu.js";

// ---------------------------------------------------------------- editing

// A note's words are edited where they stand, by whoever wrote them. Whose
// a note is is not in the state before the reveal, so the editor opens for
// anyone and the server answers; a no is remembered for the visit. One
// editor at a time. It is a node of the note itself, so a teammate's
// change, which patches the note and never rebuilds it, leaves the draft,
// the caret and the focus alone.
export let editing = null;

// Known to be somebody else's: the server has said so, or authors are
// revealed and this one is not the viewer.
export function notMineNote(id) {
  const card = cardById(id);
  return !!notMyNotes[id] || !!(card && board.revealed && card.authorId && session && session.selfId && card.authorId !== session.selfId);
}

export function editNote(id) {
  const note = view.notes[id];
  const card = cardById(id);
  if (!note || !card) return;
  if (notMineNote(id)) {
    notify(ONLY_AUTHOR_EDITS);
    return;
  }
  if (editing) {
    if (editing.id === id) return editing.area.focus();
    // Words half typed elsewhere are not thrown away by starting here.
    const there = cardById(editing.id);
    if (there && editing.area.value !== there.text) {
      notify("Save or cancel the note you are editing first.");
      return editing.area.focus();
    }
    closeEditor(false);
  }
  closePop(false);
  const e = { id: id, was: card.text, sending: false, asking: false };
  e.area = el("textarea", { class: "note-edit", rows: 1, maxlength: NOTE_LIMIT, dir: "auto", "aria-label": "Edit note: " + short(card.text) });
  e.area.value = card.text;
  e.said = el("span", { class: "edit-said", role: "status" });
  e.save = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Save" });
  e.cancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Cancel" });
  e.row = el("div", { class: "edit-row" }, [e.said, e.save, e.cancel]);
  e.area.addEventListener("input", function () {
    e.asking = false;
    patchEditor();
  });
  const escape = function (ev) {
    if (ev.key !== "Escape") return false;
    ev.preventDefault();
    ev.stopPropagation();
    leaveEditor();
    return true;
  };
  e.area.addEventListener("keydown", function (ev) {
    if (escape(ev)) return;
    // Enter saves; Shift and Enter is a new line; an Enter that only picks
    // a word in an input method is neither (229 is how Safari reports the
    // Enter that ends a composition).
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      saveEdit();
    }
  });
  e.row.addEventListener("keydown", escape);
  e.save.addEventListener("click", function () {
    // While leaving is being asked about, this button is "Keep editing".
    if (!e.asking) return saveEdit();
    e.asking = false;
    patchEditor();
    e.area.focus();
  });
  e.cancel.addEventListener("click", leaveEditor);
  editing = e;
  note.el.insertBefore(e.area, note.text);
  note.el.appendChild(e.row);
  note.el.classList.add("editing");
  patchEditor();
  e.area.focus();
  if (e.area.setSelectionRange) e.area.setSelectionRange(card.text.length, card.text.length);
  setText(live, "Editing. Enter saves, Escape cancels.");
}

// Cancel, or Escape. Words that were changed are not dropped without being
// asked about: the first time asks, in the editor's own row, with staying
// as the way out that has focus; the second time, or Discard, drops them.
// While a save is out nothing leaves: its answer is still to be heard.
function leaveEditor() {
  const e = editing;
  if (!e || e.sending) return;
  const now = cardById(e.id);
  if (e.asking || !now || e.area.value === now.text) return closeEditor(true);
  e.asking = true;
  patchEditor();
  e.save.focus();
}

export function patchEditor() {
  const e = editing;
  if (!e) return;
  const text = e.area.value;
  const room = NOTE_LIMIT - text.length;
  const empty = !text.trim();
  e.area.readOnly = e.sending;
  e.save.disabled = e.sending || (empty && !e.asking);
  e.cancel.disabled = e.sending;
  setText(e.save, e.asking ? "Keep editing" : "Save");
  setText(e.cancel, e.asking ? "Discard" : "Cancel");
  e.row.classList.toggle("asking", e.asking);
  setText(e.said, e.asking ? "Discard changes?" : e.sending ? "Saving\u2026" : empty ? "A note needs words. To remove it, use Delete in its menu." : room <= 100 ? plural(room, "character") + " left" : "");
  e.said.hidden = !e.said.textContent;
  // As tall as its words, like the paragraph it stands in for.
  e.area.style.height = "";
  if (e.area.scrollHeight > 32) e.area.style.height = e.area.scrollHeight + "px";
}

function closeEditor(refocus) {
  const e = editing;
  if (!e) return;
  editing = null;
  const note = view.notes[e.id];
  if (e.watch) forget(e.watch);
  if (e.area.parentNode) e.area.parentNode.removeChild(e.area);
  if (e.row.parentNode) e.row.parentNode.removeChild(e.row);
  if (!note) return;
  note.el.classList.remove("editing");
  if (refocus) note.more.focus();
}

function saveEdit() {
  const e = editing;
  if (!e || e.sending) return;
  const text = e.area.value.trim().slice(0, NOTE_LIMIT);
  if (!text) return;
  const now = cardById(e.id);
  if (now && text === now.text) return closeEditor(true);
  e.sending = true;
  patchEditor();
  const id = e.id;
  // Declared first: a send the bridge refuses settles before propose returns.
  let watch = null;
  watch = e.watch = propose("edit-card", { cardId: id, text: text }, {
    landed: function (b) {
      return b.cards.some(function (c) {
        return c.id === id && c.text === text;
      });
    },
    refused: { forbidden: ONLY_AUTHOR_EDITS, "not-found": NOTE_GONE, invalid: "That could not be saved as written. A note needs words, 500 characters at most." },
    unsure: "Could not confirm that the note was saved. Your words are still in the box.",
    settle: function (outcome) {
      if (outcome === "accepted" || editing !== e) return;
      e.watch = null;
      if (outcome === "landed") {
        const held = contains(view.notes[id] && view.notes[id].el, document.activeElement) || document.activeElement === document.body;
        closeEditor(held);
        setText(live, "Saved.");
        return;
      }
      // Refused, or nobody answered: the words typed stay where they are.
      if (watch && watch.reason === "forbidden") notMyNotes[id] = true;
      e.sending = false;
      patchEditor();
    },
  });
}

// The note being edited was deleted by somebody else. What was typed is not
// lost with it: it goes into its lane's box for a new note, and is said.
export function rescueDraft(columnId) {
  const e = editing;
  editing = null;
  if (e.watch) forget(e.watch);
  const text = e.area.value.trim();
  const lane = view.lanes[columnId] || view.lanes[board.columns[0] && board.columns[0].id];
  if (!text || text === e.was || !lane) {
    notify(NOTE_GONE);
    return;
  }
  // After whatever is already being typed there, on a line of its own, and
  // no longer than a note may be.
  const whole = (lane.input.value ? lane.input.value + "\n" : "") + text;
  lane.input.value = whole.slice(0, NOTE_LIMIT);
  lane.open = true;
  patchComposer(lane);
  lane.input.focus();
  notify("That note was deleted while you were editing it. Your words are in the box above, ready to add as a new note." + (whole.length > NOTE_LIMIT ? " They did not all fit with what was already there: the end was cut at " + NOTE_LIMIT + " characters." : ""));
}

// The facilitator deletes any note, through an action the host keeps for
// the facilitator. Everyone else asks as themselves, and the server answers
// no unless the note is theirs.
export function deleteNote(id) {
  // Declared first: a send the bridge refuses settles before propose returns.
  let watch = null;
  watch = propose(viewerRole() === "facilitator" ? "moderate-card" : "delete-card", { cardId: id }, {
    landed: function (b) {
      return !b.cards.some(function (c) {
        return c.id === id;
      });
    },
    refused: { forbidden: ONLY_AUTHOR, "not-found": NOTE_GONE },
    unsure: "Could not confirm that the note was deleted.",
    settle: function (outcome) {
      if (outcome === "refused" && watch && watch.reason === "forbidden") notMyNotes[id] = true;
    },
  });
}

