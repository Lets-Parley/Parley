"use strict";

// Write, Group, Vote, Decide. The stage says what the room is looking at; it
// gates nothing, so a late note or vote is accepted in any of them.
const STAGES = 4;

// A stamp is pressed onto a note at a point inside it: x and y are fractions
// of the note's width and height, so the same stamp sits in the same place on
// a phone and on a wide screen.
const STAMP_KINDS = ["me-too", "thanks", "idea", "quick-win", "chat", "blocker", "laugh"];
const STAMPS_PER_PERSON_PER_NOTE = 3;
const STAMPS_PER_NOTE = 12;
const STAMPS_PER_BOARD = 300;
const STAMP_TILT = 12;

const TIMER_MIN_MS = 10 * 1000;
const TIMER_MAX_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const SOURCES_PER_ACTION = 12;

function emptyBoard() {
  return {
    revealed: false,
    stage: 0,
    timer: null,
    timerRev: 0,
    stamps: [],
    nextId: 1,
    columns: [
      { id: "went-well", title: "Went well" },
      { id: "to-improve", title: "To improve" },
      { id: "puzzles", title: "Puzzles" },
    ],
    cards: [],
    groups: [],
    actionItems: [],
  };
}

function takeId(board, prefix) {
  const id = prefix + board.nextId;
  board.nextId += 1;
  return id;
}

function column(board, columnId) {
  return board.columns.find((c) => c.id === columnId);
}

function card(board, cardId) {
  return board.cards.find((c) => c.id === cardId);
}

function clip(text, n) {
  const s = String(text ?? "").trim();
  if (!s) throw new Error("text is required");
  return s.length > n ? s.slice(0, n) : s;
}

// A board stored by an earlier version has none of the newer fields.
function withDefaults(board) {
  if (!(board.stage >= 0 && board.stage < STAGES)) board.stage = 0;
  if (!board.timer) board.timer = null;
  if (!board.timerRev) board.timerRev = 0;
  if (!Array.isArray(board.stamps)) board.stamps = [];
  for (const item of board.actionItems) if (!Array.isArray(item.sourceIds)) item.sourceIds = [];
  return board;
}

function group(board, groupId) {
  return board.groups.find((g) => g.id === groupId);
}

function votesOf(row) {
  return Object.keys(row.votes).length;
}

// An action item can point at the notes or groups it came from.
function isSource(board, id) {
  return typeof id === "string" && !!(card(board, id) || group(board, id));
}

// Where a moved note or group goes: in front of a note, in front of a group
// (its first note), or, when the target is missing, to the end.
function indexBefore(board, beforeId) {
  let at = board.cards.findIndex((c) => c.id === beforeId);
  if (at === -1 && group(board, beforeId)) at = board.cards.findIndex((c) => c.groupId === beforeId);
  return at === -1 ? board.cards.length : at;
}

function fraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("a stamp sits inside its note: x and y run from 0 to 1");
  }
  return Math.round(value * 1000) / 1000;
}

function stamp(board, stampId) {
  const row = board.stamps.find((s) => s.id === stampId);
  if (!row) throw new Error("unknown stamp");
  return row;
}

function removeStamp(board, row) {
  board.stamps.splice(board.stamps.indexOf(row), 1);
}

function clock(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("the timer needs a clock");
  return now;
}

function remaining(timer, now) {
  return timer.mode === "running" ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
}

// redactBoard is the only thing that decides what leaves the server. Authors
// leave only while revealed. Who voted and who pressed a stamp never do.
// `now` is the server's clock: the timer is published as time remaining, so no
// viewer has to trust its own clock against the server's.
function redactBoard(board, now) {
  withDefaults(board);
  const out = {
    revealed: board.revealed,
    stage: board.stage,
    timer: board.timer && {
      rev: board.timerRev,
      mode: board.timer.mode,
      durationMs: board.timer.durationMs,
      remainingMs: remaining(board.timer, clock(now)),
    },
    stamps: board.stamps.map((s) => ({ id: s.id, cardId: s.cardId, kind: s.kind, x: s.x, y: s.y, rot: s.rot })),
    columns: board.columns.map((c) => ({ id: c.id, title: c.title })),
    groups: board.groups.map((g) => ({ id: g.id, columnId: g.columnId, title: g.title })),
    cards: board.cards.map((c) => {
      const row = {
        id: c.id,
        columnId: c.columnId,
        groupId: c.groupId,
        text: c.text,
        voteCount: Object.keys(c.votes).length,
      };
      if (board.revealed) row.authorId = c.authorId;
      return row;
    }),
    actionItems: board.actionItems.map((a) => ({
      id: a.id,
      text: a.text,
      owner: a.owner,
      done: a.done,
      sourceIds: a.sourceIds.filter((id) => isSource(board, id)),
    })),
  };
  return out;
}

// The actions marked facilitator-only in manifest.json (reveal, conceal,
// set-stage, timer, order-by-votes, moderate-stamp) are refused by the host
// for anyone else before the guest is called: the guest is never told who the
// facilitator is. Everything else is checked here.
function applyAction(board, { action, user, body, now }) {
  body = body && typeof body === "object" ? body : {};
  withDefaults(board);
  switch (action) {
    case "add-card": {
      if (!column(board, body.columnId)) throw new Error("unknown column");
      const row = {
        id: takeId(board, "c"),
        columnId: body.columnId,
        groupId: null,
        text: clip(body.text, 500),
        authorId: user,
        votes: {},
      };
      board.cards.push(row);
      return row;
    }
    case "group-cards": {
      const ids = Array.isArray(body.cardIds) ? body.cardIds : [];
      if (ids.length < 2) throw new Error("grouping needs at least two cards");
      const rows = ids.map((id) => card(board, id));
      if (rows.some((r) => !r)) throw new Error("unknown card");
      const columnId = rows[0].columnId;
      if (rows.some((r) => r.columnId !== columnId)) throw new Error("cards must share a column");
      const group = {
        id: takeId(board, "g"),
        columnId,
        title: clip(body.title || "group", 80),
      };
      board.groups.push(group);
      for (const r of rows) r.groupId = group.id;
      return group;
    }
    case "vote": {
      const row = card(board, body.cardId);
      if (!row) throw new Error("unknown card");
      row.votes[user] = 1;
      return row;
    }
    case "reveal": {
      board.revealed = true;
      return board;
    }
    case "conceal": {
      board.revealed = false;
      return board;
    }
    case "set-stage": {
      if (!Number.isInteger(body.stage) || body.stage < 0 || body.stage >= STAGES) throw new Error("unknown stage");
      board.stage = body.stage;
      // A timer belongs to the stage it was started in.
      board.timer = null;
      board.timerRev += 1;
      return board;
    }
    case "timer": {
      now = clock(now);
      const t = board.timer;
      if (body.op === "start") {
        const ms = body.durationMs;
        if (!Number.isInteger(ms) || ms < TIMER_MIN_MS || ms > TIMER_MAX_MS) throw new Error("a timer runs from ten seconds to three hours");
        board.timer = { mode: "running", durationMs: ms, endsAt: now + ms, remainingMs: ms };
      } else if (body.op === "clear") {
        board.timer = null;
      } else if (!t) {
        throw new Error("no timer is set");
      } else if (body.op === "pause") {
        t.remainingMs = remaining(t, now);
        t.mode = "paused";
      } else if (body.op === "resume") {
        if (t.mode === "paused") t.endsAt = now + t.remainingMs;
        t.mode = "running";
      } else if (body.op === "add") {
        // One more minute, also for a timer that has already run out.
        t.remainingMs = Math.min(remaining(t, now) + MINUTE_MS, TIMER_MAX_MS);
        t.endsAt = now + t.remainingMs;
        t.durationMs = Math.max(t.durationMs, t.remainingMs);
      } else {
        throw new Error("unknown timer operation");
      }
      board.timerRev += 1;
      return board.timer;
    }
    case "move-card": {
      const row = card(board, body.cardId);
      if (!row) throw new Error("unknown card");
      let columnId = row.columnId;
      let groupId = row.groupId;
      if (body.columnId !== undefined) {
        if (!column(board, body.columnId)) throw new Error("unknown column");
        if (body.columnId !== columnId) groupId = null;
        columnId = body.columnId;
      }
      if (body.groupId === null) groupId = null;
      else if (body.groupId !== undefined) {
        const joined = group(board, body.groupId);
        if (!joined) throw new Error("unknown group");
        groupId = joined.id;
        columnId = joined.columnId;
      }
      board.cards.splice(board.cards.indexOf(row), 1);
      board.cards.splice(indexBefore(board, body.beforeId), 0, row);
      row.columnId = columnId;
      row.groupId = groupId;
      return row;
    }
    case "move-group": {
      const moved = group(board, body.groupId);
      if (!moved) throw new Error("unknown group");
      const members = board.cards.filter((c) => c.groupId === moved.id);
      board.cards = board.cards.filter((c) => c.groupId !== moved.id);
      board.cards.splice(indexBefore(board, body.beforeId), 0, ...members);
      return moved;
    }
    case "order-by-votes": {
      if (!column(board, body.columnId)) throw new Error("unknown column");
      // The lane's notes are re-dealt into the places the lane already holds,
      // so no other lane's order is touched. A group is ranked by the votes
      // of its notes together and keeps them side by side.
      const places = [];
      const items = [];
      const byGroup = {};
      board.cards.forEach((c, i) => {
        if (c.columnId !== body.columnId) return;
        places.push(i);
        let item = c.groupId && byGroup[c.groupId];
        if (!item) {
          item = { votes: 0, cards: [] };
          items.push(item);
          if (c.groupId) byGroup[c.groupId] = item;
        }
        item.cards.push(c);
        item.votes += votesOf(c);
      });
      // Array.prototype.sort is stable: ties keep the shared order.
      items.sort((a, b) => b.votes - a.votes);
      const dealt = items.flatMap((item) => item.cards.sort((a, b) => votesOf(b) - votesOf(a)));
      places.forEach((at, i) => {
        board.cards[at] = dealt[i];
      });
      return board;
    }
    case "stamp": {
      const row = card(board, body.cardId);
      if (!row) throw new Error("unknown card");
      if (!STAMP_KINDS.includes(body.kind)) throw new Error("unknown stamp");
      const x = fraction(body.x);
      const y = fraction(body.y);
      const tilt = typeof body.rot === "number" && Number.isFinite(body.rot) ? body.rot : 0;
      const onNote = board.stamps.filter((s) => s.cardId === row.id);
      if (board.stamps.length >= STAMPS_PER_BOARD) throw new Error("the board is full of stamps");
      if (onNote.length >= STAMPS_PER_NOTE) throw new Error("this note is full of stamps");
      if (onNote.filter((s) => s.by === user).length >= STAMPS_PER_PERSON_PER_NOTE) {
        throw new Error("that is every stamp one person may press on one note");
      }
      const pressed = {
        id: takeId(board, "s"),
        cardId: row.id,
        kind: body.kind,
        x,
        y,
        rot: Math.round(Math.max(-STAMP_TILT, Math.min(STAMP_TILT, tilt)) * 10) / 10,
        by: user,
      };
      board.stamps.push(pressed);
      return pressed;
    }
    // A stamp is moved or lifted by whoever pressed it. The facilitator's way
    // in is moderate-stamp, which the host keeps for the facilitator.
    case "move-stamp":
    case "remove-stamp":
    case "moderate-stamp": {
      const row = stamp(board, body.stampId);
      if (action !== "moderate-stamp" && row.by !== user) throw new Error("only the person who pressed a stamp can change it");
      if (action === "remove-stamp" || (action === "moderate-stamp" && body.remove === true)) {
        removeStamp(board, row);
        return row;
      }
      const x = fraction(body.x);
      row.y = fraction(body.y);
      row.x = x;
      return row;
    }
    case "add-action": {
      const text = clip(body.text, 500);
      const wanted = Array.isArray(body.sourceIds) ? body.sourceIds.slice(0, SOURCES_PER_ACTION) : [];
      const item = {
        id: takeId(board, "a"),
        text,
        owner: String(body.owner || user).slice(0, 64),
        done: false,
        // Ids the board does not hold are dropped: a note may have moved on.
        sourceIds: wanted.filter((id, i) => isSource(board, id) && wanted.indexOf(id) === i),
      };
      board.actionItems.push(item);
      return item;
    }
    case "link-action": {
      const item = board.actionItems.find((a) => a.id === body.actionId);
      if (!item) throw new Error("unknown action item");
      if (!isSource(board, body.sourceId)) throw new Error("unknown note or group");
      if (typeof body.linked !== "boolean") throw new Error("linked is true or false");
      const at = item.sourceIds.indexOf(body.sourceId);
      if (body.linked && at === -1) {
        if (item.sourceIds.length >= SOURCES_PER_ACTION) throw new Error("this action is linked to as many notes as it can hold");
        item.sourceIds.push(body.sourceId);
      }
      if (!body.linked && at !== -1) item.sourceIds.splice(at, 1);
      return item;
    }
    default:
      throw new Error("unknown action");
  }
}

module.exports = { emptyBoard, redactBoard, applyAction, STAMP_KINDS };
