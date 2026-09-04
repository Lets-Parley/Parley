"use strict";

function emptyBoard() {
  return {
    revealed: false,
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

function redactBoard(board) {
  const out = {
    revealed: board.revealed,
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
    })),
  };
  return out;
}

function applyAction(board, { action, user, body }) {
  body = body && typeof body === "object" ? body : {};
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
    case "add-action": {
      const item = {
        id: takeId(board, "a"),
        text: clip(body.text, 500),
        owner: String(body.owner || user).slice(0, 64),
        done: false,
      };
      board.actionItems.push(item);
      return item;
    }
    default:
      throw new Error("unknown action");
  }
}

module.exports = { emptyBoard, redactBoard, applyAction };
