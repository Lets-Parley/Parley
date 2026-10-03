import { bag } from "../utils/bag.js";
import { GLYPH } from "../assets/glyphs.js";
import { el, icon, setText } from "../utils/dom.js";
import { plural, short } from "../utils/text.js";
import { actionsFrom, ui, view } from "../bridge/state.js";
import { buildPerson, personById, showPerson } from "./people.js";
import { animate, motionOn, POP, tick } from "../utils/motion.js";
import { sayAgain } from "./notices.js";
import { toggles } from "./popover.js";
import { buildThumb, castVote } from "../features/voting.js";
import { openNoteMenu } from "./note-menu.js";
import { editNote } from "../features/editing.js";
import { moveNote, sideways } from "../features/moves.js";
import { drags } from "../features/drag.js";
import { watchSize } from "../features/sticker-layout.js";
import { layoutStickers } from "./sticker.js";
import { openStamps } from "./sticker-book.js";
import { patchSelection } from "./selection-bar.js";
import { lights } from "./action-list.js";
import { openLinks } from "./links.js";

// ------------------------------------------------------------------ notes

// Each control on a note does one thing. The handle in front of the text
// drags it and nothing else. The three dots after it open its menu, in every
// stage and always in the same place; the menu is also the keyboard and
// touch path for every pointer gesture on the board.
export function buildNote(id) {
  const note = {
    linked: null,
    // This viewer's vote on the note, as far as this visit knows: "up",
    // "down", "none", or null when it has not been heard from the server.
    mine: null,
    pending: null,
    voting: false,
    box: el("input", { type: "checkbox" }),
    grip: el("button", { type: "button", class: "grip", "aria-describedby": "grip-help" }, [icon(GLYPH.grip)]),
    more: el("button", { type: "button", class: "more", "aria-haspopup": "menu", title: "Options" }, [icon(GLYPH.dots, 3)]),
    // The words are a stop for the Tab key: it is from here, and not from a
    // button, that the note's single-letter keys are heard.
    text: el("p", { class: "note-text", dir: "auto", tabindex: 0 }),
    author: buildPerson(),
    target: el("button", { type: "button", class: "target", "aria-haspopup": "dialog" }, [icon(GLYPH.target)]),
    targetCount: el("span", { class: "mono" }),
    up: buildThumb("up"),
    down: buildThumb("down"),
    // What the tag shows, so that a number is seen to change only when it does.
    score: null,
    scoreText: el("b"),
    split: el("span", { class: "brk" }),
    stamps: el("ul", { class: "stamps", "aria-label": "Stickers" }),
    add: el("button", { type: "button", class: "rb add-st", "aria-haspopup": "dialog" }, [icon(GLYPH.plus)]),
    sig: "",
  };
  note.pick = el("label", { class: "pick" }, [note.box]);
  // What a note has gathered goes on a row of its own under the words, so
  // the words keep the width of the note whatever it has gathered.
  // Said in a word, not a color: the words were changed after they were written.
  note.mark = el("span", { class: "edited", text: "edited", title: "This note was edited after it was written" });
  note.chips = el("span", { class: "chips" }, [note.mark, note.target]);
  note.scoreTag = el("span", { class: "score" }, [note.scoreText]);
  note.tally = el("div", { class: "tally", role: "img" }, [note.scoreTag, note.split]);
  note.tally.hidden = true;
  note.rx = el("div", { class: "rx" }, [note.add, note.up.btn, note.down.btn]);
  note.target.appendChild(note.targetCount);
  note.el = el("li", { class: "note" }, [
    el("span", { class: "lead" }, [note.grip, note.pick]),
    note.text,
    el("span", { class: "trail" }, [note.more]),
    note.chips,
    note.author.el,
    note.rx,
    note.stamps,
    note.tally,
  ]);
  note.add.hidden = true;
  note.leaving = [];
  watchSize(note.el, "cardId", id);

  note.box.addEventListener("change", function () {
    ui.selected[id] = note.box.checked;
    patchSelection();
  });
  ["up", "down"].forEach(function (way) {
    note[way].btn.addEventListener("click", function () {
      castVote(id, way);
    });
  });
  toggles(note.more, function () {
    openNoteMenu(id, note.more);
  });
  saysHowToMove(note.grip, note);
  toggles(note.target, function () {
    openLinks(id, note.target);
  });
  lights(note.target, function () {
    return actionsFrom(id).map(function (a) {
      return view.actions[a.id] && view.actions[a.id].el;
    });
  });
  toggles(note.add, function () {
    openStamps(id, note.add);
  });
  // The words a sticker lies over are still there to be read: pointing at
  // them, or tapping them, thins the stickers on top.
  note.text.addEventListener("pointerenter", function (ev) {
    if (ev.pointerType !== "mouse") return;
    layoutStickers([id]);
    note.el.classList.add("peek");
  });
  note.text.addEventListener("pointerleave", function (ev) {
    if (ev.pointerType === "mouse") note.el.classList.remove("peek");
  });
  note.text.addEventListener("pointerup", function (ev) {
    if (ev.pointerType === "mouse") return;
    layoutStickers([id]);
    note.el.classList.toggle("peek", !note.el.classList.contains("peek"));
  });
  note.el.addEventListener("pointerleave", function (ev) {
    if (ev.pointerType === "mouse") note.el.classList.remove("peek");
  });
  // Twice on the words, or E or F2 with focus on the note, edits them.
  note.text.addEventListener("dblclick", function () {
    editNote(id);
  });
  note.el.addEventListener("keydown", function (ev) {
    // A letter is a shortcut only when focus is on the note itself or on
    // its words: never from a button, a box that is being typed in, or a
    // sticker, and never while the note's own editor is open. Otherwise
    // "due" typed anywhere near a note would vote down, up and edit it.
    const plain = !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ui.pop && (ev.target === note.el || ev.target === note.text) && !(ui.editing && ui.editing.id === id);
    if (plain && (ev.key === "e" || ev.key === "E" || ev.key === "F2")) {
      ev.preventDefault();
      editNote(id);
      return;
    }
    if (ev.target.tagName === "TEXTAREA") return;
    // U and D vote.
    if (plain && /^[uUdD]$/.test(ev.key)) {
      ev.preventDefault();
      castVote(id, /u/i.test(ev.key) ? "up" : "down");
      return;
    }
    // S opens the stickers.
    if (plain && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      openStamps(id, note.add.hidden ? note.more : note.add, note.text);
      return;
    }
    // A note whose editor is open is not moved by a key, from any control in it.
    if (ui.editing && ui.editing.id === id) return;
    const way = ev.altKey && ARROWS[ev.key];
    if (!way) return;
    ev.preventDefault();
    if (way === "left" || way === "right") sideways("note", id, way === "left" ? -1 : 1);
    else moveNote(id, ev.shiftKey ? (way === "up" ? "top" : "bottom") : way);
  });
  drags(note.grip, "note", id);
  drags(note.el, "note", id);
  return note;
}

export const ARROWS = bag({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" });
const MOVE_HELP = "Drag to move this. With the keyboard: Alt and the Up or Down arrow move it within its lane, Alt and Left or Right move it to the next lane. The options menu has every move.";
export const gripHelp = el("p", { id: "grip-help", class: "sr-only", text: MOVE_HELP });

// A handle is for dragging. Pressed without being dragged, or with Enter, it
// opens nothing and moves nothing: it says how a move is made.
export function saysHowToMove(grip, owner) {
  grip.addEventListener("click", function () {
    if (!owner.dragged) sayAgain(MOVE_HELP);
  });
}

// The control focus goes to when it is sent to a note: its checkbox while
// notes are being picked, its menu button otherwise.
export function leadOf(note) {
  return note.pick.hidden ? note.more : note.box;
}

// The vote control is quiet until a note has votes: "Vote" at zero, the
// count once there is one. It is marked as the viewer's own only when the
// host has said so.
export function patchNote(note, card) {
  const held = document.activeElement;
  const linked = actionsFrom(card.id).length;
  const brief = short(card.text);
  setText(note.text, card.text);
  note.box.setAttribute("aria-label", "Select note: " + brief);
  note.grip.setAttribute("aria-label", "Drag to reorder: " + brief);
  note.more.setAttribute("aria-label", "Options for note: " + brief);
  note.add.setAttribute("aria-label", "Add a sticker to: " + brief);

  // A vote is one press on the note in every stage. Pressed or not is said
  // only when it is known: after a reload it is not, and "not pressed"
  // would be a claim.
  const shown = note.pending !== null ? note.pending : note.mine;
  const said = scoreSaid(card.up, card.down);
  ["up", "down"].forEach(function (way) {
    const btn = note[way].btn;
    const key = way === "up" ? "U" : "D";
    btn.setAttribute("aria-label", "Vote " + way + ": " + brief + ". " + said + "." + (shown === way ? " Your vote. Press to take it back." : ""));
    btn.setAttribute("title", shown === way ? "Your vote. Press to take it back (" + key + ")" : "Vote " + way + " (" + key + ")");
    if (shown === null) btn.removeAttribute("aria-pressed");
    else btn.setAttribute("aria-pressed", shown === way ? "true" : "false");
    // With the viewer's own vote known, the pair stays in sight.
    btn.classList.toggle("known", shown === "up" || shown === "down");
  });
  // The tag: ups less downs. No votes, no tag.
  const any = card.up + card.down > 0;
  const net = card.up - card.down;
  const firstTag = note.tally.hidden && any;
  note.tally.hidden = !any;
  note.tally.setAttribute("aria-label", said);
  note.scoreTag.className = "score" + (net > 0 ? " pos" : net < 0 ? " neg" : "") + (card.up && card.down ? " mixed" : "");
  if (any) note.scoreTag.style.setProperty("--u", Math.round((100 * card.up) / (card.up + card.down)) + "%");
  setText(note.split, card.up + " up \u00b7 " + card.down + " down");
  const score = any ? signed(net) : "";
  if (note.score !== score) {
    setText(note.scoreText, score);
    // Nothing moves on the first load; after it, a new tag pops and a
    // changed number ticks, whoever's vote it was.
    if (note.score !== null && any && motionOn()) {
      if (firstTag) animate(note.scoreTag, { transform: "scale(.4)" }, POP);
      else tick(note.scoreText);
    }
    note.score = score;
  }
  note.votes = card.up + ":" + card.down;

  note.target.hidden = ui.board.stage !== 3 && linked === 0;
  note.target.classList.toggle("linked", linked > 0);
  note.target.setAttribute("aria-label", linked ? plural(linked, "action") + " from: " + brief + ". Open." : "Start an action from: " + brief);
  note.targetCount.hidden = linked === 0;
  setText(note.targetCount, String(linked));
  if (note.linked === 0 && linked > 0 && motionOn()) animate(note.target, { transform: "scale(.4)" }, POP);
  note.linked = linked;
  note.mark.hidden = !card.edited;
  note.chips.hidden = note.target.hidden && note.mark.hidden;

  const named = ui.board.revealed && card.authorId;
  note.author.el.hidden = !named;
  if (named) showPerson(note.author, personById(card.authorId));
  // A stage change can take away the control somebody was on.
  if (held === note.target && note.target.hidden) leadOf(note).focus();
}

// A score, written: ups less downs, with its sign. The minus is the real
// one, and a tie that has votes is "±0".
export function signed(net) {
  return net > 0 ? "+" + net : net < 0 ? "−" + -net : "±0";
}

// The same thing in words, with the two counts it comes from.
function scoreSaid(up, down) {
  if (up + down === 0) return "No votes yet";
  const net = up - down;
  return "Score " + (net === 0 ? "0" : signed(net)) + ": " + up + " up, " + down + " down";
}

