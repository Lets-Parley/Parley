import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)("./manifest.json");
const src = readFileSync(join(dir, "ui.js"), "utf8");
const distSrc = readFileSync(join(dir, "dist", `retrospective-${version}.ui.js`), "utf8");

// The smallest document ui.js can run against. It models the two things the
// tests are about: a tree of nodes, and focus that is lost when the focused
// node is removed or moved, the way a browser loses it.
class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.value = "";
    this.text = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
  }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument.body) return true;
    return false;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    for (const c of [...this.children]) this.removeChild(c);
    this.text = String(value);
  }
  set innerHTML(_) {
    throw new Error("ui.js must build nodes, not markup");
  }
  holdsFocus() {
    for (let n = this.ownerDocument.activeElement; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    if (child.holdsFocus()) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, event = {}) {
    const ev = { preventDefault() {}, target: this, ...event };
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  focus() {
    if (this.isConnected) this.ownerDocument.activeElement = this;
  }
  click() {
    if (!this.disabled) this.fire("click");
  }
  type(value) {
    this.value = value;
    this.fire("input");
  }
}

function load() {
  const timers = [];
  const acts = [];
  const document = {
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeNode(document, tag),
    createElementNS: (_, tag) => new FakeNode(document, tag),
    getElementById: (id) => (id === "root" ? root : null),
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
  };
  document.documentElement = new FakeNode(document, "html");
  document.head = new FakeNode(document, "head");
  document.body = new FakeNode(document, "body");
  document.activeElement = document.body;
  const root = new FakeNode(document, "div");
  document.body.appendChild(root);
  let push;
  const window = {
    parley: {
      onTokens() {},
      onState(fn) {
        push = fn;
      },
      ready() {},
      act(action, payload) {
        // Round-tripped so the objects belong to this realm, not the UI's.
        acts.push(JSON.parse(JSON.stringify({ action, payload })));
      },
    },
  };
  const setTimeout = (fn) => timers.push(fn);
  const clearTimeout = (id) => {
    timers[id - 1] = null;
  };
  runInContext(src, createContext({ window, document, setTimeout, clearTimeout }));
  assert.equal(typeof push, "function");
  const runTimers = () => timers.splice(0).forEach((fn) => fn && fn());
  return { root, document, push, acts, runTimers };
}

function all(node, test, out = []) {
  if (test(node)) out.push(node);
  for (const c of node.children) all(c, test, out);
  return out;
}
const visible = (node) => {
  for (let n = node; n; n = n.parentNode) if (n.hidden) return false;
  return true;
};
const byClass = (node, name) => all(node, (n) => n.className.split(" ").includes(name));
const button = (node, label) =>
  all(node, (n) => n.tagName === "BUTTON" && n.textContent.startsWith(label) && visible(n))[0];
const noteWith = (root, text) => byClass(root, "note").find((n) => n.textContent.includes(text));
const lane = (root, title) => byClass(root, "lane").find((n) => n.textContent.includes(title));
const pick = (root, text) => all(noteWith(root, text), (n) => n.tagName === "INPUT")[0];

const columns = [
  { id: "went-well", title: "Went well" },
  { id: "to-improve", title: "To improve" },
  { id: "puzzles", title: "Puzzles" },
];
const participants = [
  { userId: "u-alice", name: "Alice Ng", avatarHue: 40 },
  { userId: "u-bo", name: "Bo Reyes", avatarHue: 200 },
  { userId: "u-cy", name: "Cy Park", avatarHue: 300 },
];
const card = (id, columnId, text, more = {}) => ({ id, columnId, groupId: null, text, voteCount: 0, ...more });

function session(state) {
  return {
    facilitatorId: "u-alice",
    participants,
    state: { revealed: false, columns, cards: [], groups: [], actionItems: [], ...state },
  };
}

function select(root, text) {
  const box = pick(root, text);
  box.checked = !box.checked;
  box.fire("change");
}

function assertNoNetwork(js) {
  assert.doesNotMatch(js, /\bfetch\s*\(/);
  assert.doesNotMatch(js, /XMLHttpRequest/);
  assert.doesNotMatch(js, /\bWebSocket\b/);
}

test("the UI talks only over the host bridge", () => {
  assert.match(src, /parley\.onState/);
  assert.match(src, /parley\.onTokens/);
  assert.match(src, /parley\.act\(/);
  assert.match(src, /parley\.ready\(/);
  assertNoNetwork(src);
  assertNoNetwork(distSrc);
});

test("the UI never writes markup, so no state can become an element", () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const { root, push } = load();
  push(session({ cards: [card("c1", "went-well", "dots", { voteCount: "<img src=x onerror=alert(1)>" })] }));
  assert.equal(all(root, (n) => n.tagName === "IMG").length, 0);
});

test("typed text and focus survive a teammate's change", () => {
  const { root, document, push } = load();
  push(session({ cards: [card("c1", "went-well", "shipped the export")] }));
  const box = all(lane(root, "Went well"), (n) => n.tagName === "TEXTAREA")[0];
  box.focus();
  box.type("half a thou");

  push(
    session({
      cards: [card("c1", "went-well", "shipped the export", { voteCount: 1 }), card("c2", "went-well", "pairing")],
    }),
  );

  const after = all(lane(root, "Went well"), (n) => n.tagName === "TEXTAREA")[0];
  assert.equal(after, box, "the composer is the same node");
  assert.equal(box.value, "half a thou");
  assert.equal(document.activeElement, box);
  assert.ok(noteWith(root, "pairing"));
});

test("focus on a note survives the note moving into a group", () => {
  const { root, document, push } = load();
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two")];
  push(session({ cards }));
  const vote = button(noteWith(root, "one"), "Vote");
  vote.focus();
  push(
    session({
      cards: cards.map((c) => ({ ...c, groupId: "g1" })),
      groups: [{ id: "g1", columnId: "went-well", title: "Numbers" }],
    }),
  );
  assert.equal(document.activeElement, vote);
});

test("a group holds its own notes and nobody else's", () => {
  const { root, push } = load();
  push(
    session({
      cards: [
        card("c1", "went-well", "fast reviews", { groupId: "g1" }),
        card("c2", "went-well", "pairing", { groupId: "g1" }),
        card("c3", "went-well", "the offsite"),
      ],
      groups: [{ id: "g1", columnId: "went-well", title: "Collaboration" }],
    }),
  );
  const groups = byClass(root, "group");
  assert.equal(groups.length, 1);
  assert.match(groups[0].textContent, /Collaboration/);
  const inside = byClass(groups[0], "note").map((n) => n.textContent);
  assert.equal(inside.length, 2);
  assert.ok(inside.every((t) => !t.includes("the offsite")));
  assert.equal(byClass(lane(root, "Went well"), "note").length, 3);
});

test("authors are names, only after the reveal, and never raw ids", () => {
  const { root, push } = load();
  const cards = [
    card("c1", "went-well", "shipped the export", { authorId: "u-cy" }),
    card("c2", "puzzles", "why is CI slow", { authorId: "u-gone" }),
  ];
  push(session({ cards, actionItems: [{ id: "a1", text: "profile CI", owner: "u-bo", done: false }] }));
  const shown = () => all(root, visible).map((n) => n.text).join("\n");
  assert.doesNotMatch(shown(), /Cy Park/);
  assert.match(shown(), /Bo Reyes/, "an action owner is a name");

  push(session({ revealed: true, cards }));
  assert.match(shown(), /Cy Park/);
  assert.match(shown(), /Former participant/);
  assert.doesNotMatch(root.textContent, /u-alice|u-gone|u-bo|u-cy/);
});

test("Group stays disabled, with the reason, until two notes in one lane are selected", () => {
  const { root, push, acts } = load();
  push(
    session({
      cards: [card("c1", "went-well", "one"), card("c2", "went-well", "two"), card("c3", "puzzles", "three")],
    }),
  );
  const bar = byClass(root, "select-bar")[0];
  assert.equal(bar.hidden, true);

  select(root, "one");
  const group = button(bar, "Group");
  assert.equal(bar.hidden, false);
  assert.equal(group.disabled, true);
  assert.match(bar.textContent, /1 note selected/);
  assert.match(bar.textContent, /one more note/);

  select(root, "three");
  assert.equal(group.disabled, true);
  assert.match(bar.textContent, /inside one lane/);

  select(root, "three");
  select(root, "two");
  assert.equal(group.disabled, false);
  group.click();
  assert.deepEqual(acts, [{ action: "group-cards", payload: { cardIds: ["c1", "c2"], title: "Theme" } }]);
});

test("revealing authors takes a second, explicit confirmation", () => {
  const { root, push, acts } = load();
  push(session({ cards: [card("c1", "went-well", "one")] }));
  button(root, "Reveal authors").click();
  assert.deepEqual(acts, []);
  assert.match(byClass(root, "reveal")[0].textContent, /cannot be undone/);

  button(root, "Not yet").click();
  assert.deepEqual(acts, []);

  button(root, "Reveal authors").click();
  button(root, "Reveal to everyone").click();
  assert.deepEqual(acts, [{ action: "reveal", payload: {} }]);

  push(session({ revealed: true, cards: [card("c1", "went-well", "one", { authorId: "u-bo" })] }));
  assert.equal(button(root, "Reveal"), undefined);
  assert.ok(all(root, (n) => visible(n) && n.text === "Authors visible").length);
});

test("a reveal the server refuses is explained, not swallowed", () => {
  const { root, push, runTimers } = load();
  push(session({}));
  button(root, "Reveal authors").click();
  button(root, "Reveal to everyone").click();
  runTimers();
  const toast = byClass(root, "toast")[0];
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /Only the facilitator, Alice Ng, can/);
});

test("Enter adds a note once; an empty note is never sent", () => {
  const { root, push, acts } = load();
  push(session({}));
  const box = all(lane(root, "To improve"), (n) => n.tagName === "TEXTAREA")[0];
  const enter = { key: "Enter", shiftKey: false };
  box.fire("keydown", enter);
  box.type("   ");
  box.fire("keydown", enter);
  assert.deepEqual(acts, []);
  assert.equal(button(lane(root, "To improve"), "Add note").disabled, true);

  box.type("flaky deploys");
  box.fire("keydown", enter);
  box.fire("keydown", enter);
  assert.deepEqual(acts, [{ action: "add-card", payload: { columnId: "to-improve", text: "flaky deploys" } }]);
  assert.equal(box.value, "flaky deploys", "kept until the server has it");

  push(session({ cards: [card("c9", "to-improve", "flaky deploys")] }));
  assert.equal(box.value, "");
});

test("remote changes are announced politely, and the first paint is not", () => {
  const { root, push } = load();
  const live = byClass(root, "live")[0];
  assert.equal(live.getAttribute("role"), "status");
  push(session({ cards: [card("c1", "went-well", "one")] }));
  assert.equal(live.textContent, "");
  push(session({ cards: [card("c1", "went-well", "one"), card("c2", "puzzles", "two")] }));
  assert.match(live.textContent, /New note in Puzzles/);
});

test("the layout is one column that cannot overflow at phone width", () => {
  const { root, document, push } = load();
  push(session({ cards: [card("c1", "went-well", "x".repeat(500))] }));
  const css = document.head.textContent.replace(/\s+/g, "");
  assert.match(css, /\.lanes\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /@media\(min-width:860px\)\{\.lanes\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.note-text\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.field\{[^}]*min-width:0/);
  assert.equal(byClass(root, "lanes")[0].children.length, 3);
  assert.equal(byClass(noteWith(root, "xxx"), "note-text").length, 1);
});
