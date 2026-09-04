import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "ui.js"), "utf8");
const distSrc = readFileSync(join(dir, "dist", "retrospective-0.1.0.ui.js"), "utf8");

function assertNoNetwork(js) {
  assert.doesNotMatch(js, /\bfetch\s*\(/);
  assert.doesNotMatch(js, /XMLHttpRequest/);
  assert.doesNotMatch(js, /\bWebSocket\b/);
}

function loadDraw() {
  const root = {
    innerHTML: "",
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  let draw;
  const window = {
    parley: {
      onTokens() {},
      onState(fn) {
        draw = fn;
      },
      ready() {},
      act() {},
      state() {
        return {};
      },
    },
  };
  const document = {
    getElementById(id) {
      return id === "root" ? root : null;
    },
  };
  runInContext(src, createContext({ window, document }));
  assert.equal(typeof draw, "function");
  return { root, draw };
}

const columns = [
  { id: "went-well", title: "Went well" },
  { id: "to-improve", title: "To improve" },
  { id: "puzzles", title: "Puzzles" },
];

test("the UI talks only over the host bridge", () => {
  assert.match(src, /parley\.onState/);
  assert.match(src, /parley\.onTokens/);
  assert.match(src, /parley\.act\(/);
  assert.match(src, /parley\.ready\(/);
  assertNoNetwork(src);
  assertNoNetwork(distSrc);
});

test("draw hides author markup until reveal", () => {
  const { root, draw } = loadDraw();
  const card = {
    id: "c1",
    columnId: "went-well",
    text: "shipped the export",
    authorId: "alice",
    voteCount: 2,
  };
  draw({
    state: {
      revealed: false,
      columns,
      cards: [card],
      groups: [],
      actionItems: [],
    },
  });
  assert.match(root.innerHTML, /Went well/);
  assert.match(root.innerHTML, /vote/);
  assert.match(root.innerHTML, /Reveal/);
  assert.match(root.innerHTML, /Action items/);
  assert.equal(root.innerHTML.includes("alice"), false);
  assert.doesNotMatch(root.innerHTML, /authorId/);

  draw({
    state: {
      revealed: true,
      columns,
      cards: [card],
      groups: [],
      actionItems: [],
    },
  });
  assert.match(root.innerHTML, /alice/);
});

test("draw escapes voteCount", () => {
  const { root, draw } = loadDraw();
  draw({
    state: {
      revealed: false,
      columns,
      cards: [
        {
          id: "c1",
          columnId: "went-well",
          text: "dots",
          voteCount: '<img src=x onerror=alert(1)>',
        },
      ],
      groups: [],
      actionItems: [],
    },
  });
  assert.equal(root.innerHTML.includes("<img"), false);
  assert.match(root.innerHTML, /&lt;img/);
});
