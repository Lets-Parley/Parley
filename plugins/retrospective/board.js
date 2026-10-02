"use strict";

// Write, Group, Vote, Decide. The stage says what the room is looking at; it
// gates nothing, so a late note or vote is accepted in any of them.
const STAGES = 4;

// A sticker is placed on a note at a point inside it: x and y are fractions
// of the note's width and height, so the same sticker sits in the same place
// on a phone and on a wide screen. There are seven meanings in two printings:
// the plain ids are the vinyl set, which is what boards stored before the
// pixel set existed already hold, and `p-` is the pixel set. The actions and
// the stored field keep the name they shipped with, "stamp".
const STAMP_MEANINGS = ["me-too", "thanks", "idea", "quick-win", "chat", "blocker", "laugh"];
const STAMP_KINDS = STAMP_MEANINGS.concat(STAMP_MEANINGS.map((m) => "p-" + m));
// Looked up by identity, so "constructor" or an array is not a kind.
const KNOWN_KINDS = new Set(STAMP_KINDS);
const STAMP_TILT = 12;

const TIMER_MIN_MS = 10 * 1000;
const TIMER_MAX_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Every board of an org is a key in one store with one quota (manifest.json,
// quotaBytes). These hold a single board to about a third of it at the very
// worst; the arithmetic is in README.md and a test builds that board.
const LIMITS = {
  notes: 120,
  notesPerPerson: 30,
  noteText: 500,
  groups: 40,
  groupTitle: 80,
  notesPerGrouping: 50,
  votes: 1000,
  stamps: 300,
  stampsPerNote: 12,
  stampsPerPersonPerNote: 3,
  stampsPerPerson: 60,
  actions: 30,
  actionText: 500,
  owner: 64,
  sourcesPerAction: 12,
};

// What the server will not do because of what was asked, as opposed to what it
// could not do because something is broken. The guest answers the host with
// the code and saves nothing; anything else thrown is a real fault.
//
//   invalid    the request makes no sense as written
//   forbidden  it is somebody else's to change
//   not-found  it names a note, group, stamp or action the board does not hold
//   conflict   the board cannot take it as it stands: a cap, or no timer set
class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.refused = code;
  }
}

function refuse(code, message) {
  throw new Refusal(code, message);
}

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

// A row of `list` by its id, or a refusal. An id that is not a string is no
// id at all, whatever it would compare equal to.
function find(list, id, what) {
  const row = typeof id === "string" ? list.find((r) => r.id === id) : undefined;
  if (!row) refuse("not-found", "unknown " + what);
  return row;
}

function column(board, columnId) {
  return find(board.columns, columnId, "column");
}

function card(board, cardId) {
  return find(board.cards, cardId, "card");
}

// Control characters and unpaired surrogates are dropped: JSON writes each as
// six bytes, which is how a short text would become a long document.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f]|[\ud800-\udfff]/gu;

// Text somebody typed, or a refusal. Nothing is cut to fit: text that is too
// long is sent back, so what is stored is what was written.
function text(value, limit, what, optional) {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") refuse("invalid", what + " must be text");
  const s = value.replace(UNSAFE, "").trim();
  if (!s && !optional) refuse("invalid", what + " is required");
  if (s.length > limit) refuse("invalid", what + " is longer than " + limit + " characters");
  return s;
}

// An owner is a name somebody typed. A user id is not one, and published
// beside a linked note it would point at a person, so it is sent back.
function ownerName(value) {
  const name = text(value, LIMITS.owner, "an owner", true);
  if (USER_ID.test(name)) refuse("invalid", "an owner is a name, not a user id");
  return name;
}

function full(count, limit, message) {
  if (count >= limit) refuse("conflict", message);
}

// Version 0.1.0 stored the creator's user id as the owner of an action whose
// owner field was left blank. An id was never typed by anyone, and beside a
// linked note it hints at who wrote the note, so it is dropped.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A board stored by an earlier version has none of the newer fields.
function withDefaults(board) {
  if (!(board.stage >= 0 && board.stage < STAGES)) board.stage = 0;
  if (!board.timer) board.timer = null;
  if (!board.timerRev) board.timerRev = 0;
  if (!Array.isArray(board.stamps)) board.stamps = [];
  for (const item of board.actionItems) {
    if (!Array.isArray(item.sourceIds)) item.sourceIds = [];
    if (typeof item.owner !== "string" || USER_ID.test(item.owner)) item.owner = "";
  }
  dropEmptyGroups(board);
  return board;
}

// A group lasts as long as it holds a note. Without this, taking the notes
// out of a group and grouping them again left an empty group behind each time.
function dropEmptyGroups(board) {
  const held = new Set(board.cards.map((c) => c.groupId));
  if (board.groups.every((g) => held.has(g.id))) return;
  board.groups = board.groups.filter((g) => held.has(g.id));
  for (const c of board.cards) if (c.groupId && !board.groups.some((g) => g.id === c.groupId)) c.groupId = null;
}

function votesOf(row) {
  return Object.keys(row.votes).length;
}

// The ids an action item may point at: every note and every group.
function sourceIds(board) {
  const ids = new Set();
  for (const c of board.cards) ids.add(c.id);
  for (const g of board.groups) ids.add(g.id);
  return ids;
}

// Where a moved note or group goes: in front of a note, in front of a group
// (its first note), or, when the target is missing, to the end.
function indexBefore(board, beforeId) {
  let at = board.cards.findIndex((c) => c.id === beforeId);
  if (at === -1 && board.groups.some((g) => g.id === beforeId)) at = board.cards.findIndex((c) => c.groupId === beforeId);
  return at === -1 ? board.cards.length : at;
}

function fraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    refuse("invalid", "a stamp sits inside its note: x and y run from 0 to 1");
  }
  return Math.round(value * 1000) / 1000;
}

// The clock is the host's. Without one nothing about a timer can be said, and
// that is a fault, not something the caller asked for.
function clock(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("the timer needs a clock");
  return now;
}

function remaining(timer, now) {
  return timer.mode === "running" ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
}

// A note leaves with everything that hangs on it: its votes, its stamps and
// its links from action items. An action left with no source stays.
function removeCard(board, row) {
  board.cards.splice(board.cards.indexOf(row), 1);
  board.stamps = board.stamps.filter((s) => s.cardId !== row.id);
  dropEmptyGroups(board);
  const known = sourceIds(board);
  for (const item of board.actionItems) item.sourceIds = item.sourceIds.filter((id) => known.has(id));
}

// redactBoard is the only thing that decides what leaves the server. Authors
// leave only while revealed. Who voted and who pressed a stamp never do.
// `now` is the server's clock: the timer is published as time remaining, so no
// viewer has to trust its own clock against the server's.
function redactBoard(board, now) {
  withDefaults(board);
  const known = sourceIds(board);
  return {
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
        voteCount: votesOf(c),
      };
      if (board.revealed) row.authorId = c.authorId;
      return row;
    }),
    actionItems: board.actionItems.map((a) => ({
      id: a.id,
      text: a.text,
      owner: a.owner,
      done: a.done,
      sourceIds: a.sourceIds.filter((id) => known.has(id)),
    })),
  };
}

// The actions marked facilitator-only in manifest.json (reveal, conceal,
// set-stage, timer, order-by-votes, moderate-stamp, moderate-card) are refused
// by the host for anyone else before the guest is called: the guest is never
// told who the facilitator is. Everything else is checked here.
//
// A refusal is thrown before anything is written wherever that is cheap, but
// the rule that matters is the guest's: a refused board is never saved.
function applyAction(board, { action, user, body, now }) {
  body = body && typeof body === "object" ? body : {};
  withDefaults(board);
  switch (action) {
    case "add-card": {
      const columnId = column(board, body.columnId).id;
      const words = text(body.text, LIMITS.noteText, "a note");
      full(board.cards.length, LIMITS.notes, "the board is full of notes");
      full(board.cards.filter((c) => c.authorId === user).length, LIMITS.notesPerPerson, "that is every note one person may add");
      const row = { id: takeId(board, "c"), columnId, groupId: null, text: words, authorId: user, votes: {} };
      board.cards.push(row);
      return row;
    }
    // A note is deleted by whoever wrote it. The facilitator's way in is
    // moderate-card, which the host keeps for the facilitator.
    case "delete-card":
    case "moderate-card": {
      const row = card(board, body.cardId);
      if (action === "delete-card" && row.authorId !== user) refuse("forbidden", "only the person who wrote a note can delete it");
      removeCard(board, row);
      return row;
    }
    case "group-cards": {
      const wanted = Array.isArray(body.cardIds) ? body.cardIds : [];
      if (wanted.length > LIMITS.notesPerGrouping) refuse("invalid", "that is too many notes for one group");
      const byId = new Map(board.cards.map((c) => [c.id, c]));
      const rows = [...new Set(wanted)].map((id) => (typeof id === "string" && byId.get(id)) || refuse("not-found", "unknown card"));
      if (rows.length < 2) refuse("invalid", "grouping needs at least two cards");
      const columnId = rows[0].columnId;
      if (rows.some((r) => r.columnId !== columnId)) refuse("invalid", "cards must share a column");
      const title = text(body.title || "group", LIMITS.groupTitle, "a group's name");
      // A group these notes empty by leaving it makes room for the new one.
      const moving = new Set(rows);
      const kept = new Set(board.cards.filter((c) => c.groupId && !moving.has(c)).map((c) => c.groupId));
      full(kept.size, LIMITS.groups, "the board is full of groups");
      const made = { id: takeId(board, "g"), columnId, title };
      board.groups.push(made);
      for (const r of rows) r.groupId = made.id;
      dropEmptyGroups(board);
      return made;
    }
    case "vote": {
      const row = card(board, body.cardId);
      if (row.votes[user] !== 1) full(board.cards.reduce((n, c) => n + votesOf(c), 0), LIMITS.votes, "the board is full of votes");
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
      if (!Number.isInteger(body.stage) || body.stage < 0 || body.stage >= STAGES) refuse("invalid", "unknown stage");
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
        if (!Number.isInteger(ms) || ms < TIMER_MIN_MS || ms > TIMER_MAX_MS) refuse("invalid", "a timer runs from ten seconds to three hours");
        board.timer = { mode: "running", durationMs: ms, endsAt: now + ms, remainingMs: ms };
      } else if (body.op === "clear") {
        board.timer = null;
      } else if (body.op !== "pause" && body.op !== "resume" && body.op !== "add") {
        refuse("invalid", "unknown timer operation");
      } else if (!t) {
        refuse("conflict", "no timer is set");
      } else if (body.op === "pause") {
        t.remainingMs = remaining(t, now);
        t.mode = "paused";
      } else if (body.op === "resume") {
        if (t.mode === "paused") t.endsAt = now + t.remainingMs;
        t.mode = "running";
      } else {
        // One more minute, also for a timer that has already run out.
        t.remainingMs = Math.min(remaining(t, now) + MINUTE_MS, TIMER_MAX_MS);
        t.endsAt = now + t.remainingMs;
        t.durationMs = Math.max(t.durationMs, t.remainingMs);
      }
      board.timerRev += 1;
      return board.timer;
    }
    case "move-card": {
      const row = card(board, body.cardId);
      let columnId = row.columnId;
      let groupId = row.groupId;
      if (body.columnId !== undefined) {
        if (column(board, body.columnId).id !== columnId) groupId = null;
        columnId = body.columnId;
      }
      if (body.groupId === null) groupId = null;
      else if (body.groupId !== undefined) {
        const joined = find(board.groups, body.groupId, "group");
        // A group is in one lane. Asked to join it and to go to another lane,
        // the request contradicts itself, and neither half is guessed at.
        if (body.columnId !== undefined && body.columnId !== joined.columnId) refuse("invalid", "that group is in another lane");
        groupId = joined.id;
        columnId = joined.columnId;
      }
      board.cards.splice(board.cards.indexOf(row), 1);
      board.cards.splice(indexBefore(board, body.beforeId), 0, row);
      row.columnId = columnId;
      row.groupId = groupId;
      dropEmptyGroups(board);
      return row;
    }
    case "move-group": {
      const moved = find(board.groups, body.groupId, "group");
      const members = board.cards.filter((c) => c.groupId === moved.id);
      // A group changes lane whole: it and its notes, votes and stamps with them.
      if (body.columnId !== undefined) {
        moved.columnId = column(board, body.columnId).id;
        for (const m of members) m.columnId = moved.columnId;
      }
      board.cards = board.cards.filter((c) => c.groupId !== moved.id);
      board.cards.splice(indexBefore(board, body.beforeId), 0, ...members);
      return moved;
    }
    case "order-by-votes": {
      const columnId = column(board, body.columnId).id;
      // The lane's notes are re-dealt into the places the lane already holds,
      // so no other lane's order is touched. A group is ranked by the votes
      // of its notes together and keeps them side by side.
      const places = [];
      const items = [];
      const byGroup = new Map();
      board.cards.forEach((c, i) => {
        if (c.columnId !== columnId) return;
        places.push(i);
        let item = c.groupId && byGroup.get(c.groupId);
        if (!item) {
          item = { votes: 0, cards: [] };
          items.push(item);
          if (c.groupId) byGroup.set(c.groupId, item);
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
      if (typeof body.kind !== "string" || !KNOWN_KINDS.has(body.kind)) refuse("invalid", "unknown stamp");
      const x = fraction(body.x);
      const y = fraction(body.y);
      const tilt = typeof body.rot === "number" && Number.isFinite(body.rot) ? body.rot : 0;
      const onNote = board.stamps.filter((s) => s.cardId === row.id);
      full(board.stamps.length, LIMITS.stamps, "the board is full of stamps");
      full(onNote.length, LIMITS.stampsPerNote, "this note is full of stamps");
      full(onNote.filter((s) => s.by === user).length, LIMITS.stampsPerPersonPerNote, "that is every stamp one person may press on one note");
      full(board.stamps.filter((s) => s.by === user).length, LIMITS.stampsPerPerson, "that is every stamp one person may press on one board");
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
      const row = find(board.stamps, body.stampId, "stamp");
      if (action !== "moderate-stamp" && row.by !== user) refuse("forbidden", "only the person who pressed a stamp can change it");
      if (action === "remove-stamp" || (action === "moderate-stamp" && body.remove === true)) {
        board.stamps.splice(board.stamps.indexOf(row), 1);
        return row;
      }
      const x = fraction(body.x);
      row.y = fraction(body.y);
      row.x = x;
      // The order of the stamps is the pile, bottom to top: what is picked up
      // goes back down on top. Moving one to where it already is brings it
      // to the front.
      board.stamps.splice(board.stamps.indexOf(row), 1);
      board.stamps.push(row);
      return row;
    }
    case "add-action": {
      const words = text(body.text, LIMITS.actionText, "an action");
      // Nobody owns an action until somebody is named: a blank owner is not
      // the person who wrote it down.
      const owner = ownerName(body.owner);
      full(board.actionItems.length, LIMITS.actions, "the board is full of action items");
      const known = sourceIds(board);
      const wanted = Array.isArray(body.sourceIds) ? body.sourceIds.slice(0, LIMITS.sourcesPerAction) : [];
      const item = {
        id: takeId(board, "a"),
        text: words,
        owner,
        done: false,
        // Ids the board does not hold are dropped: a note may have moved on.
        sourceIds: [...new Set(wanted)].filter((id) => typeof id === "string" && known.has(id)),
      };
      board.actionItems.push(item);
      return item;
    }
    case "set-owner": {
      const item = find(board.actionItems, body.actionId, "action item");
      item.owner = ownerName(body.owner);
      return item;
    }
    case "delete-action": {
      const item = find(board.actionItems, body.actionId, "action item");
      board.actionItems.splice(board.actionItems.indexOf(item), 1);
      return item;
    }
    case "link-action": {
      const item = find(board.actionItems, body.actionId, "action item");
      if (typeof body.sourceId !== "string" || !sourceIds(board).has(body.sourceId)) refuse("not-found", "unknown note or group");
      if (typeof body.linked !== "boolean") refuse("invalid", "linked is true or false");
      const at = item.sourceIds.indexOf(body.sourceId);
      if (body.linked && at === -1) {
        full(item.sourceIds.length, LIMITS.sourcesPerAction, "this action is linked to as many notes as it can hold");
        item.sourceIds.push(body.sourceId);
      }
      if (!body.linked && at !== -1) item.sourceIds.splice(at, 1);
      return item;
    }
    default:
      refuse("invalid", "unknown action");
  }
}

// What the guest answers the host with: {} when the action was applied and
// the board is to be saved, { refused: code } when it was declined and the
// board is to be left as stored. A fault is thrown on.
function answerAction(board, input) {
  try {
    applyAction(board, input);
    return {};
  } catch (err) {
    if (err instanceof Refusal) return { refused: err.refused };
    throw err;
  }
}

module.exports = { emptyBoard, redactBoard, applyAction, answerAction, STAMP_KINDS, LIMITS };
