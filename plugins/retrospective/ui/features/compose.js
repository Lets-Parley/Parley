import { NOTE_LIMIT, OR_STORE } from "../constants/board.js";
import { el, setText } from "../utils/dom.js";
import { idsOf, short } from "../utils/text.js";
import { cardById, ui, view } from "../bridge/state.js";
import { arrive, clockNow, motionOn } from "../utils/motion.js";
import { notify } from "../components/notices.js";
import { forget, propose } from "../bridge/actions.js";
import { patchComposer } from "../components/lane.js";
import { patchLanes } from "./render.js";

// ------------------------------------------------------- notes on the way

// Enter empties the box at once, so the next thought can follow, and the
// note waits in its lane as a ghost until the state shows the real one. The
// board is one stored document, so notes are sent one at a time, in order.
let sending = null;

export function addNote(lane) {
  const text = lane.input.value.trim().slice(0, NOTE_LIMIT);
  if (!text) return;
  lane.input.value = "";
  lane.input.focus();
  patchComposer(lane);
  const ghost = buildGhost(lane, text);
  lane.ghosts.push(ghost);
  patchLanes();
  // The note drops in now, as the ghost: the real one only takes its place.
  ghost.born = clockNow();
  if (motionOn()) arrive(ghost.el);
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
    // The first send may have landed since it was called unconfirmed.
    if (ghostLanded(ghost, ui.board)) {
      dropGhost(ghost);
      return;
    }
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
  ghost.watch = null;
  if (sending === ghost) sending = null;
  ghost.lane.ghosts = ghost.lane.ghosts.filter(function (other) {
    return other !== ghost;
  });
  patchLanes();
  sendNext();
}

// A ghost has landed when the state holds a note that was not there when
// the ghost was first sent, in its lane, with its text.
function ghostLanded(ghost, b) {
  return (
    !!ghost.had &&
    b.cards.some(function (c) {
      return !ghost.had[c.id] && c.columnId === ghost.lane.id && c.text === ghost.text;
    })
  );
}

// The ghost of this viewer's a note just drawn stands for, if any.
export function myGhostOf(note) {
  const card = cardById(idOfNote(note));
  const lane = card && view.lanes[card.columnId];
  return (
    (lane &&
      lane.ghosts.filter(function (ghost) {
        return ghost.status !== "refused" && ghost.text === card.text && !!ghost.had && !ghost.had[card.id];
      })[0]) ||
    null
  );
}

export function idOfNote(note) {
  for (const id in view.notes) if (view.notes[id] === note) return id;
  return null;
}

// Run on every state push, whether or not the send is still being watched:
// a note that turns up a minute late must not leave its ghost beside it.
export function reconcileGhosts() {
  for (const id in view.lanes) {
    view.lanes[id].ghosts.slice().forEach(function (ghost) {
      if (ghost.status !== "refused" && ghostLanded(ghost, ui.board)) dropGhost(ghost);
    });
  }
}

// A lane can leave the state while a note for it is still waiting. The note
// cannot be saved any more, and it is not allowed to vanish without a word.
export function loseGhosts(lane) {
  lane.ghosts.slice().forEach(function (ghost) {
    if (ghost.watch) forget(ghost.watch);
    if (sending === ghost) sending = null;
    notify("That lane is gone, so your note was not saved: " + short(ghost.text));
  });
  lane.ghosts = [];
}

export function sendNext() {
  if (sending) return;
  let next = null;
  for (const id in view.lanes) {
    view.lanes[id].ghosts.forEach(function (ghost) {
      if (!next && ghost.status === "queued") next = ghost;
    });
  }
  if (!next) return;
  next.had = next.had || idsOf(ui.board.cards);
  sending = next;
  next.status = "saving";
  patchGhost(next);
  next.watch = propose("add-card", { columnId: next.lane.id, text: next.text }, {
    landed: function (b) {
      return ghostLanded(next, b);
    },
    refused: { conflict: "That note was not saved. A board holds 120 notes, 30 from each person." + OR_STORE },
    unsure: "Could not confirm that your note was saved. It is waiting in its lane.",
    settle: function (outcome) {
      if (outcome === "landed") {
        dropGhost(next);
        return;
      }
      if (outcome !== "accepted" && sending === next) sending = null;
      next.status = outcome === "accepted" ? "saving" : outcome;
      patchGhost(next);
      sendNext();
    },
  });
}

