import { bag } from "../utils/bag.js";
import {
  NOT_KNOWN_MINE, NOTE_GONE, ONLY_PRESSER, ST_STEP, STAMP_CAPS,
} from "../constants/board.js";
import { setText } from "../utils/dom.js";
import { idsOf } from "../utils/text.js";
import { board, view } from "../bridge/state.js";
import { viewerRole } from "../components/people.js";
import { animate, clockNow, motionOn, SLAP } from "../utils/motion.js";
import { live, notify } from "../components/notices.js";
import { propose } from "../bridge/actions.js";
import {
  centerOf, fractionAt, freeSpot, mineStamps, moves, noteBox, notMine, pileOf,
  pressing, removing, saidKind, stampAt, topOf,
} from "./sticker-layout.js";
import { patchStamps } from "../components/sticker.js";

export function isPress(s, wait) {
  const sent = wait.body;
  return !wait.had[s.id] && s.cardId === sent.cardId && s.kind === sent.kind && s.x === sent.x && s.y === sent.y && s.rot === sent.rot;
}

export function pressStamp(cardId, kind) {
  const spot = freeSpot(cardId, noteBox(cardId), kind);
  // The tilt is the hand's: a little different every time.
  const wait = { at: clockNow(), had: idsOf(board.stamps), body: { cardId: cardId, kind: kind, x: spot.x, y: spot.y, rot: Math.round((Math.random() * 18 - 9) * 10) / 10 } };
  pressing.push(wait);
  patchStamps();
  propose("stamp", wait.body, {
    landed: function (b) {
      return b.stamps.some(function (s) {
        return isPress(s, wait);
      });
    },
    refused: { conflict: STAMP_CAPS, failed: STAMP_CAPS, "not-found": NOTE_GONE },
    unsure: "Could not confirm that the sticker was placed.",
    settle: function (outcome) {
      if (outcome !== "refused") return;
      pressing = pressing.filter(function (other) {
        return other !== wait;
      });
      patchStamps();
    },
  });
}

// The state is one payload for every viewer, so it cannot say which
// stickers are whose. A sticker is known to be this viewer's when it was
// placed, or the server took a change to it, in this visit; the facilitator
// may change any. Only those look movable.
export function ownStamp(id) {
  return viewerRole() === "facilitator" || !!mineStamps[id];
}

export function mayMove(id) {
  if (ownStamp(id)) return true;
  notify(notMine[id] ? ONLY_PRESSER : NOT_KNOWN_MINE);
  return false;
}

// Removing is asked of the server for any sticker it has not already
// refused: it knows whose a sticker is after a reload, and the board does not.
function mayRemove(id) {
  if (ownStamp(id) || !notMine[id]) return true;
  notify(ONLY_PRESSER);
  return false;
}

export function stampById(id) {
  return board.stamps.filter(function (s) {
    return s.id === id;
  })[0];
}

function rankOn(b, id) {
  const s = b.stamps.filter(function (o) {
    return o.id === id;
  })[0];
  return s
    ? b.stamps
        .filter(function (o) {
          return o.cardId === s.cardId;
        })
        .indexOf(s)
    : -1;
}

// The facilitator moves and removes any sticker, through an action the host
// keeps for the facilitator. Everyone else asks as themselves, and the
// server answers no unless the sticker is theirs. A move puts the sticker
// on top of its pile, so bringing one to the front is a move to where it is.
export function sendStamp(id, remove, front) {
  const lead = viewerRole() === "facilitator";
  const at = stampAt[id];
  if (!remove && !at) return;
  const body = { stampId: id };
  if (remove && lead) body.remove = true;
  if (remove) removing[id] = true;
  if (!remove) {
    body.x = at.x;
    body.y = at.y;
  }
  const rank = rankOn(board, id);
  // Declared first: a send the bridge refuses settles before propose returns.
  let watch = null;
  watch = propose(lead ? "moderate-stamp" : remove ? "remove-stamp" : "move-stamp", body, {
    landed: function (b) {
      const now = b.stamps.filter(function (s) {
        return s.id === id;
      })[0];
      if (remove || !now) return !now;
      if (now.x !== at.x || now.y !== at.y) return false;
      // A teammate may have put one on top since: higher than it was is enough.
      return !front || topOf(b, now.cardId) === id || rankOn(b, id) > rank;
    },
    refused: { forbidden: ONLY_PRESSER, failed: ONLY_PRESSER, "not-found": "That sticker is no longer on the board." },
    unsure: remove ? "Could not confirm that the sticker was removed." : front ? "Could not confirm that the sticker was brought to the front." : "Could not confirm that the sticker moved.",
    settle: function (outcome) {
      // The sticker is this viewer's once the server said yes and the state
      // shows the change: a yes the state contradicts proves nothing.
      if (watch && watch.accepted && watch.shown && !mineStamps[id]) {
        mineStamps[id] = true;
        patchStamps();
      }
      if (outcome === "accepted") return;
      if (outcome !== "landed" && watch && (watch.reason === "failed" || watch.reason === "forbidden")) notMine[id] = true;
      // Landed, refused or given up on: the state is what is drawn now.
      if (stampAt[id] === at) delete stampAt[id];
      patchStamps();
    },
  });
}

export function nudgeStamp(id, dx, dy, far, held) {
  const s = stampById(id);
  if (!s || !mayMove(id)) return;
  const box = noteBox(s.cardId);
  const from = stampAt[id] || s;
  const c = centerOf(from, box);
  const step = ST_STEP * (far ? 4 : 1);
  const to = fractionAt(c[0] + dx * step, c[1] + dy * step, box);
  if (to.x === from.x && to.y === from.y) {
    // Said once for a key that is held down, not on every repeat.
    if (!held) setText(live, "At the edge of the note.");
    return;
  }
  to.n = ++moves;
  stampAt[id] = to;
  patchStamps();
  // Several presses of an arrow key are one move.
  const stamp = view.stamps[id];
  clearTimeout(stamp.timer);
  stamp.timer = setTimeout(function () {
    settleStamp(id);
  }, 500);
}

export function settleStamp(id) {
  const stamp = view.stamps[id];
  const s = stampById(id);
  if (!stamp || !stamp.timer) return;
  clearTimeout(stamp.timer);
  stamp.timer = 0;
  if (s && stampAt[id] && (stampAt[id].x !== s.x || stampAt[id].y !== s.y)) {
    setText(live, saidKind(s.kind) + " moved.");
    sendStamp(id, false);
  }
}

export function removeStamp(id) {
  if (mayRemove(id)) sendStamp(id, true);
}

export function frontStamp(id) {
  const s = stampById(id);
  const stamp = view.stamps[id];
  if (!s || !stamp || !mayMove(id)) return;
  // Keys still resting are part of the same move.
  clearTimeout(stamp.timer);
  stamp.timer = 0;
  const from = stampAt[id] || s;
  const pile = drawnPile(s.cardId);
  if (pile[pile.length - 1] === s && from.x === s.x && from.y === s.y) {
    setText(live, "Already at the front.");
    return;
  }
  stampAt[id] = { x: from.x, y: from.y, n: ++moves };
  patchStamps();
  if (motionOn()) animate(stamp.art, { transform: "scale(1.2)" }, SLAP);
  setText(live, saidKind(s.kind) + " brought to the front.");
  sendStamp(id, false, true);
}

// The pile as it is drawn: the state's order, with what this viewer has
// just moved on top.
export function drawnPile(cardId) {
  const list = pileOf(cardId);
  return list
    .filter(function (s) {
      return !stampAt[s.id];
    })
    .concat(
      list
        .filter(function (s) {
          return stampAt[s.id];
        })
        .sort(function (a, b) {
          return stampAt[a.id].n - stampAt[b.id].n;
        }),
    );
}

// A note's stickers are one stop for the Tab key: the last one focused, or
// the one on top. Page Up and Page Down go through the pile from there, so
// a sticker lying under another can be reached without aiming at it.
export function patchStampStops(cardId, pile) {
  const note = view.notes[cardId];
  const stop =
    pile.filter(function (s) {
      return s.id === note.stampStop;
    })[0] || pile[pile.length - 1];
  pile.forEach(function (s) {
    view.stamps[s.id].btn.setAttribute("tabindex", s === stop ? "0" : "-1");
  });
}

export function walkPile(id, key) {
  const s = stampById(id);
  if (!s) return;
  const pile = drawnPile(s.cardId);
  const at = pile.indexOf(s);
  const to = Math.max(0, Math.min(pile.length - 1, key === "Home" ? 0 : key === "End" ? pile.length - 1 : at + (key === "PageUp" ? 1 : -1)));
  if (to === at) {
    setText(live, at === 0 && key !== "PageUp" && key !== "End" ? "Bottom of the pile." : "Top of the pile.");
    return;
  }
  view.stamps[pile[to].id].btn.focus();
}

export const STEPS_BY_KEY = bag({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });
export const PILE_KEYS = bag({ PageUp: 1, PageDown: 1, Home: 1, End: 1 });

