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

  const full = emptyBoard();
  const rows = Array.from({ length: 101 }, (_, i) => note(full, "u", "went-well", "n" + i));
  for (let i = 0; i < 300; i++) act(full, "stamp", "p" + (i % 3), { cardId: rows[Math.floor(i / 3)].id, kind: "laugh", x: 0, y: 0 });
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
