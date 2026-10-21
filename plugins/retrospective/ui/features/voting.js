import { bag } from "../utils/bag.js";
import { NOTE_GONE, WAIT_MS } from "../constants/board.js";
import { contains, el, icon, setText } from "../utils/dom.js";
import { cardById, view } from "../bridge/state.js";
import { animate, clockNow, motionOn, NUDGE } from "../utils/motion.js";
import { live, notify } from "../components/notices.js";
import { propose } from "../bridge/actions.js";
import { patchNote } from "../components/note.js";
import { svgOf } from "./sticker-layout.js";

// The thumb: the vote sticker's outline as a line glyph, in a view box set
// on the outline's own bounds so the ink sits on the button's center. Down
// is the same glyph turned over.
const THUMB = "M8.5 18.5h5v14h-5zM16 18.6l4.6-10.4c2.6-.3 4.3 1.9 3.7 4.4l-1 4.4h6.2c2.1 0 3.6 1.9 3.1 3.9l-2.1 8.6c-.4 1.7-1.9 2.9-3.7 2.9H16z";

const DOUBLE_MS = 400;
const RETRY_MS = 600;
// What a host answers when the vote may well go through a moment later.
// `busy` is what newer hosts say for a server that is not ready.
const PASSING = bag({ failed: true, "rate-limited": true, unreachable: true, busy: true, unsent: true });
const VOTE_LOST = "Your vote did not go through.";

export function buildThumb(way) {
  const thumb = {};
  thumb.icon = svgOf("6.1 5.84 29 29", [["", THUMB]]);
  const line = { fill: "none", stroke: "currentColor", "stroke-width": 3.1, "stroke-linejoin": "round", "stroke-linecap": "round" };
  for (const key in line) thumb.icon.children[0].setAttribute(key, line[key]);
  thumb.btn = el("button", { type: "button", class: "rb rate " + way }, [thumb.icon]);
  return thumb;
}

// Voting sets a vote; it does not flip one. The state carries counts and
// nothing about whose votes they are, so which thumb is this viewer's is
// known only from what the host has answered in this visit:
//
//   known up    press up: take it back (none)   press down: switch to down
//   known down  press down: take it back        press up: switch to up
//   none, or not known (after a reload)         press either: set it
//
// Not knowing, a press on the thumb somebody already holds sets it again,
// which the server takes and which changes nothing: no vote is ever lost
// by making sure of it. The host's yes then says it is theirs, and only a
// second press takes it back. A vote set to what it already was shows
// nothing new in the state, so for a vote the host's yes is enough.
export function castVote(id, way) {
  const note = view.notes[id];
  const card = cardById(id);
  if (!note || !card || note.voting) return;
  // Two presses of one thumb in quick succession are one press: a double
  // click must not set a vote and then take it straight back.
  const now = clockNow();
  if (note.pressed && note.pressed.way === way && now - note.pressed.at < DOUBLE_MS) return;
  note.pressed = { way: way, at: now };
  // A press acts on what the thumb shows: a vote the state has shown but
  // the host has not yet answered for is already drawn as the viewer's.
  const shown = note.pending !== null ? note.pending : note.mine;
  sendVote(id, way, shown === way ? "none" : way, true);
}

// The thumb shows pressed at once; the tag does not change until the state
// does. A vote the host could not take just now is sent once more, quietly,
// a moment later: it is a set, so sending it twice counts once. If that
// fails too, the thumb goes back to what it was and the note says so, with
// the way to try again. A no that trying again would not change is said
// the same way, without the button.
function sendVote(id, way, value, first) {
  const note = view.notes[id];
  const card = cardById(id);
  if (!note || !card) return;
  const before = { up: card.up, down: card.down };
  clearOops(note);
  note.voting = true;
  note.pending = value;
  patchNote(note, card);
  const again = function () {
    note.voting = false;
    note.pending = null;
    if (cardById(id)) patchNote(note, cardById(id));
  };
  // Declared first: a send the bridge refuses settles before propose returns.
  let watch = null;
  watch = propose("vote", { cardId: id, value: value }, {
    landed: function (b) {
      const now = b.cards.filter(function (c) {
        return c.id === id;
      })[0];
      if (!now) return true;
      return value === "none" ? now[way] < before[way] : now[value] > before[value];
    },
    refused: { "not-found": NOTE_GONE, conflict: "That vote was not counted. The board has all the votes it can hold.", forbidden: "You are not allowed to vote in this room." },
    unsure: value === "none" ? "Could not confirm that your vote was taken back." : "No change to show. Your vote may already have been counted that way.",
    yesIsEnough: true,
    says: function (message, reason) {
      if (!view.notes[id] || !cardById(id)) return notify(message);
      const passing = PASSING[reason || "unsent"];
      if (passing && first) {
        // Still shown as pressed, and still not to be pressed again.
        note.voting = true;
        note.pending = value;
        patchNote(note, cardById(id));
        note.retry = setTimeout(function () {
          note.retry = 0;
          sendVote(id, way, value, false);
        }, RETRY_MS);
        return;
      }
      showOops(id, way, value, passing ? VOTE_LOST : message, !!passing);
    },
    settle: function (outcome) {
      if (outcome === "accepted") {
        // The host took it: it is this viewer's, whatever the counts did.
        note.mine = value;
        again();
        setText(live, value === "none" ? "Vote taken back." : "Voted " + value + ".");
        // A small press back from the thumb, and the tag takes the hit.
        if (value !== "none" && motionOn()) {
          animate(note[value].icon, { transform: "scale(1.22)" }, NUDGE);
          if (!note.tally.hidden) animate(note.scoreTag, { transform: "translateY(" + (value === "up" ? -2 : 2) + "px)" }, NUDGE, 60);
        }
        return;
      }
      // The state moved before the host answered: the answer, which says
      // whose it was, is still to come. A host that answers nothing leaves
      // it unknown, and a count that moved may be a teammate's.
      if (outcome === "landed" && watch && watch.asked && !watch.accepted) {
        note.voting = false;
        // An answer that never comes does not leave the thumb looking held.
        setTimeout(function () {
          if (!watch.accepted && note.pending === value) again();
        }, WAIT_MS);
        return;
      }
      if (!(watch && watch.accepted)) again();
    },
  });
}

// On the note, under the buttons: what went wrong with the vote, and, when
// trying again could help, the button that does. It stays until it is
// used or dismissed, or a vote on the note is sent.
function showOops(id, way, value, message, retry) {
  const note = view.notes[id];
  clearOops(note);
  const close = el("button", { type: "button", class: "oops-x", "aria-label": "Dismiss" }, [icon("M4.5 4.5l7 7M11.5 4.5l-7 7")]);
  const parts = [el("span", { text: message })];
  let go = null;
  if (retry) {
    go = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Try again" });
    go.addEventListener("click", function () {
      clearOops(note);
      note[way].btn.focus();
      sendVote(id, way, value, true);
    });
    parts.push(go);
  }
  parts.push(close);
  close.addEventListener("click", function () {
    clearOops(note);
    note[way].btn.focus();
  });
  note.oops = el("div", { class: "oops", role: "group", "aria-label": "Vote not counted" }, parts);
  note.failed = note[way].btn;
  note.failed.classList.add("failed");
  note.el.appendChild(note.oops);
  // Focus goes to the panel only from the note's own buttons, or from
  // nowhere: somebody typing elsewhere keeps their place and hears it.
  const held = document.activeElement;
  if (held === document.body || contains(note.rx, held)) (go || close).focus();
  setText(live, retry ? "Your vote on this note did not go through. Try again is available." : message);
}

function clearOops(note) {
  if (!note.oops) return;
  if (note.oops.parentNode) note.oops.parentNode.removeChild(note.oops);
  note.failed.classList.remove("failed");
  note.oops = null;
}

