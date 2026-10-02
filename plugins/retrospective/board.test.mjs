import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
// RETRO_BOARD_SRC points the suite at another copy of the source, for checking
// that a test can fail. The tracked file is never edited for that.
const { emptyBoard, redactBoard, applyAction, answerAction, LIMITS } = require(process.env.RETRO_BOARD_SRC || "./board.js");

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
  const card = applyAction(board, {
    action: "add-card",
    user: "alice",
    body: { columnId: "went-well", text: "shipped the export" },
  });
  applyAction(board, { action: "vote", user: "carol", body: { cardId: card.id } });
  const hidden = redactBoard(board);
  const hiddenJSON = JSON.stringify(hidden);
  assert.equal(hidden.cards[0].text, "shipped the export");
  assert.equal("authorId" in hidden.cards[0], false);
  assert.equal("votes" in hidden.cards[0], false);
  assert.equal(hidden.cards[0].voteCount, 1);
  assert.equal(hiddenJSON.includes("alice"), false);
  assert.equal(hiddenJSON.includes("carol"), false);
  assert.equal(hiddenJSON.includes("votes"), false);

  board.revealed = true;
  const shown = redactBoard(board);
  assert.equal(shown.cards[0].authorId, "alice");
  assert.equal("votes" in shown.cards[0], false);
  assert.equal(shown.cards[0].voteCount, 1);
  assert.equal(JSON.stringify(shown).includes("carol"), false);
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

// ---- stages, order, links, stamps, timer

const act = (board, action, user, body, now) => applyAction(board, { action, user, body, now });
const note = (board, user, columnId, text) => act(board, "add-card", user, { columnId, text });
const order = (board) => board.cards.map((c) => c.text).join(" ");

function threeNotes() {
  const board = emptyBoard();
  const a = note(board, "alice", "went-well", "a");
  const b = note(board, "bob", "went-well", "b");
  const c = note(board, "carol", "went-well", "c");
  return { board, a, b, c };
}

test("a board stored before stages, stamps and links existed still loads and still acts", () => {
  const old = emptyBoard();
  delete old.stage;
  delete old.timer;
  delete old.timerRev;
  delete old.stamps;
  old.actionItems.push({ id: "a9", text: "old", owner: "bob", done: false });
  const out = redactBoard(old);
  assert.equal(out.stage, 0);
  assert.equal(out.timer, null);
  assert.deepEqual(out.stamps, []);
  assert.deepEqual(out.actionItems[0].sourceIds, []);
  note(old, "alice", "went-well", "still works");
  assert.equal(old.cards.length, 1);
});

test("the stage is one of four, and a late note or vote is accepted in any of them", () => {
  const board = emptyBoard();
  act(board, "set-stage", "fac", { stage: 3 });
  assert.equal(redactBoard(board).stage, 3);
  const late = note(board, "alice", "puzzles", "late thought");
  act(board, "vote", "bob", { cardId: late.id });
  assert.equal(redactBoard(board).cards[0].voteCount, 1);
  act(board, "set-stage", "fac", { stage: 0 });
  assert.equal(board.stage, 0);
  for (const stage of [4, -1, 1.5, "2", null, undefined, NaN, Infinity, {}]) {
    assert.throws(() => act(board, "set-stage", "fac", { stage }), /unknown stage/, String(stage));
  }
  assert.equal(board.stage, 0);
});

test("authors can be hidden again, and the payload stops carrying them", () => {
  const board = emptyBoard();
  note(board, "alice", "went-well", "mine");
  act(board, "reveal", "fac", {});
  assert.equal(redactBoard(board).cards[0].authorId, "alice");
  act(board, "conceal", "fac", {});
  assert.equal(JSON.stringify(redactBoard(board)).includes("alice"), false);
});

test("a note moves in front of another note, to the end, or to another lane", () => {
  const { board, a, b, c } = threeNotes();
  act(board, "move-card", "bob", { cardId: c.id, beforeId: a.id });
  assert.equal(order(board), "c a b");
  act(board, "move-card", "bob", { cardId: c.id });
  assert.equal(order(board), "a b c");
  act(board, "move-card", "bob", { cardId: a.id, beforeId: "c999" });
  assert.equal(order(board), "b c a", "a target that is gone means the end");
  act(board, "move-card", "bob", { cardId: b.id, beforeId: b.id });
  assert.equal(order(board), "c a b", "in front of itself means the end");
  act(board, "move-card", "bob", { cardId: a.id, columnId: "puzzles" });
  assert.equal(a.columnId, "puzzles");
  assert.equal(order(board), "c b a", "with no target it goes to the end");

  for (const body of [{}, { cardId: "nope" }, { cardId: { id: a.id } }, { cardId: a.id, columnId: "nope" }, { cardId: a.id, groupId: "g404" }, { cardId: a.id, columnId: 7 }]) {
    assert.throws(() => act(board, "move-card", "bob", body), /unknown/, JSON.stringify(body));
  }
  assert.equal(order(board), "c b a", "a refused move changes nothing");
  assert.equal(a.columnId, "puzzles");
});

test("a moved note joins a group, leaves one, and loses its group when it changes lane", () => {
  const { board, a, b, c } = threeNotes();
  const g = act(board, "group-cards", "alice", { cardIds: [a.id, b.id], title: "pair" });
  act(board, "move-card", "bob", { cardId: c.id, groupId: g.id, beforeId: b.id });
  assert.equal(c.groupId, g.id);
  assert.equal(order(board), "a c b");
  act(board, "move-card", "bob", { cardId: a.id, beforeId: b.id });
  assert.equal(a.groupId, g.id, "a move inside the lane keeps the group");
  act(board, "move-card", "bob", { cardId: a.id, groupId: null });
  assert.equal(a.groupId, null);
  act(board, "move-card", "bob", { cardId: b.id, columnId: "puzzles" });
  assert.equal(b.groupId, null);
  assert.equal(b.columnId, "puzzles");
  act(board, "move-card", "bob", { cardId: b.id, groupId: g.id });
  assert.equal(b.columnId, "went-well", "the group's lane wins");
});

test("a group moves as one, in front of a note or of another group", () => {
  const board = emptyBoard();
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((t) => note(board, "alice", "to-improve", t));
  const g1 = act(board, "group-cards", "alice", { cardIds: [b.id, d.id], title: "one" });
  const g2 = act(board, "group-cards", "alice", { cardIds: [c.id, e.id], title: "two" });
  act(board, "move-group", "bob", { groupId: g1.id, beforeId: a.id });
  assert.equal(order(board), "b d a c e");
  act(board, "move-group", "bob", { groupId: g2.id, beforeId: g1.id });
  assert.equal(order(board), "c e b d a");
  act(board, "move-group", "bob", { groupId: g2.id, beforeId: e.id });
  assert.equal(order(board), "b d a c e", "in front of its own note means the end");
  assert.throws(() => act(board, "move-group", "bob", { groupId: "g404" }), /unknown group/);
  assert.throws(() => act(board, "move-group", "bob", { groupId: a.id }), /unknown group/);
});

test("ordering a lane by votes ranks groups by their total and leaves other lanes alone", () => {
  const board = emptyBoard();
  const a = note(board, "u", "went-well", "a");
  const x = note(board, "u", "puzzles", "x");
  const b = note(board, "u", "went-well", "b");
  const c = note(board, "u", "went-well", "c");
  const y = note(board, "u", "puzzles", "y");
  const d = note(board, "u", "went-well", "d");
  act(board, "group-cards", "u", { cardIds: [a.id, d.id], title: "g" });
  const vote = (row, n) => ["p1", "p2", "p3"].slice(0, n).forEach((who) => act(board, "vote", who, { cardId: row.id }));
  vote(a, 1);
  vote(d, 2);
  vote(c, 2);
  vote(y, 3);
  act(board, "order-by-votes", "fac", { columnId: "went-well" });
  // group (1 + 2 = 3 votes) with d before a, then c (2), then b (0); x and y keep their places.
  assert.equal(order(board), "d x a c y b");
  for (const columnId of ["nope", undefined, null, 3]) {
    assert.throws(() => act(board, "order-by-votes", "fac", { columnId }), /unknown column/);
  }
});

test("an action item remembers the notes and groups it came from, and only real ones", () => {
  const { board, a, b } = threeNotes();
  const g = act(board, "group-cards", "alice", { cardIds: [a.id, b.id], title: "pair" });
  const item = act(board, "add-action", "alice", { text: "fix it", sourceIds: [a.id, "c404", a.id, g.id, 7, null, { id: b.id }] });
  assert.deepEqual(item.sourceIds, [a.id, g.id]);
  assert.deepEqual(redactBoard(board).actionItems[0].sourceIds, [a.id, g.id]);
  assert.deepEqual(act(board, "add-action", "alice", { text: "plain", sourceIds: "c1" }).sourceIds, []);
  assert.equal(act(board, "add-action", "alice", { text: "many", sourceIds: Array(5000).fill(b.id) }).sourceIds.length, 1);

  act(board, "link-action", "bob", { actionId: item.id, sourceId: b.id, linked: true });
  act(board, "link-action", "bob", { actionId: item.id, sourceId: b.id, linked: true });
  assert.deepEqual(item.sourceIds, [a.id, g.id, b.id], "linking twice is linking once");
  act(board, "link-action", "bob", { actionId: item.id, sourceId: a.id, linked: false });
  act(board, "link-action", "bob", { actionId: item.id, sourceId: a.id, linked: false });
  assert.deepEqual(item.sourceIds, [g.id, b.id]);

  assert.throws(() => act(board, "link-action", "bob", { actionId: "a404", sourceId: a.id, linked: true }), /unknown action item/);
  assert.throws(() => act(board, "link-action", "bob", { actionId: item.id, sourceId: "c404", linked: true }), /unknown note or group/);
  assert.throws(() => act(board, "link-action", "bob", { actionId: item.id, sourceId: a.id, linked: "yes" }), /true or false/);
  assert.throws(() => act(board, "link-action", "bob", { actionId: item.id, sourceId: a.id }), /true or false/);
});

test("an action holds at most twelve links", () => {
  const board = emptyBoard();
  const rows = Array.from({ length: 13 }, (_, i) => note(board, "u", "went-well", "n" + i));
  const item = act(board, "add-action", "u", { text: "all of it", sourceIds: rows.map((r) => r.id) });
  assert.equal(item.sourceIds.length, 12);
  assert.throws(() => act(board, "link-action", "u", { actionId: item.id, sourceId: rows[12].id, linked: true }), /as many notes as it can hold/);
});

test("a stamp is pressed at a point on a note, and who pressed it never leaves the server", () => {
  const { board, a } = threeNotes();
  const s = act(board, "stamp", "carol-the-stamper", { cardId: a.id, kind: "quick-win", x: 0.91234, y: 1, rot: -7.26 });
  assert.equal(s.by, "carol-the-stamper");
  const out = redactBoard(board);
  assert.deepEqual(out.stamps, [{ id: s.id, cardId: a.id, kind: "quick-win", x: 0.912, y: 1, rot: -7.3 }]);
  assert.equal(JSON.stringify(out).includes("carol-the-stamper"), false);
  board.revealed = true;
  assert.equal(JSON.stringify(redactBoard(board)).includes("carol-the-stamper"), false, "a reveal is of authors, not of stamps");
  assert.equal(board.cards[0].text, "a", "a stamp changes nothing else about the note");
});

test("a stamp that is not a known kind, on a known note, at a real point, is refused", () => {
  const { board, a } = threeNotes();
  const ok = { cardId: a.id, kind: "idea", x: 0.5, y: 0.5 };
  const hostile = [
    { ...ok, cardId: "c404" },
    { ...ok, cardId: null },
    { ...ok, kind: "thumbs-up" },
    { ...ok, kind: ["idea"] },
    { ...ok, kind: "x".repeat(200000) },
    { ...ok, x: NaN },
    { ...ok, y: Infinity },
    { ...ok, x: -0.01 },
    { ...ok, y: 1.01 },
    { ...ok, x: "0.5" },
    { ...ok, y: null },
    { ...ok, x: undefined },
    { ...ok, x: [0.5] },
    { ...ok, y: -Infinity },
    { ...ok, x: 1e308 },
  ];
  for (const body of hostile) assert.throws(() => act(board, "stamp", "bob", body), /unknown|0 to 1/, JSON.stringify(body).slice(0, 80));
  assert.throws(() => act(board, "stamp", "bob", null), /unknown card/);
  assert.equal(board.stamps.length, 0);

  // The tilt is decoration: anything that is not a number is no tilt, and a big one is held to twelve degrees.
  assert.equal(act(board, "stamp", "bob", { ...ok, rot: 9000 }).rot, 12);
  assert.equal(act(board, "stamp", "bob", { ...ok, rot: -Infinity }).rot, 0);
  assert.equal(act(board, "stamp", "bob", { ...ok, rot: "left" }).rot, 0);
});

test("stamps are capped per person per note, per note, and per board", () => {
  const { board, a, b } = threeNotes();
  const press = (who, row) => act(board, "stamp", who, { cardId: row.id, kind: "thanks", x: 0.5, y: 0.5 });
  press("bob", a);
  press("bob", a);
  press("bob", a);
  assert.throws(() => press("bob", a), /one person may press on one note/);
  press("bob", b);
  for (const who of ["p1", "p2", "p3"]) for (let i = 0; i < 3; i++) press(who, a);
  assert.equal(board.stamps.filter((s) => s.cardId === a.id).length, 12);
  assert.throws(() => press("p4", a), /this note is full/);

  // Sixty from one person on one board, however they are spread.
  const one = emptyBoard();
  const twenty = Array.from({ length: 21 }, (_, i) => note(one, "author" + (i % 2), "went-well", "n" + i));
  for (let i = 0; i < 60; i++) act(one, "stamp", "bob", { cardId: twenty[Math.floor(i / 3)].id, kind: "laugh", x: 0, y: 0 });
  assert.throws(() => act(one, "stamp", "bob", { cardId: twenty[20].id, kind: "laugh", x: 0, y: 0 }), /one person may press on one board/);
  act(one, "stamp", "carol", { cardId: twenty[20].id, kind: "laugh", x: 0, y: 0 });

  const full = emptyBoard();
  const rows = Array.from({ length: 101 }, (_, i) => note(full, "author" + (i % 5), "went-well", "n" + i));
  for (let i = 0; i < 300; i++) act(full, "stamp", "p" + (i % 3) + "/" + Math.floor(i / 150), { cardId: rows[Math.floor(i / 3)].id, kind: "laugh", x: 0, y: 0 });
  assert.throws(() => act(full, "stamp", "p9", { cardId: rows[100].id, kind: "laugh", x: 0, y: 0 }), /board is full/);
});

test("only whoever pressed a stamp moves or lifts it; the facilitator's way in is its own action", () => {
  const { board, a } = threeNotes();
  const s = act(board, "stamp", "bob", { cardId: a.id, kind: "chat", x: 0.2, y: 0.2 });
  assert.throws(() => act(board, "move-stamp", "carol", { stampId: s.id, x: 0.9, y: 0.9 }), /only the person who pressed/);
  assert.throws(() => act(board, "remove-stamp", "carol", { stampId: s.id }), /only the person who pressed/);
  assert.equal(board.stamps.length, 1);
  assert.equal(s.x, 0.2);

  act(board, "move-stamp", "bob", { stampId: s.id, x: 0.75, y: 1 });
  assert.deepEqual([s.x, s.y], [0.75, 1]);
  for (const body of [{ stampId: s.id, x: NaN, y: 0.5 }, { stampId: s.id, x: 0.5, y: -1 }, { stampId: s.id, x: 0.1 }, { stampId: s.id }]) {
    assert.throws(() => act(board, "move-stamp", "bob", body), /0 to 1/, JSON.stringify(body));
  }
  assert.deepEqual([s.x, s.y], [0.75, 1], "a refused move leaves the stamp where it was");
  for (const stampId of ["s404", a.id, undefined, 5]) {
    assert.throws(() => act(board, "move-stamp", "bob", { stampId, x: 0, y: 0 }), /unknown stamp/);
    assert.throws(() => act(board, "remove-stamp", "bob", { stampId }), /unknown stamp/);
    assert.throws(() => act(board, "moderate-stamp", "fac", { stampId, remove: true }), /unknown stamp/);
  }

  // The host lets only the facilitator call moderate-stamp, so it does not ask who pressed it.
  act(board, "moderate-stamp", "fac", { stampId: s.id, x: 0.1, y: 0.3 });
  assert.deepEqual([s.x, s.y, s.by], [0.1, 0.3, "bob"]);
  assert.throws(() => act(board, "moderate-stamp", "fac", { stampId: s.id, remove: "true" }), /0 to 1/, "anything but true is a move");
  act(board, "moderate-stamp", "fac", { stampId: s.id, remove: true });
  assert.equal(board.stamps.length, 0);

  const mine = act(board, "stamp", "bob", { cardId: a.id, kind: "chat", x: 0.2, y: 0.2 });
  act(board, "remove-stamp", "bob", { stampId: mine.id });
  assert.equal(board.stamps.length, 0);
});

const T0 = 1_700_000_000_000;

test("the timer is published as time remaining, counted on the server's clock", () => {
  const board = emptyBoard();
  act(board, "timer", "fac", { op: "start", durationMs: 300_000 }, T0);
  assert.deepEqual(redactBoard(board, T0 + 20_000).timer, { rev: 1, mode: "running", durationMs: 300_000, remainingMs: 280_000 });
  assert.equal(redactBoard(board, T0 + 999_000).timer.remainingMs, 0, "it runs out; it does not run negative");

  act(board, "timer", "fac", { op: "pause" }, T0 + 60_000);
  assert.deepEqual(redactBoard(board, T0 + 500_000).timer, { rev: 2, mode: "paused", durationMs: 300_000, remainingMs: 240_000 });
  act(board, "timer", "fac", { op: "pause" }, T0 + 70_000);
  assert.equal(redactBoard(board, T0 + 70_000).timer.remainingMs, 240_000, "pausing twice loses no time");

  act(board, "timer", "fac", { op: "resume" }, T0 + 100_000);
  assert.equal(redactBoard(board, T0 + 110_000).timer.remainingMs, 230_000);
  act(board, "timer", "fac", { op: "resume" }, T0 + 105_000);
  assert.equal(redactBoard(board, T0 + 110_000).timer.remainingMs, 230_000, "resuming twice gains no time");

  act(board, "timer", "fac", { op: "add" }, T0 + 110_000);
  assert.equal(redactBoard(board, T0 + 110_000).timer.remainingMs, 290_000);

  act(board, "timer", "fac", { op: "clear" }, T0 + 120_000);
  assert.equal(redactBoard(board, T0 + 120_000).timer, null);
  act(board, "timer", "fac", { op: "clear" }, T0 + 120_000);
  assert.equal(board.timerRev, 8, "every operation, even one that changes nothing, is a new revision");
});

test("one more minute re-arms a timer that ran out, and never passes three hours", () => {
  const board = emptyBoard();
  act(board, "timer", "fac", { op: "start", durationMs: 10_000 }, T0);
  act(board, "timer", "fac", { op: "add" }, T0 + 50_000);
  assert.deepEqual(redactBoard(board, T0 + 50_000).timer, { rev: 2, mode: "running", durationMs: 60_000, remainingMs: 60_000 });

  act(board, "timer", "fac", { op: "start", durationMs: 10_800_000 }, T0);
  act(board, "timer", "fac", { op: "add" }, T0 + 1000);
  assert.equal(redactBoard(board, T0 + 1000).timer.remainingMs, 10_800_000);
});

test("a timer the board cannot make sense of is refused and leaves the running one alone", () => {
  const board = emptyBoard();
  for (const op of ["pause", "resume", "add"]) assert.throws(() => act(board, "timer", "fac", { op }, T0), /no timer is set/);
  act(board, "timer", "fac", { op: "start", durationMs: 60_000 }, T0);
  for (const durationMs of [9_999, 10_800_001, 0, -5, 60_000.5, "60000", NaN, Infinity, null, undefined]) {
    assert.throws(() => act(board, "timer", "fac", { op: "start", durationMs }, T0), /ten seconds to three hours/, String(durationMs));
  }
  for (const op of ["explode", undefined, 3, ["start"]]) assert.throws(() => act(board, "timer", "fac", { op }, T0), /unknown timer operation/);
  for (const now of [undefined, NaN, "now", Infinity]) {
    assert.throws(() => act(board, "timer", "fac", { op: "pause" }, now), /needs a clock/);
    assert.throws(() => redactBoard(board, now), /needs a clock/);
  }
  assert.deepEqual(redactBoard(board, T0).timer, { rev: 1, mode: "running", durationMs: 60_000, remainingMs: 60_000 });
});

test("changing the stage clears the timer", () => {
  const board = emptyBoard();
  act(board, "timer", "fac", { op: "start", durationMs: 60_000 }, T0);
  act(board, "set-stage", "fac", { stage: 1 });
  assert.equal(redactBoard(board, T0).timer, null);
});

// ---- refusals, caps, deletion, owners

// The code the guest hands the host for a request, or "" when it was applied.
const code = (board, action, user, body, now = T0) => answerAction(board, { action, user, body, now }).refused || "";

test("every request the board declines is answered with a code, and nothing is thrown", () => {
  const { board, a, b } = threeNotes();
  const s = act(board, "stamp", "bob", { cardId: a.id, kind: "idea", x: 0.5, y: 0.5 });
  const item = act(board, "add-action", "bob", { text: "do it" });
  const g = act(board, "group-cards", "bob", { cardIds: [a.id, b.id], title: "pair" });
  const before = JSON.stringify(board);
  const declined = [
    ["add-card", { columnId: "nope", text: "x" }, "not-found"],
    ["add-card", { columnId: "went-well", text: "" }, "invalid"],
    ["add-card", { columnId: "went-well", text: "   " }, "invalid"],
    ["add-card", { columnId: "went-well", text: "x".repeat(501) }, "invalid"],
    ["add-card", { columnId: "went-well", text: 7 }, "invalid"],
    ["add-card", { columnId: "went-well", text: ["x"] }, "invalid"],
    ["add-card", { columnId: "went-well" }, "invalid"],
    ["delete-card", { cardId: "c404" }, "not-found"],
    ["delete-card", { cardId: a.id }, "forbidden"],
    ["moderate-card", { cardId: null }, "not-found"],
    ["group-cards", { cardIds: [a.id] }, "invalid"],
    ["group-cards", { cardIds: [a.id, a.id] }, "invalid"],
    ["group-cards", { cardIds: "c1c2" }, "invalid"],
    ["group-cards", { cardIds: [a.id, "c404"] }, "not-found"],
    ["group-cards", { cardIds: [a.id, { id: b.id }] }, "not-found"],
    ["group-cards", { cardIds: [a.id, b.id], title: "t".repeat(81) }, "invalid"],
    ["group-cards", { cardIds: [a.id, b.id], title: { toString: () => "x" } }, "invalid"],
    ["group-cards", { cardIds: Array(51).fill(a.id) }, "invalid"],
    ["vote", { cardId: "c404" }, "not-found"],
    ["set-stage", { stage: 9 }, "invalid"],
    ["timer", { op: "explode" }, "invalid"],
    ["timer", { op: "start", durationMs: 5 }, "invalid"],
    ["timer", { op: "pause" }, "conflict"],
    ["move-card", { cardId: "c404" }, "not-found"],
    ["move-card", { cardId: a.id, columnId: "nope" }, "not-found"],
    ["move-card", { cardId: a.id, groupId: "g404" }, "not-found"],
    ["move-group", { groupId: "g404" }, "not-found"],
    ["order-by-votes", { columnId: 3 }, "not-found"],
    ["stamp", { cardId: "c404", kind: "idea", x: 0, y: 0 }, "not-found"],
    ["stamp", { cardId: a.id, kind: "thumbs-up", x: 0, y: 0 }, "invalid"],
    ["stamp", { cardId: a.id, kind: "idea", x: NaN, y: 0 }, "invalid"],
    ["stamp", { cardId: a.id, kind: "idea", x: 0, y: 1.5 }, "invalid"],
    ["move-stamp", { stampId: "s404", x: 0, y: 0 }, "not-found"],
    ["move-stamp", { stampId: s.id, x: 0, y: 0 }, "forbidden"],
    ["remove-stamp", { stampId: s.id }, "forbidden"],
    ["moderate-stamp", { stampId: s.id, x: "left", y: 0 }, "invalid"],
    ["add-action", { text: "" }, "invalid"],
    ["add-action", { text: "x", owner: 7 }, "invalid"],
    ["add-action", { text: "x", owner: "o".repeat(65) }, "invalid"],
    ["add-action", { text: "x".repeat(501) }, "invalid"],
    ["set-owner", { actionId: "a404", owner: "bob" }, "not-found"],
    ["set-owner", { actionId: item.id, owner: ["bob"] }, "invalid"],
    ["delete-action", { actionId: g.id }, "not-found"],
    ["link-action", { actionId: "a404", sourceId: a.id, linked: true }, "not-found"],
    ["link-action", { actionId: item.id, sourceId: "c404", linked: true }, "not-found"],
    ["link-action", { actionId: item.id, sourceId: a.id, linked: "yes" }, "invalid"],
    ["explode", {}, "invalid"],
    [undefined, {}, "invalid"],
  ];
  for (const [action, body, want] of declined) {
    assert.equal(code(board, action, "carol", body), want, action + " " + JSON.stringify(body).slice(0, 60));
  }
  assert.equal(JSON.stringify(board), before, "a declined request leaves the board as it was");
  assert.equal(code(board, "vote", "carol", { cardId: a.id }), "", "an accepted one answers with no code");
});

test("a name the language already uses is not a note, a stamp or a lane", () => {
  const { board, a, b } = threeNotes();
  const item = act(board, "add-action", "bob", { text: "do it" });
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "length"]) {
    assert.equal(code(board, "vote", "bob", { cardId: id }), "not-found", id);
    assert.equal(code(board, "add-card", "bob", { columnId: id, text: "x" }), "not-found", id);
    assert.equal(code(board, "stamp", "bob", { cardId: a.id, kind: id, x: 0, y: 0 }), "invalid", id);
    assert.equal(code(board, "group-cards", "bob", { cardIds: [a.id, id] }), "not-found", id);
    assert.equal(code(board, "move-group", "bob", { groupId: id }), "not-found", id);
    assert.equal(code(board, "link-action", "bob", { actionId: item.id, sourceId: id, linked: true }), "not-found", id);
    assert.equal(code(board, "timer", "fac", { op: id }), "invalid", id);
    assert.deepEqual(act(board, "add-action", "bob", { text: "x", sourceIds: [id, b.id] }).sourceIds, [b.id], id);
  }
  // A voter the host names that way is still one voter, counted once.
  act(board, "vote", "toString", { cardId: a.id });
  act(board, "vote", "constructor", { cardId: a.id });
  act(board, "vote", "constructor", { cardId: a.id });
  assert.equal(redactBoard(board, T0).cards[0].voteCount, 2);
  assert.equal({}.polluted, undefined);
});

test("a fault is thrown, not answered: the host has to hear that something is broken", () => {
  const board = emptyBoard();
  act(board, "timer", "fac", { op: "start", durationMs: 60_000 }, T0);
  assert.throws(() => answerAction(board, { action: "timer", user: "fac", body: { op: "pause" }, now: undefined }), /needs a clock/);
  assert.throws(() => answerAction({ columns: [] }, { action: "vote", user: "u", body: {}, now: T0 }), TypeError, "a stored document with no notes in it is corrupt");
});

test("text is stored as written or sent back; control characters never reach the document", () => {
  const board = emptyBoard();
  const row = note(board, "alice", "went-well", "  two\nlines\u0000\u0007 \ud83d\ude00 \ud800 ");
  assert.equal(row.text, "two\nlines \ud83d\ude00");
  assert.equal(code(board, "add-card", "alice", { columnId: "went-well", text: "\u0000\u0001" }), "invalid", "nothing but control characters is nothing");
  assert.equal(note(board, "alice", "went-well", "x".repeat(500)).text.length, 500);
});

test("the author deletes their own note; the facilitator's way in is its own action", () => {
  const { board, a, b, c } = threeNotes();
  assert.equal(code(board, "delete-card", "bob", { cardId: a.id }), "forbidden", "a is alice's");
  assert.equal(code(board, "delete-card", undefined, { cardId: a.id }), "forbidden");
  act(board, "delete-card", "alice", { cardId: a.id });
  assert.equal(order(board), "b c");
  // The host lets only the facilitator call moderate-card, so it does not ask who wrote the note.
  act(board, "moderate-card", "fac", { cardId: b.id });
  assert.equal(order(board), "c");
  assert.equal(code(board, "moderate-card", "fac", { cardId: b.id }), "not-found", "deleting twice is not deleting once");
  assert.equal(c.authorId, "carol");
});

test("a deleted note takes its votes, its stamps and its links with it, and says nothing about who wrote it", () => {
  const { board, a, b, c } = threeNotes();
  const g = act(board, "group-cards", "bob", { cardIds: [a.id, b.id], title: "pair" });
  act(board, "vote", "bob", { cardId: a.id });
  act(board, "stamp", "bob", { cardId: a.id, kind: "idea", x: 0.5, y: 0.5 });
  const kept = act(board, "stamp", "bob", { cardId: c.id, kind: "idea", x: 0.5, y: 0.5 });
  const both = act(board, "add-action", "bob", { text: "both", sourceIds: [a.id, c.id, g.id] });
  const only = act(board, "add-action", "bob", { text: "only", sourceIds: [a.id] });

  act(board, "delete-card", "alice", { cardId: a.id });
  assert.deepEqual(board.stamps.map((s) => s.id), [kept.id]);
  assert.deepEqual(both.sourceIds, [c.id, g.id], "the group still holds b");
  assert.deepEqual(only.sourceIds, [], "an action with no source left stays");
  assert.equal(board.actionItems.length, 2);
  const out = JSON.stringify(redactBoard(board, T0));
  assert.equal(out.includes("alice"), false);
  assert.equal(out.includes('"' + a.id + '"'), false, "nothing published still names the note");

  act(board, "moderate-card", "fac", { cardId: b.id });
  assert.deepEqual(board.groups, [], "a group goes when its last note does");
  assert.deepEqual(both.sourceIds, [c.id]);
});

test("a group lasts as long as it holds a note: regrouping the same notes leaves one group", () => {
  const { board, a, b, c } = threeNotes();
  for (let i = 0; i < 5; i++) act(board, "group-cards", "bob", { cardIds: [a.id, b.id], title: "again " + i });
  assert.deepEqual(board.groups.map((g) => g.title), ["again 4"]);
  act(board, "move-card", "bob", { cardId: a.id, groupId: null });
  assert.equal(board.groups.length, 1, "b is still in it");
  act(board, "move-card", "bob", { cardId: b.id, columnId: "puzzles" });
  assert.deepEqual(board.groups, []);

  // A board stored with empty groups, and a note pointing at a group that is gone, is tidied when read.
  board.groups.push({ id: "g77", columnId: "went-well", title: "empty" });
  c.groupId = "g78";
  const out = redactBoard(board, T0);
  assert.deepEqual(out.groups, []);
  assert.equal(out.cards.find((row) => row.id === c.id).groupId, null);
});

test("nobody owns an action until somebody is named, and anyone can name them later or delete it", () => {
  const { board, a } = threeNotes();
  const blank = act(board, "add-action", "alice-the-author", { text: "fix it", sourceIds: [a.id] });
  assert.equal(blank.owner, "");
  assert.equal(act(board, "add-action", "alice-the-author", { text: "x", owner: "   " }).owner, "");
  assert.equal(act(board, "add-action", "alice-the-author", { text: "x", owner: null }).owner, "");
  assert.equal(act(board, "add-action", "alice-the-author", { text: "x", owner: " Bo " }).owner, "Bo");
  assert.equal(JSON.stringify(redactBoard(board, T0)).includes("alice-the-author"), false, "who wrote an action down never leaves the server");

  act(board, "set-owner", "carol", { actionId: blank.id, owner: "Cy Park" });
  assert.equal(redactBoard(board, T0).actionItems[0].owner, "Cy Park");
  act(board, "set-owner", "bob", { actionId: blank.id, owner: "" });
  assert.equal(blank.owner, "");
  act(board, "set-owner", "bob", { actionId: blank.id });
  assert.equal(blank.owner, "");

  act(board, "delete-action", "carol", { actionId: blank.id });
  assert.equal(board.actionItems.some((item) => item.id === blank.id), false);
  assert.equal(board.cards.length, 3, "deleting an action deletes no note");
});

test("an owner stored by 0.1.0 as a bare user id is dropped; a typed name is kept", () => {
  const board = emptyBoard();
  board.actionItems.push(
    { id: "a1", text: "old default", owner: "00000000-0000-0000-0000-0000000002c0", done: false, sourceIds: [] },
    { id: "a2", text: "typed", owner: "Dana", done: false, sourceIds: [] },
    { id: "a3", text: "typed, and it looks odd", owner: "team-0000", done: false, sourceIds: [] },
    { id: "a4", text: "not text", owner: { id: "x" }, done: false, sourceIds: [] },
  );
  assert.deepEqual(redactBoard(board, T0).actionItems.map((item) => item.owner), ["", "Dana", "team-0000", ""]);
});

test("the caps: notes, groups, votes and action items, per board and per person", () => {
  const board = emptyBoard();
  for (let i = 0; i < LIMITS.notesPerPerson; i++) note(board, "alice", "went-well", "n" + i);
  assert.equal(code(board, "add-card", "alice", { columnId: "went-well", text: "one more" }), "conflict");
  assert.equal(code(board, "add-card", "bob", { columnId: "went-well", text: "bob has room" }), "");
  // Deleting one makes room for one.
  act(board, "delete-card", "alice", { cardId: board.cards[0].id });
  assert.equal(code(board, "add-card", "alice", { columnId: "went-well", text: "room again" }), "");

  for (let i = board.cards.length; i < LIMITS.notes; i++) note(board, "p" + (i % 6), "went-well", "n" + i);
  assert.equal(board.cards.length, 120);
  assert.equal(code(board, "add-card", "zed", { columnId: "went-well", text: "one too many" }), "conflict");

  for (let i = 0; i < LIMITS.groups; i++) act(board, "group-cards", "bob", { cardIds: [board.cards[2 * i].id, board.cards[2 * i + 1].id], title: "g" + i });
  assert.equal(board.groups.length, 40);
  assert.equal(code(board, "group-cards", "bob", { cardIds: [board.cards[100].id, board.cards[101].id], title: "g" }), "conflict");
  assert.equal(code(board, "group-cards", "bob", { cardIds: [board.cards[0].id, board.cards[1].id], title: "renamed" }), "", "regrouping a whole group frees the one it replaces");
  assert.equal(board.groups.length, 40);

  for (let v = 0; v < 9; v++) for (let i = 0; i < 120 && v * 120 + i < LIMITS.votes; i++) act(board, "vote", "voter" + v, { cardId: board.cards[i].id });
  assert.equal(code(board, "vote", "voter9", { cardId: board.cards[0].id }), "conflict");
  assert.equal(code(board, "vote", "voter0", { cardId: board.cards[0].id }), "", "a vote already counted is not a new one");

  for (let i = 0; i < LIMITS.actions; i++) act(board, "add-action", "bob", { text: "a" + i });
  assert.equal(code(board, "add-action", "bob", { text: "one too many" }), "conflict");
  act(board, "delete-action", "carol", { actionId: board.actionItems[0].id });
  assert.equal(code(board, "add-action", "bob", { text: "room again" }), "");
});

// The largest document the caps allow: every text at its limit in characters
// that take three bytes each, every list full, user ids as long as the host's.
function worstBoard() {
  const board = emptyBoard();
  const wide = (n) => "\u8a9e".repeat(n);
  const who = (i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0");
  for (let i = 0; i < LIMITS.notes; i++) note(board, who(i % 8), ["went-well", "to-improve", "puzzles"][i % 3], wide(LIMITS.noteText));
  const lanes = ["went-well", "to-improve", "puzzles"].map((id) => board.cards.filter((c) => c.columnId === id));
  for (let i = 0; i < LIMITS.groups; i++) act(board, "group-cards", who(0), { cardIds: [lanes[i % 3][Math.floor(i / 3)].id, lanes[i % 3][39 - Math.floor(i / 3)].id].slice(0, 2), title: wide(LIMITS.groupTitle) });
  for (let i = 0; i < LIMITS.votes; i++) act(board, "vote", who(Math.floor(i / LIMITS.notes)), { cardId: board.cards[i % LIMITS.notes].id });
  for (let i = 0; i < LIMITS.stamps; i++) act(board, "stamp", who(Math.floor(i / 60)), { cardId: board.cards[Math.floor(i / 3)].id, kind: "quick-win", x: 0.123, y: 0.456, rot: -11.5 });
  for (let i = 0; i < LIMITS.actions; i++) act(board, "add-action", who(0), { text: wide(LIMITS.actionText), owner: wide(LIMITS.owner), sourceIds: board.cards.slice(i, i + 12).map((c) => c.id) });
  act(board, "timer", who(0), { op: "start", durationMs: 10_800_000 }, T0);
  return board;
}

test("a board at every cap is about a third of the store's quota, and nothing more can be added to it", () => {
  const board = worstBoard();
  assert.deepEqual(
    [board.cards.length, board.groups.length, board.stamps.length, board.actionItems.length],
    [LIMITS.notes, LIMITS.groups, LIMITS.stamps, LIMITS.actions],
  );
  const bytes = Buffer.byteLength(JSON.stringify(board), "utf8");
  // By hand (README.md): 120 notes of 1,500 bytes of text and about 140 of
  // structure; 1,000 votes of 41; 300 stamps of about 135; 40 groups of about
  // 290; 30 actions of about 1,900. Roughly 340,000 bytes of 1,048,576.
  assert.ok(bytes > 300_000 && bytes < 360_000, "the worst board is " + bytes + " bytes");
  assert.ok(bytes * 3 < require("./manifest.json").quotaBytes, "three of them fit in the quota");
  for (const [action, body] of [
    ["add-card", { columnId: "went-well", text: "x" }],
    ["vote", { cardId: board.cards[0].id }],
    ["stamp", { cardId: board.cards[119].id, kind: "idea", x: 0, y: 0 }],
    ["add-action", { text: "x" }],
  ]) {
    assert.equal(code(board, action, "newcomer", body), "conflict", action);
  }
});

test("building the state of a board at every cap, and regrouping on it, takes milliseconds", () => {
  const board = worstBoard();
  const ids = board.cards.filter((c) => c.columnId === "went-well").map((c) => c.id);
  const started = performance.now();
  for (let i = 0; i < 10; i++) redactBoard(board, T0);
  act(board, "group-cards", "u", { cardIds: ids, title: "all" });
  act(board, "moderate-card", "fac", { cardId: ids[0] });
  const each = (performance.now() - started) / 12;
  // The guest has two seconds a call. Under node this is well under a
  // millisecond; the bound is loose so a slow runner does not fail it.
  assert.ok(each < 200, "one call took " + each.toFixed(1) + " ms");
  assert.equal(redactBoard(board, T0).actionItems.every((item) => item.sourceIds.length <= 12), true);
});
