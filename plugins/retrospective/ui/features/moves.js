import { NOTE_GONE } from "../constants/board.js";
import { setText } from "../utils/dom.js";
import { plural } from "../utils/text.js";
import {
  board, cardById, columnTitle, groupById, itemsOf, membersOf, view,
} from "../bridge/state.js";
import { live, notify } from "../components/notices.js";
import { propose } from "../bridge/actions.js";
import { reflow, SORTED_OFF } from "../components/lane.js";
import { patchLanes } from "./render.js";
import { patchSelection } from "../components/selection-bar.js";

// ------------------------------------------------------------------ moves

// The order of the notes is shared: whoever moves one moves it for
// everybody. The move is made here first, so the note is already where it
// was put, and taken back if the host says no.
function orderKey(b) {
  return b.cards
    .map(function (c) {
      return c.id + "/" + c.columnId + "/" + c.groupId;
    })
    .concat(
      b.groups.map(function (g) {
        return g.id + "/" + g.columnId;
      }),
    )
    .join(" ");
}

// The same splice board.js makes: the note, or the group's notes together,
// taken out and set down in front of `beforeId`, or at the end without one.
function applyMove(action, body) {
  const moved = action === "move-group" ? membersOf(body.groupId) : [cardById(body.cardId)];
  const rest = board.cards.filter(function (c) {
    return moved.indexOf(c) === -1;
  });
  let at = rest.length;
  rest.forEach(function (c, i) {
    if (at === rest.length && (c.id === body.beforeId || c.groupId === body.beforeId)) at = i;
  });
  if (action === "move-group" && body.columnId) {
    groupById(body.groupId).columnId = body.columnId;
    moved.forEach(function (c) {
      c.columnId = body.columnId;
    });
  }
  if (action === "move-card") {
    const card = moved[0];
    if (body.columnId && body.columnId !== card.columnId) {
      card.columnId = body.columnId;
      card.groupId = null;
    }
    if (body.groupId === null) card.groupId = null;
    else if (body.groupId) {
      card.groupId = body.groupId;
      card.columnId = groupById(body.groupId).columnId;
    }
  }
  board.cards = rest.slice(0, at).concat(moved, rest.slice(at));
  // As board.js does: a group lasts as long as it holds a note.
  board.groups = board.groups.filter(function (g) {
    return membersOf(g.id).length;
  });
}

export function sendMove(action, body, said) {
  const mine = board;
  const was = board.cards.map(function (c) {
    return { card: c, columnId: c.columnId, groupId: c.groupId };
  });
  // Every group as it stood, one emptied by this move included.
  const lanesWere = board.groups.map(function (g) {
    return { group: g, columnId: g.columnId };
  });
  reflow(function () {
    applyMove(action, body);
    patchLanes();
    patchSelection();
  });
  const key = orderKey(board);
  setText(live, typeof said === "function" ? said() : said);
  propose(action, body, {
    landed: function (b) {
      return orderKey(b) === key;
    },
    refused: { "not-found": NOTE_GONE },
    unsure: "Could not confirm that move. The order may not have changed for everyone.",
    settle: function (outcome) {
      // A state that arrived since is the server's own order already.
      if ((outcome !== "refused" && outcome !== "unsure") || board !== mine) return;
      reflow(function () {
        board.cards = was.map(function (w) {
          w.card.columnId = w.columnId;
          w.card.groupId = w.groupId;
          return w.card;
        });
        board.groups = lanesWere.map(function (w) {
          w.group.columnId = w.columnId;
          return w.group;
        });
        patchLanes();
        patchSelection();
      });
    },
  });
}

// Where `at` ends up when it goes up, down, to the top or to the bottom of
// `count` places, or -1 when it is already there.
function placeFor(at, count, way) {
  const to = way === "up" ? at - 1 : way === "down" ? at + 1 : way === "top" ? 0 : count - 1;
  if (to < 0 || to >= count || to === at) {
    setText(live, "Already at the " + (way === "up" || way === "top" ? "top" : "bottom") + ".");
    return -1;
  }
  return to;
}

// Where a note or a group is now, in words, once it has been moved.
export function placeSaid(kind, id) {
  const thing = kind === "group" ? groupById(id) : cardById(id);
  const group = kind === "note" && thing.groupId && groupById(thing.groupId);
  const places = group ? membersOf(group.id) : itemsOf(thing.columnId);
  const at = places.findIndex(function (p) {
    return p.id === id;
  });
  const lane = view.lanes[thing.columnId];
  return (
    (kind === "group" ? "Group " + thing.title + " moved" : "Moved") +
    " to " +
    (group ? "the group " + group.title : columnTitle(thing.columnId)) +
    ", position " +
    (at + 1) +
    " of " +
    places.length +
    "." +
    (lane && lane.sorted ? " That lane is sorted by rating for you: this is its place in the shared order." : "")
  );
}

// To another lane, at its end. The menu, Alt with Left or Right and a drop
// on a lane's empty space all come through here, so they ask for the same thing.
export function toLane(kind, id, columnId) {
  sendMove(kind === "group" ? "move-group" : "move-card", kind === "group" ? { groupId: id, columnId: columnId } : { cardId: id, columnId: columnId }, function () {
    return placeSaid(kind, id);
  });
}

export function sideways(kind, id, step) {
  const thing = kind === "group" ? groupById(id) : cardById(id);
  if (!thing) return;
  const at = board.columns.findIndex(function (c) {
    return c.id === thing.columnId;
  });
  const to = board.columns[at + step];
  if (to) toLane(kind, id, to.id);
  else setText(live, "Already in the " + (step < 0 ? "first" : "last") + " lane.");
}

// A note moves among the notes of its group, or among the items of its lane.
export function moveNote(id, way) {
  const card = cardById(id);
  if (!card) return;
  if (view.lanes[card.columnId].sorted) {
    notify(SORTED_OFF);
    return;
  }
  const group = card.groupId && groupById(card.groupId);
  const places = group ? membersOf(group.id) : itemsOf(card.columnId);
  const at = places.findIndex(function (p) {
    return p.id === id;
  });
  const to = placeFor(at, places.length, way);
  if (to === -1) return;
  // Going down, it is set in front of whatever follows its new neighbor.
  const before = places[to > at ? to + 1 : to];
  const body = { cardId: id };
  if (before) body.beforeId = before.id;
  const where = group ? "the group " + group.title : columnTitle(card.columnId);
  sendMove("move-card", body, "Moved " + way.replace("top", "to top").replace("bottom", "to bottom") + ". Position " + (to + 1) + " of " + places.length + " in " + where + ".");
}

export function moveGroup(id, way) {
  const group = groupById(id);
  if (!group) return;
  if (view.lanes[group.columnId].sorted) {
    notify(SORTED_OFF);
    return;
  }
  const places = itemsOf(group.columnId);
  const at = places.findIndex(function (p) {
    return p.id === id;
  });
  const to = placeFor(at, places.length, way);
  if (to === -1) return;
  const before = places[to > at ? to + 1 : to];
  const body = { groupId: id };
  if (before) body.beforeId = before.id;
  sendMove("move-group", body, "Group " + group.title + " moved to position " + (to + 1) + " of " + plural(places.length, "item") + " in " + columnTitle(group.columnId) + ".");
}

