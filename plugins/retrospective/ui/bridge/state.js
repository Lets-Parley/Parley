import { bag } from "../utils/bag.js";
import { STAMPS, UNKNOWN_KIND } from "../assets/stickers.js";
import { STEPS } from "../constants/board.js";

// ------------------------------------------------------------------ state

// The state is somebody else's JSON. Everything the board reads goes through
// here first, so a missing list or a note with no text is drawn as far as it
// makes sense instead of stopping the whole board.
export function rows(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(function (row) {
    return row && typeof row === "object" && (typeof row.id === "string" || typeof row.userId === "string");
  });
}

export function words(value) {
  return value === undefined || value === null ? "" : String(value);
}

function count(value) {
  return Math.max(0, Math.floor(Number(value)) || 0);
}

export function unit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function boardOf(next) {
  const b = next && typeof next.state === "object" && next.state ? next.state : {};
  const stage = Math.floor(Number(b.stage));
  const t = b.timer && typeof b.timer === "object" ? b.timer : null;
  return {
    revealed: b.revealed === true,
    stage: stage >= 0 && stage < STEPS.length ? stage : 0,
    timer: t && {
      rev: Number(t.rev) || 0,
      running: t.mode === "running",
      duration: Math.max(1, Number(t.durationMs) || 1),
      remaining: Math.max(0, Number(t.remainingMs) || 0),
    },
    stamps: rows(b.stamps)
      .filter(function (s) {
        return typeof s.kind === "string" && typeof s.cardId === "string";
      })
      .map(function (s) {
        // A kind this version does not know, from a newer one, is still
        // there and still counts against the caps: it is drawn plain.
        return { id: s.id, cardId: s.cardId, kind: STAMPS[s.kind] ? s.kind : UNKNOWN_KIND, x: unit(s.x), y: unit(s.y), rot: Math.max(-12, Math.min(12, Number(s.rot) || 0)) };
      }),
    columns: rows(b.columns).map(function (c) {
      return { id: c.id, title: words(c.title) || c.id };
    }),
    cards: rows(b.cards).map(function (c) {
      return {
        id: c.id,
        columnId: words(c.columnId),
        groupId: typeof c.groupId === "string" ? c.groupId : null,
        text: words(c.text),
        edited: c.edited === true,
        // Ups and downs; a server from before there were two sends one count, all up.
        up: count(c.up !== undefined ? c.up : c.voteCount),
        down: count(c.down),
        // What a note is ranked by: ups less downs.
        votes: count(c.up !== undefined ? c.up : c.voteCount) - count(c.down),
        authorId: typeof c.authorId === "string" ? c.authorId : null,
      };
    }),
    groups: rows(b.groups).map(function (g) {
      return { id: g.id, columnId: words(g.columnId), title: words(g.title) };
    }),
    actionItems: rows(b.actionItems).map(function (a) {
      const sources = Array.isArray(a.sourceIds) ? a.sourceIds : [];
      return {
        id: a.id,
        text: words(a.text),
        owner: words(a.owner),
        sourceIds: sources.filter(function (id) {
          return typeof id === "string";
        }),
      };
    }),
  };
}

export const view = { lanes: bag(), notes: bag(), groups: bag(), actions: bag(), stamps: bag() };
export let session = null;
export let board = boardOf(null);
export let drawn = false;
export let selected = bag();

export function cardById(id) {
  return board.cards.filter(function (c) {
    return c.id === id;
  })[0];
}

export function groupById(id) {
  return board.groups.filter(function (g) {
    return g.id === id;
  })[0];
}

export function membersOf(groupId) {
  return board.cards.filter(function (c) {
    return c.groupId === groupId;
  });
}

// A lane is read top to bottom as items: a loose note, or a group standing
// where its first note is. The order is the order of the notes in the state,
// which is the one order everybody shares.
export function itemsOf(columnId) {
  const items = [];
  const seen = bag();
  board.cards.forEach(function (c) {
    if (c.columnId !== columnId) return;
    const g = c.groupId && groupById(c.groupId);
    if (!g || g.columnId !== columnId) items.push({ id: c.id, cards: [c], votes: c.votes, up: c.up, down: c.down });
    else if (seen[g.id]) {
      seen[g.id].cards.push(c);
      seen[g.id].votes += c.votes;
      seen[g.id].up += c.up;
      seen[g.id].down += c.down;
    } else items.push((seen[g.id] = { id: g.id, group: g, cards: [c], votes: c.votes, up: c.up, down: c.down }));
  });
  return items;
}

// By ups less downs; of two the same, the one with more ups first.
export function byVotes(a, b) {
  return b.votes - a.votes || b.up - a.up;
}

export function actionsFrom(sourceId) {
  return board.actionItems.filter(function (a) {
    return a.sourceIds.indexOf(sourceId) !== -1;
  });
}

export function columnTitle(columnId) {
  const col = board.columns.filter(function (c) {
    return c.id === columnId;
  })[0];
  return col ? col.title : columnId;
}

export function selectedIds() {
  return board.cards
    .filter(function (c) {
      return selected[c.id];
    })
    .map(function (c) {
      return c.id;
    });
}

