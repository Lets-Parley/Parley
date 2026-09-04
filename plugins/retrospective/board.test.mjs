import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { emptyBoard, redactBoard, applyAction } = require("./board.js");

test("an empty board has three columns and no cards", () => {
  const board = emptyBoard();
  assert.deepEqual(
    board.columns.map((c) => c.id),
    ["went-well", "to-improve", "puzzles"],
  );
  assert.equal(board.revealed, false);
  assert.equal(board.cards.length, 0);
  assert.equal(board.groups.length, 0);
  assert.equal(board.actionItems.length, 0);
});

test("redactBoard hides authorship until reveal", () => {
  const board = emptyBoard();
  applyAction(board, {
    action: "add-card",
    user: "alice",
    body: { columnId: "went-well", text: "shipped the export" },
  });
  const hidden = redactBoard(board);
  assert.equal(hidden.cards[0].text, "shipped the export");
  assert.equal("authorId" in hidden.cards[0], false);

  board.revealed = true;
  const shown = redactBoard(board);
  assert.equal(shown.cards[0].authorId, "alice");
});

test("grouping and dot voting live on the same document", () => {
  const board = emptyBoard();
  const a = applyAction(board, {
    action: "add-card",
    user: "alice",
    body: { columnId: "to-improve", text: "standup ran long" },
  });
  const b = applyAction(board, {
    action: "add-card",
    user: "bob",
    body: { columnId: "to-improve", text: "too many topics" },
  });
  applyAction(board, {
    action: "group-cards",
    user: "alice",
    body: { cardIds: [a.id, b.id], title: "timeboxing" },
  });
  applyAction(board, {
    action: "vote",
    user: "carol",
    body: { cardId: a.id },
  });
  assert.equal(board.groups.length, 1);
  assert.equal(board.groups[0].title, "timeboxing");
  assert.equal(board.cards[0].groupId, board.groups[0].id);
  assert.equal(board.cards[1].groupId, board.groups[0].id);
  assert.equal(board.cards[0].votes.carol, 1);
  assert.equal(Object.keys(board.cards).length, 2);
});

test("a second vote from the same person is last-write-wins on that card, not a second dot", () => {
  const board = emptyBoard();
  const card = applyAction(board, {
    action: "add-card",
    user: "alice",
    body: { columnId: "went-well", text: "dots" },
  });
  applyAction(board, { action: "vote", user: "bob", body: { cardId: card.id } });
  applyAction(board, { action: "vote", user: "bob", body: { cardId: card.id } });
  assert.equal(board.cards[0].votes.bob, 1);
});

test("action items are rows on the same board document", () => {
  const board = emptyBoard();
  applyAction(board, {
    action: "add-action",
    user: "alice",
    body: { text: "cap the agenda", owner: "bob" },
  });
  assert.equal(board.actionItems[0].text, "cap the agenda");
  assert.equal(board.actionItems[0].owner, "bob");
  assert.equal(board.actionItems[0].done, false);
});

test("unknown actions throw", () => {
  assert.throws(() => applyAction(emptyBoard(), { action: "explode", user: "x", body: {} }));
});
