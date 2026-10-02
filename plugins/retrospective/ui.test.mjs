import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const dir = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)("./manifest.json");
// RETRO_UI_SRC points the suite at another copy of the source, for checking
// that a test can fail. The tracked file is never edited for that.
const srcPath = process.env.RETRO_UI_SRC || join(dir, "ui.src.js");
const src = readFileSync(srcPath, "utf8");
const fontSrc = readFileSync(join(dir, "ui.fonts.js"), "utf8");
const distSrc = readFileSync(join(dir, "dist", `retrospective-${version}.ui.js`), "utf8");

// A parent chain longer than this is a bug in the UI or in this fake, and a
// loop that follows one must stop rather than run until memory is gone.
const MAX_DEPTH = 1000;
function* upFrom(node) {
  let hops = 0;
  for (let n = node; n; n = n.parentNode) {
    if (++hops > MAX_DEPTH) throw new Error("parent chain is longer than " + MAX_DEPTH + ": a cycle");
    yield n;
  }
}

// Whether two references are one node. The assertion is handed a boolean, so
// a failure never carries a node for the runner to print or send anywhere.
function same(actual, expected, message) {
  assert.ok(actual === expected, message);
}

// That a lookup found nothing. A node is never handed to an assertion.
function absent(node, message) {
  assert.ok(node === undefined || node === null, message);
}

// The smallest document ui.js can run against. It models the two things the
// tests are about: a tree of nodes, and focus that is lost when the focused
// node is removed or moved, the way a browser loses it.
class FakeNode {
  // A node prints as its tag. Every node reaches the whole document through
  // ownerDocument, so printing one in full to report a failed assertion costs
  // gigabytes: that, not a loop, is what a failing test used to die of.
  [inspect.custom]() {
    return "<" + this.tagName.toLowerCase() + (this.className ? "." + this.className.split(" ").join(".") : "") + ">";
  }
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.readOnly = false;
    const node = this;
    this.classList = {
      names: () => node.className.split(" ").filter(Boolean),
      contains: (name) => this.classList.names().includes(name),
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
      toggle(name, on) {
        const rest = this.names().filter((n) => n !== name);
        node.className = (on ? [...rest, name] : rest).join(" ");
      },
    };
    this.value = "";
    this.text = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
  }
  get isConnected() {
    for (const n of upFrom(this)) if (n === this.ownerDocument.body) return true;
    return false;
  }
  get nextElementSibling() {
    const kids = this.parentNode ? this.parentNode.children : [];
    return kids[kids.indexOf(this) + 1] || null;
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
    for (const n of upFrom(this.ownerDocument.activeElement)) if (n === this) return true;
    return false;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, ref) {
    // As a real DOM does: a node cannot be put inside itself, and the
    // reference has to be a child of this node.
    for (const n of upFrom(this)) if (n === child) throw new Error("HierarchyRequestError: the new child contains the parent");
    if (ref && ref.parentNode !== this) throw new Error("NotFoundError: the reference node is not a child of this node");
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    if (child.parentNode !== this || !this.children.includes(child)) throw new Error("NotFoundError: not a child of this node");
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
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((other) => other !== fn);
  }
  // Nothing is laid out here. A test that needs a note to be somewhere says
  // where by setting `box`; everything else measures as nothing.
  getBoundingClientRect() {
    const { left = 0, top = 0, width = 0, height = 0 } = this.box || {};
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  // The copy a drag carries. It is looked at, never looked into.
  cloneNode() {
    const copy = new FakeNode(this.ownerDocument, this.tagName);
    copy.className = this.className;
    return copy;
  }
  fire(type, event = {}) {
    const ev = { type, preventDefault() {}, stopPropagation() {}, target: this, ...(type.startsWith("pointer") ? { pointerId: 1 } : {}), ...event };
    for (const fn of [...(this.listeners[type] || [])]) fn(ev);
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

// `host: "old"` is a Parley that returns nothing from an action. `host: "new"`
// returns a promise per action, which the test settles through acts[n].answer.
function load({ host = "old" } = {}) {
  // Timers are kept by id, and an id is never used twice, so clearing a timer
  // that has already run cannot cancel a different one.
  const timers = new Map();
  let lastTimer = 0;
  const bridge = { fail: null, scheme: "dark", tokens: null };
  // The frame's clock. A test moves it by hand; nothing reads the real time.
  const clock = { t: 0 };
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
  const parley = {
    onTokens(fn) {
      bridge.tokens = fn;
    },
    onState(fn) {
      push = fn;
    },
    ready() {},
    act(action, payload) {
      // Round-tripped so the objects belong to this realm, not the UI's.
      const sent = JSON.parse(JSON.stringify({ action, payload }));
      acts.push(sent);
      if (bridge.fail === "throw") throw new Error("message too large");
      if (bridge.fail === "reject") return Promise.reject(new Error("bridge closed"));
      if (host === "old") return undefined;
      return new Promise((resolve) => {
        sent.answer = resolve;
      });
    },
  };
  if (host === "new") {
    parley.supports = (feature) => feature === "results";
    parley.scheme = () => bridge.scheme;
  }
  // The window hears what the UI asks it to hear, and forgets what the UI
  // takes off again: a drag is followed here, not on the thing pressed.
  const window = {
    parley,
    listeners: {},
    innerWidth: 1280,
    innerHeight: 800,
    scrollBy() {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((other) => other !== fn);
    },
    performance: { now: () => clock.t },
  };
  const fireWindow = (type, event = {}) => {
    for (const fn of [...(window.listeners[type] || [])]) fn({ type, preventDefault() {}, ...(type.startsWith("pointer") ? { pointerId: 1 } : {}), ...event });
  };
  const hearing = (type) => (window.listeners[type] || []).length;
  const setTimeout = (fn, ms) => {
    timers.set(++lastTimer, { fn, ms });
    return lastTimer;
  };
  const clearTimeout = (id) => {
    timers.delete(id);
  };
  runInContext(src, createContext({ window, document, setTimeout, clearTimeout }));
  assert.equal(typeof push, "function");
  // Runs the timers pending now whose delay is at most `upTo`. Timers they
  // set in turn wait for the next call.
  const runTimers = (upTo = Infinity) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms > upTo || !timers.delete(id)) continue;
      timer.fn();
    }
  };
  const sent = () => acts.map(({ action, payload }) => ({ action, payload }));
  // Events do not bubble in this document, so a key the UI listens for on the
  // document is handed to those listeners directly.
  const press = (key) => {
    for (const fn of document.listeners.keydown || []) fn({ key, preventDefault() {} });
  };
  // A press somewhere in the document, as the document's own listeners hear it.
  const pressOn = (target) => {
    for (const fn of document.listeners.pointerdown || []) fn({ type: "pointerdown", target });
  };
  return { root, document, push, acts, sent, runTimers, bridge, clock, press, pressOn, fireWindow, hearing };
}

// Lets a settled promise's callbacks run.
const settled = () => new Promise((resolve) => setImmediate(resolve));

function all(node, test, out = []) {
  if (test(node)) out.push(node);
  for (const c of node.children) all(c, test, out);
  return out;
}
const visible = (node) => {
  for (const n of upFrom(node)) if (n.hidden) return false;
  return true;
};
const byClass = (node, name) => all(node, (n) => n.className.split(" ").includes(name));
const button = (node, label) =>
  all(node, (n) => n.tagName === "BUTTON" && n.textContent.startsWith(label) && visible(n))[0];
const noteWith = (root, text) => byClass(root, "note").find((n) => n.textContent.includes(text));
const lane = (root, title) => byClass(root, "lane").find((n) => n.textContent.includes(title));
const pick = (root, text) => all(noteWith(root, text), (n) => n.tagName === "INPUT")[0];
const one = (node, name) => byClass(node, name)[0];
const labeled = (node, start) => all(node, (n) => visible(n) && (n.getAttribute("aria-label") || "").startsWith(start))[0];
const menuItem = (root, label) => all(root, (n) => n.getAttribute("role") === "menuitem" && n.textContent.startsWith(label))[0];
const noteOrder = (root, title) => byClass(lane(root, title), "note").map((n) => one(n, "note-text").textContent).join(" ");
const liveOf = (root) => one(root, "live").textContent;
const FACILITATOR = { selfId: "u-alice" };
const PARTICIPANT = { selfId: "u-bo" };

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

function session(state, more = {}) {
  return {
    facilitatorId: "u-alice",
    participants,
    state: { revealed: false, columns, cards: [], groups: [], actionItems: [], ...state },
    ...more,
  };
}
const toastOf = (root) => byClass(root, "toast")[0];
const composer = (root, title) => all(lane(root, title), (n) => n.tagName === "TEXTAREA")[0];
const ENTER = { key: "Enter", shiftKey: false };

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

test("the shipped ui.js is the fonts followed by the readable source", () => {
  assert.equal(distSrc, fontSrc + readFileSync(join(dir, "ui.src.js"), "utf8"));
});

test("the font license travels inside the shipped file", () => {
  assert.match(distSrc, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(distSrc, /Copyright 2022 The Instrument Sans Project Authors/);
  assert.match(distSrc, /Copyright 2020 The JetBrains Mono Project Authors/);
  assert.match(distSrc, /PERMISSION & CONDITIONS/);
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
  same(after, box, "the composer is the same node");
  assert.equal(box.value, "half a thou");
  same(document.activeElement, box, "focus stays in the composer");
  assert.ok(noteWith(root, "pairing"));
});

test("focus on a note survives the note moving into a group", () => {
  const { root, document, push } = load();
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two")];
  push(session({ stage: 2, cards }));
  const vote = button(noteWith(root, "one"), "Vote");
  vote.focus();
  push(
    session({
      stage: 2,
      cards: cards.map((c) => ({ ...c, groupId: "g1" })),
      groups: [{ id: "g1", columnId: "went-well", title: "Numbers" }],
    }),
  );
  same(document.activeElement, vote, "focus stays on the vote button");
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

test("Group stays disabled, with the reason, until two notes in one lane are selected and named", () => {
  const { root, push, sent } = load();
  push(
    session({
      cards: [card("c1", "went-well", "one"), card("c2", "went-well", "two"), card("c3", "puzzles", "three")],
    }),
  );
  const bar = byClass(root, "select-bar")[0];
  assert.equal(bar.hidden, true);

  select(root, "one");
  const group = button(bar, "Group");
  const name = all(bar, (n) => n.tagName === "INPUT")[0];
  assert.equal(bar.hidden, false);
  assert.equal(group.disabled, true);
  assert.match(bar.textContent, /1 selected/);
  assert.match(bar.textContent, /one more/);

  select(root, "three");
  assert.equal(group.disabled, true);
  assert.match(bar.textContent, /inside one lane/);

  select(root, "three");
  select(root, "two");
  assert.equal(group.disabled, true, "a group needs a name");
  assert.match(bar.textContent, /Name the group/);
  name.type("Numbers");
  assert.equal(group.disabled, false);
  group.click();
  assert.deepEqual(sent(), [{ action: "group-cards", payload: { cardIds: ["c1", "c2"], title: "Numbers" } }]);
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

test("revealing authors takes a second, explicit confirmation", () => {
  const { root, push, sent } = load();
  push(session({ cards: [card("c1", "went-well", "one")] }));
  button(root, "Reveal authors").click();
  assert.deepEqual(sent(), []);
  assert.match(byClass(root, "authorship")[0].textContent, /You can hide them again, but anyone looking now will have seen them/);

  button(root, "Not yet").click();
  assert.deepEqual(sent(), []);

  button(root, "Reveal authors").click();
  const confirm = button(root, "Reveal to everyone");
  confirm.click();
  assert.deepEqual(sent(), [{ action: "reveal", payload: {} }]);
  assert.equal(confirm.disabled, true, "no second press while the first is pending");

  push(session({ revealed: true, cards: [card("c1", "went-well", "one", { authorId: "u-bo" })] }));
  assert.ok(!button(root, "Reveal"), "no such button is offered");
  assert.ok(all(root, (n) => visible(n) && n.text === "Authors are visible").length);
});

test("Reveal is not offered on an empty board", () => {
  const { root, push } = load();
  push(session({}));
  assert.ok(!button(root, "Reveal authors"), "no such button is offered");
  push(session({ cards: [card("c1", "went-well", "one")] }));
  assert.ok(button(root, "Reveal authors"));
});

test("with the viewer known, only the facilitator is offered Reveal", () => {
  const cards = [card("c1", "went-well", "one")];
  const words = (root) => byClass(root, "authorship")[0].textContent;

  const participant = load({ host: "new" });
  participant.push(session({ cards }, { selfId: "u-bo" }));
  assert.ok(!button(participant.root, "Reveal authors"), "no such button is offered");
  assert.match(words(participant.root), /Alice Ng, the facilitator, reveals/);

  const facilitator = load({ host: "new" });
  facilitator.push(session({ cards }, { selfId: "u-alice" }));
  assert.ok(button(facilitator.root, "Reveal authors"));
  assert.doesNotMatch(words(facilitator.root), /Alice Ng/, "she is not told about herself in the third person");
  assert.match(words(facilitator.root), /Only you/);

  const unknown = load({ host: "new" });
  unknown.push(session({ cards }, { selfId: null }));
  assert.ok(button(unknown.root, "Reveal authors"));
  assert.match(words(unknown.root), /Only the facilitator, Alice Ng, can/);
});

test("a host that answers is believed at once: the reason is shown without waiting", async () => {
  const { root, push, acts, runTimers } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")] }));
  button(root, "Reveal authors").click();
  button(root, "Reveal to everyone").click();
  acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(root).hidden, false, "no timer had to run");
  assert.match(toastOf(root).textContent, /Only the facilitator, Alice Ng, can reveal authors/);
  assert.ok(button(root, "Reveal authors"), "the confirmation is put away");

  composer(root, "Puzzles").type("why");
  composer(root, "Puzzles").fire("keydown", ENTER);
  acts[1].answer({ ok: false, reason: "unreachable" });
  await settled();
  assert.match(toastOf(root).textContent, /Could not reach the server/);
  const ghost = byClass(root, "ghost")[0];
  assert.match(ghost.textContent, /why/, "the text is kept");
  runTimers();
  assert.match(ghost.textContent, /Not saved/, "and stays refused, with no second verdict later");
});

test("an outcome the host cannot report is not called a failure", async () => {
  const { root, push, acts, runTimers } = load({ host: "new" });
  push(session({}));
  composer(root, "Puzzles").type("why");
  composer(root, "Puzzles").fire("keydown", ENTER);
  acts[0].answer({ ok: false, reason: "unknown" });
  await settled();
  assert.equal(toastOf(root).hidden, true, "unknown is not a refusal");
  runTimers();
  assert.match(toastOf(root).textContent, /Could not confirm/);
  assert.doesNotMatch(toastOf(root).textContent, /try again/i);
});

test("a reveal an older host refuses in silence is explained", () => {
  const { root, push, runTimers } = load();
  push(session({ cards: [card("c1", "went-well", "one")] }));
  button(root, "Reveal authors").click();
  button(root, "Reveal to everyone").click();
  runTimers();
  assert.equal(toastOf(root).hidden, false);
  assert.match(toastOf(root).textContent, /Only the facilitator, Alice Ng, can/);
});

test("Enter adds a note once; an empty note is never sent", () => {
  const { root, push, sent } = load();
  push(session({}));
  const box = composer(root, "To improve");
  box.fire("keydown", ENTER);
  box.type("   ");
  box.fire("keydown", ENTER);
  assert.deepEqual(sent(), []);

  box.type("flaky deploys");
  box.fire("keydown", ENTER);
  box.fire("keydown", ENTER);
  assert.deepEqual(sent(), [{ action: "add-card", payload: { columnId: "to-improve", text: "flaky deploys" } }]);
  assert.equal(box.value, "", "the box is free for the next thought");
  assert.match(byClass(lane(root, "To improve"), "ghost")[0].textContent, /flaky deploys/);

  push(session({ cards: [card("c9", "to-improve", "flaky deploys")] }));
  assert.equal(byClass(root, "ghost").length, 0);
  assert.equal(byClass(lane(root, "To improve"), "note").filter((n) => n.textContent.includes("flaky")).length, 1);
});

test("a second note typed while the first is saving is sent after it, not dropped", () => {
  const { root, push, sent } = load();
  push(session({}));
  const box = composer(root, "Went well");
  box.type("first");
  box.fire("keydown", ENTER);
  box.type("second");
  box.fire("keydown", ENTER);
  assert.equal(sent().length, 1, "one at a time: the board is one document");
  assert.equal(byClass(root, "ghost").length, 2);

  push(session({ cards: [card("c1", "went-well", "first")] }));
  assert.deepEqual(
    sent().map((a) => a.payload.text),
    ["first", "second"],
  );
  push(session({ cards: [card("c1", "went-well", "first"), card("c2", "went-well", "second")] }));
  assert.equal(byClass(root, "ghost").length, 0);
});

test("a note that lands after the wait is not reported lost and cannot be sent twice", () => {
  const { root, push, sent, runTimers } = load();
  push(session({}));
  const box = composer(root, "Went well");
  box.type("slow one");
  box.fire("keydown", ENTER);
  runTimers();
  assert.equal(toastOf(root).hidden, false);
  assert.match(byClass(root, "ghost")[0].textContent, /slow one/);

  push(session({ cards: [card("c1", "went-well", "slow one")] }));
  assert.equal(toastOf(root).hidden, true, "the warning is taken back");
  assert.equal(byClass(root, "ghost").length, 0, "nothing is left to send again");
  assert.equal(byClass(root, "note").filter((n) => n.textContent.includes("slow one")).length, 1);
  assert.equal(sent().length, 1);
});

test("a teammate's vote is never shown as the viewer's own", async () => {
  const pressed = (root) => button(noteWith(root, "one"), "Vote").getAttribute("aria-pressed");
  const before = session({ stage: 2, cards: [card("c1", "went-well", "one")] });
  const after = session({ stage: 2, cards: [card("c1", "went-well", "one", { voteCount: 1 })] });

  const watcher = load({ host: "new" });
  watcher.push(before);
  watcher.push(after);
  assert.notEqual(pressed(watcher.root), "true");

  // An older host cannot say whose vote moved the count.
  const old = load();
  old.push(before);
  button(noteWith(old.root, "one"), "Vote").click();
  old.push(after);
  assert.notEqual(pressed(old.root), "true");

  const voter = load({ host: "new" });
  voter.push(before);
  button(noteWith(voter.root, "one"), "Vote").click();
  voter.acts[0].answer({ ok: true });
  await settled();
  assert.equal(pressed(voter.root), "true");
  button(noteWith(voter.root, "one"), "Vote").click();
  assert.equal(voter.acts.length, 1, "a counted vote is not sent again");
});

test("malformed state is drawn as far as it makes sense and never throws", () => {
  const { root, push } = load();
  push({ state: { columns, cards: "nope", groups: null, actionItems: 7 } });
  push({ participants: [{ userId: "u-x" }, null], state: { revealed: true, columns, cards: [null, { id: "c1", columnId: "went-well", authorId: "u-x" }, card("c2", "went-well", "fine")] } });
  push(null);
  assert.equal(byClass(root, "note").length, 2);
  assert.match(noteWith(root, "fine").textContent, /fine/);
  assert.match(root.textContent, /Former participant/);
});

test("a group or lane that leaves the state leaves the board", () => {
  const { root, push } = load();
  push(
    session({
      cards: [card("c1", "went-well", "a", { groupId: "g1" }), card("c2", "went-well", "b", { groupId: "g1" })],
      groups: [{ id: "g1", columnId: "went-well", title: "Pair" }],
    }),
  );
  assert.equal(byClass(root, "group").length, 1);
  push(session({ columns: columns.slice(0, 2), cards: [card("c1", "went-well", "a"), card("c2", "went-well", "b")] }));
  assert.equal(byClass(root, "group").length, 0);
  assert.equal(byClass(root, "lane").length, 2);
  push(session({ cards: [card("c1", "went-well", "a", { groupId: "g1" })], groups: [{ id: "g1", columnId: "went-well", title: "Solo" }] }));
  assert.match(byClass(root, "group")[0].textContent, /Solo/);
  assert.doesNotMatch(byClass(root, "group")[0].textContent, /Pair/);
});

const WAIT = 3000;

test("an action the bridge will not carry is refused at once and leaves nothing pending", async () => {
  for (const fail of ["throw", "reject"]) {
    const { root, push, bridge, runTimers, sent } = load({ host: "new" });
    push(session({ cards: [card("c1", "went-well", "one")] }));
    bridge.fail = fail;
    composer(root, "Puzzles").type("too big");
    composer(root, "Puzzles").fire("keydown", ENTER);
    await settled();
    assert.match(toastOf(root).textContent, /could not be sent/, fail);
    assert.match(byClass(root, "ghost")[0].textContent, /Not saved/, fail);

    bridge.fail = null;
    composer(root, "Puzzles").type("fits");
    composer(root, "Puzzles").fire("keydown", ENTER);
    assert.equal(sent().length, 2, "the queue is not stuck behind the failed send");
    runTimers(WAIT);
    assert.match(byClass(root, "ghost")[0].textContent, /Not saved/, "and no second verdict arrives for it");
  }
});

test("a note that lands long after its send was forgotten does not leave its ghost beside it", () => {
  const { root, push, runTimers, sent } = load();
  push(session({}));
  composer(root, "Went well").type("very slow");
  composer(root, "Went well").fire("keydown", ENTER);
  runTimers(WAIT);
  runTimers();
  assert.match(byClass(root, "ghost")[0].textContent, /Not confirmed/);

  push(session({ cards: [card("c1", "went-well", "very slow")] }));
  assert.equal(byClass(root, "ghost").length, 0);
  assert.equal(byClass(root, "note").length, 1);
  assert.equal(sent().length, 1);
});

test("Send again is one more send, and the first landing settles the note", () => {
  const { root, push, runTimers, sent } = load();
  push(session({}));
  composer(root, "Went well").type("once");
  composer(root, "Went well").fire("keydown", ENTER);
  runTimers(WAIT);
  button(byClass(root, "ghost")[0], "Send again").click();
  assert.equal(sent().length, 2);

  push(session({ cards: [card("c1", "went-well", "once")] }));
  assert.equal(byClass(root, "ghost").length, 0, "whichever send it was, the note is on the board");
  runTimers(WAIT);
  assert.equal(sent().length, 2, "nothing further is sent");
});

test("Send again on a note that reached the board after all sends nothing", async () => {
  const { root, push, bridge, sent } = load({ host: "new" });
  push(session({}));
  bridge.fail = "reject";
  composer(root, "Went well").type("once");
  composer(root, "Went well").fire("keydown", ENTER);
  await settled();
  assert.match(byClass(root, "ghost")[0].textContent, /Not saved/);
  assert.equal(sent().length, 1);

  // The send got through even though its answer did not.
  bridge.fail = null;
  push(session({ cards: [card("c1", "went-well", "once")] }));
  assert.equal(byClass(root, "ghost").length, 1, "a refused note is the writer's to resolve");
  button(byClass(root, "ghost")[0], "Send again").click();
  assert.equal(byClass(root, "ghost").length, 0);
  assert.equal(sent().length, 1, "the note is on the board, so it is not sent a second time");
});

test("a note the host accepted stays in sight until the state shows it", async () => {
  const { root, push, acts, runTimers } = load({ host: "new" });
  push(session({}));
  composer(root, "Went well").type("accepted");
  composer(root, "Went well").fire("keydown", ENTER);
  acts[0].answer({ ok: true });
  await settled();
  assert.match(byClass(root, "ghost")[0].textContent, /Saving/, "a yes is not the note: it waits for the state");
  runTimers(WAIT);
  // A host that cannot say no says yes to a note the board declined, so a
  // yes the state has not borne out by now is called unconfirmed.
  assert.match(byClass(root, "ghost")[0].textContent, /accepted/);
  assert.match(byClass(root, "ghost")[0].textContent, /Not confirmed yet\./);
  assert.match(toastOf(root).textContent, /Could not confirm that your note was saved\./);

  push(session({ cards: [card("c1", "went-well", "accepted")] }));
  assert.equal(byClass(root, "ghost").length, 0);
  assert.equal(toastOf(root).hidden, true, "and the doubt is taken back when the state shows it");
  assert.equal(byClass(root, "note").length, 1);
});

test("a note waiting for a lane that is removed is reported, not left stuck", () => {
  const { root, push, sent } = load();
  push(session({}));
  composer(root, "Puzzles").type("orphan");
  composer(root, "Puzzles").fire("keydown", ENTER);
  push(session({ columns: columns.slice(0, 2) }));
  assert.equal(byClass(root, "ghost").length, 0);
  assert.match(toastOf(root).textContent, /lane is gone.*orphan/);

  composer(root, "Went well").type("next");
  composer(root, "Went well").fire("keydown", ENTER);
  assert.equal(sent().length, 2, "the queue moves on");
});

test("a yes that arrives after the wait still marks the vote as the viewer's", async () => {
  const { root, push, acts, runTimers } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one", { voteCount: 1 })] }));
  const vote = button(noteWith(root, "one"), "Vote");
  vote.click();
  runTimers(WAIT);
  assert.equal(toastOf(root).hidden, false);
  acts[0].answer({ ok: true });
  await settled();
  assert.equal(vote.getAttribute("aria-pressed"), "true");
  assert.equal(toastOf(root).hidden, true, "the doubt is taken back");
});

test("a theme sent again re-schemes the board without rebuilding it", () => {
  const old = load();
  old.push(session({ cards: [card("c1", "went-well", "one")] }));
  const html = old.document.documentElement;
  const box = composer(old.root, "Went well");
  box.type("still here");
  old.bridge.tokens({ surface: "#162032" });
  assert.equal(html.getAttribute("data-scheme"), "dark");
  old.bridge.tokens({ surface: "#F7F6F2" });
  assert.equal(html.getAttribute("data-scheme"), "light");
  same(composer(old.root, "Went well"), box, "the composer is the same node");
  assert.equal(box.value, "still here");

  // A host that names the scheme is believed over the color.
  const named = load({ host: "new" });
  named.push(session({}));
  named.bridge.scheme = "dark";
  named.bridge.tokens({ surface: "#F7F6F2" });
  assert.equal(named.document.documentElement.getAttribute("data-scheme"), "dark");
  named.bridge.scheme = "light";
  named.bridge.tokens({ surface: "#F7F6F2" });
  assert.equal(named.document.documentElement.getAttribute("data-scheme"), "light");
});

test("the fake document refuses what a real one refuses", () => {
  const { document } = load();
  const a = document.createElement("div");
  const b = document.createElement("div");
  a.appendChild(b);
  assert.throws(() => b.appendChild(a), /HierarchyRequestError/);
  assert.throws(() => a.appendChild(a), /HierarchyRequestError/);
  assert.throws(() => b.removeChild(a), /NotFoundError/);
  assert.throws(() => a.insertBefore(document.createElement("p"), document.createElement("p")), /NotFoundError/);
});

// A failed assertion that is handed a node makes the runner describe it, and
// through ownerDocument a node reaches every other node. Nodes therefore print
// as a tag, and identity is asserted with same().
test("a fake node prints as its tag, not as the document it belongs to", () => {
  const { root } = load();
  const text = inspect(root);
  assert.ok(text.length < 200, "a node printed " + text.length + " characters");
  assert.match(text, /^<[a-z]+/);
});

// ---- stages

const three = [card("c1", "went-well", "one"), card("c2", "went-well", "two"), card("c3", "went-well", "three")];
const shownHint = (root) => byClass(root, "hint").filter((h) => h.className.includes("shown"));

test("the strip shows the stage the facilitator set, not one guessed from the board", () => {
  const { root, push } = load();
  // Votes, a group and an action are all on the board; the stage is still Write.
  push(
    session({
      cards: [card("c1", "went-well", "one", { voteCount: 3, groupId: "g1" })],
      groups: [{ id: "g1", columnId: "went-well", title: "G" }],
      actionItems: [{ id: "a1", text: "x", owner: "u-bo" }],
    }),
  );
  assert.match(one(root, "current").textContent, /Write, current/);
  assert.equal(shownHint(root).length, 1);
  assert.match(shownHint(root)[0].textContent, /^Write what went well/);

  push(session({ stage: 2 }));
  assert.match(one(root, "current").textContent, /Vote, current/);
  assert.equal(byClass(root, "reached").length, 2);
  assert.match(shownHint(root)[0].textContent, /^Vote for the notes that matter most/);
  assert.equal(byClass(root, "hint").length, 4, "every hint stays in the strip, so its height never changes");
});

test("only the facilitator is offered the stage buttons, and they name where they go", async () => {
  const lead = load({ host: "new" });
  lead.push(session({ stage: 1 }, FACILITATOR));
  assert.ok(button(lead.root, "Move to Vote"));
  button(lead.root, "Back to Write").click();
  assert.deepEqual(lead.sent(), [{ action: "set-stage", payload: { stage: 0 } }]);
  lead.push(session({ stage: 0 }, FACILITATOR));
  assert.ok(!button(lead.root, "Back to"), "there is nothing before Write");
  lead.push(session({ stage: 3 }, FACILITATOR));
  assert.ok(!button(lead.root, "Move to"), "there is nothing after Decide");
  assert.ok(button(lead.root, "Back to Vote"));

  const member = load({ host: "new" });
  member.push(session({ stage: 1 }, PARTICIPANT));
  assert.ok(!button(member.root, "Move to"));
  assert.ok(!button(member.root, "Back to"));

  // A host that does not say who is looking: the buttons are offered and the server decides.
  const unknown = load({ host: "new" });
  unknown.push(session({ stage: 1 }));
  button(unknown.root, "Move to Vote").click();
  unknown.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.match(toastOf(unknown.root).textContent, /Only the facilitator, Alice Ng, can change the stage/);
});

test("a stage change is announced once, with who moved the room and what to do now", () => {
  const { root, push } = load({ host: "new" });
  push(session({ stage: 1 }, PARTICIPANT));
  push(session({ stage: 2 }, PARTICIPANT));
  assert.equal(liveOf(root), "Alice Ng moved the room to Vote. Vote for the notes that matter most. One vote per person per note.");
  push(session({ stage: 2 }, PARTICIPANT));
  assert.equal(liveOf(root), "", "the same state again says nothing");
  push(session({ stage: 1 }, PARTICIPANT));
  assert.equal(liveOf(root), "Alice Ng moved the room back to Group.");
});

test("each stage puts one control in front of a note and keeps the rest in its menu", () => {
  const { root, push } = load();
  const shown = (name) => visible(one(noteWith(root, "one"), name));
  const cards = [card("c1", "went-well", "one")];
  push(session({ stage: 0, cards }));
  assert.deepEqual([shown("grip"), shown("pick"), shown("more"), shown("vote"), shown("target")], [true, false, false, false, false]);
  push(session({ stage: 1, cards }));
  assert.deepEqual([shown("grip"), shown("pick"), shown("more"), shown("vote"), shown("target")], [false, true, true, false, false]);
  push(session({ stage: 2, cards }));
  assert.deepEqual([shown("grip"), shown("pick"), shown("more"), shown("vote"), shown("target")], [true, false, false, true, false]);
  push(session({ stage: 3, cards }));
  assert.deepEqual([shown("grip"), shown("pick"), shown("more"), shown("vote"), shown("target")], [true, false, false, false, true]);
  // A vote already cast stays in sight in every stage.
  push(session({ stage: 0, cards: [card("c1", "went-well", "one", { voteCount: 2 })] }));
  assert.equal(shown("vote"), true);
});

test("the stage focuses the board and blocks nothing: a late note and a late vote are still sent", () => {
  const { root, push, sent } = load();
  push(session({ stage: 3, cards: [card("c1", "went-well", "one")] }));
  const box = composer(root, "Went well");
  assert.equal(visible(box), false, "past Write an idle composer steps back");
  button(lane(root, "Went well"), "Add a note").click();
  assert.equal(visible(box), true);
  box.type("a late thought");
  box.fire("keydown", ENTER);

  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Vote for this note").click();
  assert.deepEqual(sent(), [
    { action: "add-card", payload: { columnId: "went-well", text: "a late thought" } },
    { action: "vote", payload: { cardId: "c1" } },
  ]);
});

test("focus follows the control when a stage change swaps it for another", () => {
  const { root, document, push } = load();
  const cards = [card("c1", "went-well", "one")];
  push(session({ stage: 0, cards }));
  const note = noteWith(root, "one");
  one(note, "grip").focus();
  push(session({ stage: 1, cards }));
  same(document.activeElement, one(note, "more"), "the menu moved to the end of the note, and focus with it");
  push(session({ stage: 2, cards }));
  same(document.activeElement, one(note, "grip"), "and back");
  one(note, "vote").focus();
  push(session({ stage: 3, cards }));
  same(document.activeElement, one(note, "grip"), "a control that went away hands focus to the note's handle");
});

// ---- the menu

test("a menu is walked with the arrow keys and a typed letter, and Escape hands focus back", () => {
  const { root, document, push, press } = load();
  push(session({ cards: three }));
  const grip = one(noteWith(root, "two"), "grip");
  grip.click();
  const menu = one(root, "menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(grip.getAttribute("aria-expanded"), "true");
  same(document.activeElement, menuItem(root, "Vote for this note"), "the first item has focus");
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Add a stamp"), "down");
  menu.fire("keydown", { key: "End" });
  same(document.activeElement, menuItem(root, "Delete note"), "end");
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Vote for this note"), "and round again");
  menu.fire("keydown", { key: "s" });
  same(document.activeElement, menuItem(root, "Start an action"), "a letter goes to the next item that starts with it");
  menu.fire("keydown", { key: "s" });
  same(document.activeElement, menuItem(root, "Select to group"), "and then the one after");

  press("Escape");
  assert.equal(byClass(root, "menu").length, 0);
  same(document.activeElement, grip, "focus is back where the menu was opened");
  assert.equal(grip.getAttribute("aria-expanded"), "false");
});

// ---- the shared order

test("a note is moved from its menu, for everyone, and is already there before the server answers", () => {
  const { root, push, sent } = load();
  push(session({ cards: three }));
  assert.equal(noteOrder(root, "Went well"), "one two three");
  one(noteWith(root, "three"), "grip").click();
  menuItem(root, "Move up").click();
  assert.deepEqual(sent(), [{ action: "move-card", payload: { cardId: "c3", beforeId: "c2" } }]);
  assert.equal(noteOrder(root, "Went well"), "one three two");
  assert.equal(liveOf(root), "Moved up. Position 2 of 3 in Went well.");

  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Move to Puzzles").click();
  assert.deepEqual(sent()[1], { action: "move-card", payload: { cardId: "c1", columnId: "puzzles" } });
  assert.equal(noteOrder(root, "Puzzles"), "one");
  assert.equal(noteOrder(root, "Went well"), "three two");
});

test("Alt and the arrow keys move a note without a pointer, and keep focus on it", () => {
  const { root, document, push, sent } = load();
  push(session({ cards: three }));
  const note = noteWith(root, "one");
  const grip = one(note, "grip");
  grip.focus();
  note.fire("keydown", { key: "ArrowDown", altKey: true });
  assert.equal(noteOrder(root, "Went well"), "two one three");
  same(document.activeElement, grip, "focus stays on the note that moved");
  note.fire("keydown", { key: "ArrowDown", altKey: true, shiftKey: true });
  assert.equal(noteOrder(root, "Went well"), "two three one");
  assert.deepEqual(
    sent().map((a) => a.payload),
    [{ cardId: "c1", beforeId: "c3" }, { cardId: "c1" }],
  );
  note.fire("keydown", { key: "ArrowDown", altKey: true });
  assert.equal(sent().length, 2, "a note at the bottom is not sent anywhere");
  assert.equal(liveOf(root), "Already at the bottom.");
  note.fire("keydown", { key: "ArrowDown" });
  assert.equal(sent().length, 2, "an arrow key on its own moves nothing");
});

test("a move the server refuses is taken back", async () => {
  const { root, push, acts } = load({ host: "new" });
  push(session({ cards: three }));
  noteWith(root, "three").fire("keydown", { key: "ArrowUp", altKey: true, shiftKey: true });
  assert.equal(noteOrder(root, "Went well"), "three one two");
  acts[0].answer({ ok: false, reason: "rate-limited" });
  await settled();
  assert.equal(noteOrder(root, "Went well"), "one two three");
  assert.match(toastOf(root).textContent, /Too many changes/);
});

test("a group stands where its first note is, and moves as one from its own menu", () => {
  const { root, push, sent } = load();
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two", { groupId: "g1" }), card("c3", "went-well", "three"), card("c4", "went-well", "four", { groupId: "g1" })];
  push(session({ cards, groups: [{ id: "g1", columnId: "went-well", title: "Pair" }] }));
  assert.equal(noteOrder(root, "Went well"), "one two four three", "the group is second, not pinned to the top");
  labeled(root, "Options for group: Pair").click();
  menuItem(root, "Move group up").click();
  assert.deepEqual(sent(), [{ action: "move-group", payload: { groupId: "g1", beforeId: "c1" } }]);
  assert.equal(noteOrder(root, "Went well"), "two four one three");
  assert.equal(liveOf(root), "Group Pair moved to position 1 of 3 items in Went well.");

  // Inside the group a note moves among the group's notes.
  noteWith(root, "four").fire("keydown", { key: "ArrowUp", altKey: true });
  assert.deepEqual(sent()[1], { action: "move-card", payload: { cardId: "c4", beforeId: "c2" } });
  assert.equal(noteOrder(root, "Went well"), "four two one three");
});

test("a teammate's reorder is announced, and typing through it loses nothing", () => {
  const { root, document, push } = load();
  push(session({ cards: three }));
  const box = composer(root, "Went well");
  box.focus();
  box.type("still typing");
  push(session({ cards: [three[2], three[0], three[1]], stamps: [{ id: "s1", cardId: "c1", kind: "idea", x: 0.5, y: 0.5, rot: 3 }] }));
  assert.equal(noteOrder(root, "Went well"), "three one two");
  assert.equal(liveOf(root), "Notes were reordered in Went well. Great idea stamp pressed on: one. 1 stamp on that note.");
  assert.equal(box.value, "still typing");
  same(document.activeElement, box, "focus stays in the composer");
});

// ---- most votes, for one reader

const voted = [card("c1", "went-well", "one"), card("c2", "went-well", "two", { voteCount: 2 }), card("c3", "went-well", "three", { voteCount: 1 })];

test("Most votes re-sorts a lane for one reader and sends nothing", () => {
  const { root, push, sent } = load();
  push(session({ cards: three }));
  assert.ok(!button(lane(root, "Went well"), "Votes"), "nothing to rank by yet");
  push(session({ cards: voted }));
  assert.ok(!button(lane(root, "Puzzles"), "Votes"), "an empty lane has nothing to sort");
  const toggle = button(lane(root, "Went well"), "Votes");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(noteOrder(root, "Went well"), "two three one");
  assert.match(lane(root, "Went well").textContent, /Sorted by votes, only for you\./);
  assert.deepEqual(sent(), []);

  // New votes change the counts at once and the places only when asked.
  assert.ok(!button(root, "Re-sort"));
  push(session({ cards: [card("c1", "went-well", "one", { voteCount: 5 }), voted[1], voted[2]] }));
  assert.equal(noteOrder(root, "Went well"), "two three one", "nothing jumps under the reader");
  button(root, "Re-sort").click();
  assert.equal(noteOrder(root, "Went well"), "one two three");

  button(root, "Show shared order").click();
  assert.equal(noteOrder(root, "Went well"), "one two three");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(sent(), []);
});

test("a sorted lane cannot be reordered, and says why", () => {
  const { root, push, sent } = load();
  push(session({ cards: voted }));
  button(lane(root, "Went well"), "Votes").click();
  noteWith(root, "one").fire("keydown", { key: "ArrowUp", altKey: true });
  assert.match(toastOf(root).textContent, /Sorted by votes\. Show shared order to move notes here\./);
  one(noteWith(root, "one"), "grip").click();
  assert.equal(menuItem(root, "Move up").getAttribute("aria-disabled"), "true");
  menuItem(root, "Move up").click();
  assert.deepEqual(sent(), []);
  assert.equal(noteOrder(root, "Went well"), "two three one");
});

test("the facilitator can make the vote order everyone's; a participant is not offered it", () => {
  const lead = load({ host: "new" });
  lead.push(session({ cards: voted }, FACILITATOR));
  button(lane(lead.root, "Went well"), "Votes").click();
  button(lead.root, "Use this order for everyone").click();
  assert.deepEqual(lead.sent(), [{ action: "order-by-votes", payload: { columnId: "went-well" } }]);
  lead.push(session({ cards: [voted[1], voted[2], voted[0]] }, FACILITATOR));
  assert.equal(button(lane(lead.root, "Went well"), "Votes").getAttribute("aria-pressed"), "false", "the lens is off: the shared order is now the sorted one");
  assert.equal(noteOrder(lead.root, "Went well"), "two three one");

  const member = load({ host: "new" });
  member.push(session({ cards: voted }, PARTICIPANT));
  button(lane(member.root, "Went well"), "Votes").click();
  assert.ok(!button(member.root, "Use this order for everyone"));
});

// ---- stamps

const stampsOf = (root, text) => byClass(noteWith(root, text), "stamp");
const leftOf = (node) => Math.round(parseFloat(node.style.left) * 10) / 10;

const TOP = "calc(0 * (100% - 10px) - 6px)";

test("a stamp is pressed from the note's menu, lands under focus, and is moved and removed by key", () => {
  const { root, document, push, sent, runTimers } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  push(session({ cards }, PARTICIPANT));
  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Add a stamp").click();
  assert.equal(one(root, "sheet").getAttribute("aria-label"), "Stamps for: one");
  assert.equal(byClass(root, "stamp-choice").length, 7);
  button(root, "Quick win").click();

  const { rot, ...where } = sent()[0].payload;
  const bare = noteWith(root, "one").className;
  assert.equal(sent()[0].action, "stamp");
  // The note cannot be measured here, so it is taken to be 240 by 44. The
  // default spot hangs off the top-left corner: 6 in from the left, 6/240,
  // and at the very top of the stamp's travel, which is drawn 6 above the edge.
  assert.deepEqual(where, { cardId: "c1", kind: "quick-win", x: 0.025, y: 0 });
  assert.ok(Math.abs(rot) <= 9, "the tilt is a small one");

  push(session({ cards, stamps: [{ id: "s1", ...where, rot }] }, PARTICIPANT));
  const stamp = stampsOf(root, "one")[0];
  assert.equal(stamp.getAttribute("aria-label"), "Quick win stamp, 1 of 1 on this note");
  assert.equal(stamp.style.left, "2.5%");
  assert.equal(stamp.style.top, TOP);
  // The room a stamp hangs into is the gap every note already has: the note
  // is given no class and no style of its own for having one.
  assert.equal(noteWith(root, "one").className, bare, "a first stamp changes nothing about its note");
  assert.equal(noteWith(root, "one").style.marginTop, undefined);
  assert.doesNotMatch(src, /\.stamped/);
  assert.ok(!stamp.className.includes("fixed"), "a stamp this viewer pressed looks movable");
  same(document.activeElement, stamp, "the stamp just pressed has focus, ready for the keys");

  stamp.fire("keydown", { key: "ArrowRight", shiftKey: true });
  stamp.fire("keydown", { key: "ArrowRight", shiftKey: true });
  // One step is 6 of the note's 240: 0.025 + 0.025 + 0.025.
  assert.equal(leftOf(stamp), 7.5, "it moves at once");
  assert.equal(sent().length, 1, "and is not sent until the keys rest");
  runTimers(500);
  assert.deepEqual(sent()[1], { action: "move-stamp", payload: { stampId: "s1", x: 0.075, y: 0 } });
  assert.equal(liveOf(root), "Quick win stamp moved.");

  stamp.fire("keydown", { key: "ArrowUp", shiftKey: true });
  assert.equal(liveOf(root), "At the edge of the note.");
  runTimers(500);
  assert.equal(sent().length, 2, "a move that goes nowhere is not sent");

  stamp.fire("keydown", { key: "Delete" });
  assert.deepEqual(sent()[2], { action: "remove-stamp", payload: { stampId: "s1" } });
  push(session({ cards }, PARTICIPANT));
  assert.equal(stampsOf(root, "one").length, 0);
  assert.equal(noteWith(root, "one").className, bare);
  same(document.activeElement, one(noteWith(root, "one"), "grip"), "focus falls back to the note");
});

test("each of the twelve stamps a note holds lands on a spot of its own, along the top edge", () => {
  const { root, push, sent } = load();
  const cards = [card("c1", "went-well", "one")];
  const stamps = [];
  push(session({ cards }));
  for (let i = 0; i < 12; i++) {
    one(noteWith(root, "one"), "grip").click();
    menuItem(root, "Add a stamp").click();
    button(root, "Blocker").click();
    const { x, y } = sent()[i].payload;
    stamps.push({ id: "s" + i, cardId: "c1", kind: "blocker", x, y, rot: 0 });
    push(session({ cards, stamps }));
  }
  // On a note 240 wide the row runs from 6 to 188, where the note's menu
  // begins, in steps of 26: 6, 32, 58, 84, 110, 136, 162, 188. The next four
  // go halfway between those: 19, 45, 71, 97.
  assert.deepEqual(
    stamps.map((s) => s.x),
    [0.025, 0.133, 0.242, 0.35, 0.458, 0.567, 0.675, 0.783, 0.079, 0.188, 0.296, 0.404],
  );
  assert.ok(stamps.every((s) => s.y === 0), "none of them is put lower, where the words are");
});

test("a stamp pressed before the last one has landed does not take its spot", () => {
  const { root, push, sent } = load();
  push(session({ cards: [card("c1", "went-well", "one")] }));
  for (const kind of ["Blocker", "Quick win"]) {
    one(noteWith(root, "one"), "grip").click();
    menuItem(root, "Add a stamp").click();
    button(root, kind).click();
  }
  assert.deepEqual(sent().map((a) => a.payload.x), [0.025, 0.133]);
});

test("a stamp is announced by what it is and how many there are, never by who", () => {
  const { root, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one", { authorId: "u-cy" })];
  const s = (id, kind) => ({ id, cardId: "c1", kind, x: 0.5, y: 0.5, rot: 0 });
  push(session({ revealed: true, cards }, PARTICIPANT));
  push(session({ revealed: true, cards, stamps: [s("s1", "blocker")] }, PARTICIPANT));
  assert.equal(liveOf(root), "Blocker stamp pressed on: one. 1 stamp on that note.");
  push(session({ revealed: true, cards, stamps: [s("s1", "blocker"), s("s2", "thanks")] }, PARTICIPANT));
  assert.equal(liveOf(root), "Thank you stamp pressed on: one. 2 stamps on that note.");
  assert.equal(stampsOf(root, "one")[1].getAttribute("aria-label"), "Thank you stamp, 2 of 2 on this note");
  push(session({ revealed: true, cards, stamps: [s("s2", "thanks")] }, PARTICIPANT));
  assert.equal(liveOf(root), "Blocker stamp removed from: one. 1 stamp on that note.");
  for (const stamp of stampsOf(root, "one")) assert.doesNotMatch(stamp.getAttribute("aria-label"), /Alice|Reyes|Park|yours|mine/i);
});

const others = { cards: [card("c1", "went-well", "one")], stamps: [{ id: "s9", cardId: "c1", kind: "chat", x: 0.5, y: 0.5, rot: 0 }] };

test("a stamp not known to be the viewer's does not look movable, and says why when it is tried", () => {
  const { root, push, sent, runTimers, fireWindow } = load({ host: "new" });
  push(session(others, PARTICIPANT));
  const stamp = stampsOf(root, "one")[0];
  assert.ok(stamp.className.split(" ").includes("fixed"), "no grab cursor");

  stamp.fire("keydown", { key: "ArrowLeft", shiftKey: true });
  runTimers(500);
  assert.equal(leftOf(stamp), 50);
  assert.equal(toastOf(root).textContent, "You can move a stamp you pressed in this visit. Open an older one of yours to remove it.");

  stamp.fire("pointerdown", { clientX: 100, clientY: 100 });
  fireWindow("pointermove", { clientX: 140, clientY: 100 });
  fireWindow("pointerup", { clientX: 140, clientY: 100 });
  assert.equal(leftOf(stamp), 50, "a drag does not carry it");
  assert.deepEqual(sent(), [], "and nothing is asked of the server");

  // The click that ends a drag is swallowed; the next one is a click.
  runTimers(0);
  stamp.click();
  assert.deepEqual(all(root, (n) => n.getAttribute("role") === "menuitem").map((n) => n.children[0].textContent), ["Remove, if you pressed it"]);
});

test("removing a stamp is the server's to refuse, once: the answer is remembered", async () => {
  const { root, push, acts } = load({ host: "new" });
  push(session(others, PARTICIPANT));
  const stamp = stampsOf(root, "one")[0];
  stamp.click();
  menuItem(root, "Remove, if you pressed it").click();
  assert.deepEqual(acts.map((a) => a.action), ["remove-stamp"], "after a reload the board does not know whose it is; the server does");
  acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(root).textContent, "Only the person who pressed a stamp, or the facilitator, can move or remove it.");

  stamp.fire("keydown", { key: "Delete" });
  stamp.click();
  assert.equal(menuItem(root, "Remove, if you pressed it").getAttribute("aria-disabled"), "true");
  menuItem(root, "Remove, if you pressed it").click();
  assert.equal(acts.length, 1, "it is not asked again");
});

test("the facilitator moves and removes any stamp, through the action kept for the facilitator", () => {
  const { root, push, sent, runTimers } = load({ host: "new" });
  push(session(others, FACILITATOR));
  const stamp = stampsOf(root, "one")[0];
  assert.ok(!stamp.className.includes("fixed"));
  stamp.fire("keydown", { key: "ArrowDown", shiftKey: true });
  runTimers(500);
  // One step is 6 of the 34 a stamp can travel down a note 44 high: 0.5 + 6/34 = 0.676.
  assert.deepEqual(sent()[0], { action: "moderate-stamp", payload: { stampId: "s9", x: 0.5, y: 0.676 } });
  stamp.click();
  menuItem(root, "Remove stamp").click();
  assert.deepEqual(sent()[1], { action: "moderate-stamp", payload: { stampId: "s9", remove: true } });
});

test("a note's stamps are one Tab stop, and the arrow keys go between them", () => {
  const { root, document, push, sent } = load({ host: "new" });
  const stamps = ["idea", "laugh", "chat"].map((kind, i) => ({ id: "s" + i, cardId: "c1", kind, x: 0.1 * i, y: 0, rot: 0 }));
  push(session({ cards: [card("c1", "went-well", "one")], stamps }, PARTICIPANT));
  const [first, second, third] = stampsOf(root, "one");
  const stops = () => stampsOf(root, "one").map((n) => n.getAttribute("tabindex")).join(" ");
  assert.equal(stops(), "0 -1 -1");
  first.focus();
  first.fire("keydown", { key: "ArrowRight" });
  same(document.activeElement, second, "right goes to the next stamp");
  second.fire("focus");
  assert.equal(stops(), "-1 0 -1", "and Tab comes back to the one that was left");
  second.fire("keydown", { key: "ArrowLeft" });
  first.fire("keydown", { key: "ArrowLeft" });
  same(document.activeElement, third, "and round");
  assert.deepEqual(sent(), [], "going between stamps moves none of them");
});

test("every stamp on a note can be reached from the note's menu, without aiming at it", () => {
  const { root, document, push, sent } = load({ host: "new" });
  const stamps = [
    { id: "s1", cardId: "c1", kind: "idea", x: 0.5, y: 0.5, rot: 0 },
    { id: "s2", cardId: "c1", kind: "laugh", x: 0.5, y: 0.5, rot: 0 },
  ];
  push(session({ cards: [card("c1", "went-well", "one")], stamps }, FACILITATOR));
  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Stamps on this note (2)").click();
  labeled(root, "Move Made me laugh stamp, 2 of 2").click();
  same(document.activeElement, stampsOf(root, "one")[1], "Move puts focus on that stamp, for the keys");
  assert.match(liveOf(root), /Shift with an arrow key moves this one\. Delete removes it\./);

  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Stamps on this note (2)").click();
  labeled(root, "Remove Great idea stamp, 1 of 2").click();
  assert.deepEqual(sent(), [{ action: "moderate-stamp", payload: { stampId: "s1", remove: true } }]);

  const member = load({ host: "new" });
  member.push(session({ cards: [card("c1", "went-well", "one")], stamps }, PARTICIPANT));
  one(noteWith(member.root, "one"), "grip").click();
  menuItem(member.root, "Stamps on this note (2)").click();
  assert.ok(!labeled(member.root, "Move Made me laugh stamp"), "Move is not offered for a stamp that may be somebody else's");
  assert.ok(labeled(member.root, "Remove Made me laugh stamp, 2 of 2"));
  assert.match(one(member.root, "sheet").textContent, /You can move a stamp you pressed in this visit, and remove any that is yours\./);
});

test("a stamp nobody can place is not drawn, and one off the note is brought back onto it", () => {
  const { root, push } = load();
  push(
    session({
      cards: [card("c1", "went-well", "one")],
      stamps: [
        { id: "s1", cardId: "c1", kind: "<img>", x: 0.5, y: 0.5 },
        { id: "s2", cardId: "c1", kind: "idea", x: 7, y: -3, rot: "x" },
        { id: "s3", cardId: "c404", kind: "idea", x: 0.5, y: 0.5 },
        null,
      ],
    }),
  );
  const drawn = byClass(root, "stamp");
  assert.equal(drawn.length, 1);
  assert.deepEqual([drawn[0].style.left, drawn[0].style.top], ["100%", TOP]);
});

// ---- hiding authors again

test("the facilitator hides authors again in one press, and the names leave the board", () => {
  const cards = [card("c1", "went-well", "one", { authorId: "u-cy" })];
  const hidden = [card("c1", "went-well", "one")];
  const names = (root) => all(root, visible).map((n) => n.text).join("\n");

  const lead = load({ host: "new" });
  lead.push(session({ revealed: true, cards }, FACILITATOR));
  assert.match(names(lead.root), /Cy Park/);
  button(lead.root, "Hide authors again").click();
  assert.deepEqual(lead.sent(), [{ action: "conceal", payload: {} }], "hiding asks for no confirmation");
  lead.push(session({ revealed: false, cards: hidden }, FACILITATOR));
  assert.doesNotMatch(names(lead.root), /Cy Park/);
  assert.ok(button(lead.root, "Reveal authors"));
  assert.match(liveOf(lead.root), /Authors are hidden again\./);

  const member = load({ host: "new" });
  member.push(session({ revealed: true, cards }, PARTICIPANT));
  assert.ok(!button(member.root, "Hide authors again"));
  assert.match(one(member.root, "authorship").textContent, /Everyone can see who wrote each note\./);
  member.push(session({ revealed: false, cards: hidden }, PARTICIPANT));
  assert.doesNotMatch(names(member.root), /Cy Park/);
  assert.match(one(member.root, "authorship").textContent, /Notes are anonymous again\. Alice Ng, the facilitator, can reveal them\./);
});

// ---- notes and the actions that came from them

test("an action is started from a note, and the link shows on both of them", () => {
  const { root, document, push, sent } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one"), card("c2", "to-improve", "two")];
  push(session({ stage: 3, cards }, FACILITATOR));
  const target = one(noteWith(root, "one"), "target");
  assert.equal(target.getAttribute("aria-label"), "Start an action from: one");
  target.click();
  const sheet = one(root, "sheet");
  assert.equal(sheet.getAttribute("aria-label"), "Actions from note: one");
  const text = all(sheet, (n) => n.getAttribute("id") === "link-text")[0];
  same(document.activeElement, text, "focus is in the action field");
  assert.equal(text.value, "", "an action is a decision, not the note said again");
  text.type("fix it");
  text.fire("keydown", ENTER);
  assert.deepEqual(sent(), [{ action: "add-action", payload: { text: "fix it", owner: "", sourceIds: ["c1"] } }]);

  const actionItems = [{ id: "a1", text: "fix it", owner: "u-alice", sourceIds: ["c1"] }];
  push(session({ stage: 3, cards, actionItems }, FACILITATOR));
  assert.equal(byClass(root, "sheet").length, 0, "the form closes when the action lands");
  same(document.activeElement, target, "and focus is back on the note's target");
  assert.equal(target.getAttribute("aria-label"), "1 action from: one. Open.");

  const chip = one(one(root, "action"), "src");
  assert.equal(chip.getAttribute("aria-label"), "From note: one. Go to note.");
  chip.click();
  same(document.activeElement, one(noteWith(root, "one"), "grip"), "the chip goes to its note");
  assert.ok(noteWith(root, "one").className.includes("spot"));

  // A second note is tied to the same action.
  one(noteWith(root, "two"), "target").click();
  labeled(root, "Link to action: fix it").click();
  assert.deepEqual(sent()[1], { action: "link-action", payload: { actionId: "a1", sourceId: "c2", linked: true } });
  push(session({ stage: 3, cards, actionItems: [{ ...actionItems[0], sourceIds: ["c1", "c2"] }] }, FACILITATOR));
  labeled(root, "Remove the link to action: fix it").click();
  assert.deepEqual(sent()[2], { action: "link-action", payload: { actionId: "a1", sourceId: "c2", linked: false } });
});

test("a linked note shows its target in every stage, and an action lists three sources, or two and the rest", () => {
  const { root, push } = load();
  const cards = ["one", "two", "three", "four", "five"].map((t, i) => card("c" + (i + 1), "went-well", t));
  const item = (sourceIds) => [{ id: "a1", text: "x", owner: "u-bo", sourceIds }];
  push(session({ stage: 0, cards, actionItems: item(["c1", "c2", "c3", "c404"]) }));
  assert.equal(visible(one(noteWith(root, "one"), "target")), true);
  assert.equal(visible(one(noteWith(root, "four"), "target")), false, "an unlinked note keeps its target for Decide");
  const chips = () => byClass(one(root, "action"), "src").map((c) => c.textContent);
  assert.deepEqual(chips(), ["one", "two", "three"], "a source that is gone is not counted, and a chip is never spent hiding one chip");
  push(session({ stage: 0, cards, actionItems: item(["c1", "c2", "c3", "c4"]) }));
  assert.deepEqual(chips(), ["one", "two", "+2 more"]);
  button(one(root, "action"), "+2 more").click();
  assert.deepEqual(chips(), ["one", "two", "three", "four"]);
});

test("the action form steps back outside Decide and still takes an action", () => {
  const { root, push, sent } = load();
  push(session({ stage: 0 }));
  const text = all(root, (n) => n.getAttribute("id") === "action-text")[0];
  assert.equal(visible(text), false);
  button(one(root, "actions"), "Add an action").click();
  assert.equal(visible(text), true);
  text.type("early decision");
  text.fire("keydown", ENTER);
  assert.deepEqual(sent(), [{ action: "add-action", payload: { text: "early decision", owner: "" } }]);
  push(session({ stage: 3 }));
  assert.equal(visible(text), true, "in Decide it is simply open");
});

// ---- the timer

const timer = (rev, mode, remainingMs, durationMs = 300_000) => ({ rev, mode, durationMs, remainingMs });
const face = (root) => one(root, "timer-text").textContent;

test("the countdown runs on the frame's clock from the time the server said was left", () => {
  const { root, push, clock, runTimers } = load({ host: "new" });
  clock.t = 1000;
  push(session({ timer: timer(1, "running", 65_000) }, PARTICIPANT));
  assert.equal(face(root), "1:05");
  assert.ok(!button(root, "Timer"), "a participant sees the time and no controls");

  clock.t = 7000;
  runTimers(250);
  assert.equal(face(root), "0:59");

  // A teammate's vote brings a state stamped a moment earlier. Same timer, so the countdown does not move.
  push(session({ timer: timer(1, "running", 64_000) }, PARTICIPANT));
  assert.equal(face(root), "0:59");

  push(session({ timer: timer(2, "paused", 59_000) }, PARTICIPANT));
  clock.t = 500_000;
  runTimers(250);
  assert.equal(face(root), "Paused 0:59", "a paused timer does not count");

  push(session({ timer: timer(3, "running", 119_000) }, PARTICIPANT));
  assert.equal(face(root), "1:59", "a changed timer is read again");
  push(session({}, PARTICIPANT));
  assert.equal(visible(one(root, "timer-face")), false);
});

test("the timer speaks three times and is otherwise silent", () => {
  const { root, push, clock, runTimers, sent } = load({ host: "new" });
  push(session({ cards: three }, PARTICIPANT));
  push(session({ cards: three, timer: timer(1, "running", 61_500) }, PARTICIPANT));
  assert.equal(liveOf(root), "Timer started: 1:02.");
  clock.t = 2000;
  runTimers(250);
  assert.equal(liveOf(root), "One minute left.");

  clock.t = 52_000;
  runTimers(250);
  assert.equal(liveOf(root), "10 seconds left.");
  assert.ok(one(root, "timer-face").className.includes("ending"));
  push(session({ cards: three, timer: timer(1, "running", 9_000) }, PARTICIPANT));
  clock.t = 53_000;
  runTimers(250);
  assert.equal(liveOf(root), "", "ten seconds is said once");

  clock.t = 61_500;
  runTimers(250);
  assert.equal(face(root), "Time's up");
  assert.equal(liveOf(root), "Time's up.");
  runTimers(250);
  runTimers(250);
  assert.equal(face(root), "Time's up", "and it stops there");
  // Nothing is blocked when the time is up.
  composer(root, "Went well").type("after the bell");
  composer(root, "Went well").fire("keydown", ENTER);
  assert.equal(sent().length, 1);
});

test("someone who arrives after the bell is not told the time is up, and a short timer has no minute warning", () => {
  const late = load({ host: "new" });
  late.push(session({ timer: timer(4, "running", 0) }, PARTICIPANT));
  assert.equal(face(late.root), "Time's up");
  assert.equal(liveOf(late.root), "");

  const short = load({ host: "new" });
  short.push(session({ timer: timer(1, "running", 90_000, 120_000) }, PARTICIPANT));
  short.clock.t = 31_000;
  short.runTimers(250);
  assert.equal(face(short.root), "0:59");
  assert.equal(liveOf(short.root), "");
});

test("the facilitator starts, pauses, extends and clears the timer", () => {
  const { root, push, sent } = load({ host: "new" });
  push(session({ stage: 2 }, FACILITATOR));
  button(root, "Timer").click();
  assert.equal(one(root, "sheet").getAttribute("aria-label"), "Timer");
  const minutes = all(root, (n) => n.getAttribute("id") === "timer-minutes")[0];
  minutes.type("0");
  button(one(root, "sheet"), "Start").click();
  assert.match(toastOf(root).textContent, /A timer runs from 1 to 180 minutes\./);
  assert.deepEqual(sent(), []);
  minutes.type("7");
  minutes.fire("keydown", ENTER);
  assert.deepEqual(sent()[0], { action: "timer", payload: { op: "start", durationMs: 420_000 } });
  assert.equal(byClass(root, "sheet").length, 0);

  button(root, "Timer").click();
  button(root, "5 min").click();
  assert.deepEqual(sent()[1], { action: "timer", payload: { op: "start", durationMs: 300_000 } });

  push(session({ stage: 2, timer: timer(1, "running", 300_000) }, FACILITATOR));
  for (const [label, op] of [["Pause", "pause"], ["+1 min", "add"], ["Clear", "clear"]]) {
    labeled(root, "Timer controls").click();
    button(one(root, "sheet"), label).click();
    assert.deepEqual(sent().at(-1), { action: "timer", payload: { op } });
  }
  push(session({ stage: 2, timer: timer(2, "paused", 200_000) }, FACILITATOR));
  labeled(root, "Timer controls").click();
  button(one(root, "sheet"), "Resume").click();
  assert.deepEqual(sent().at(-1), { action: "timer", payload: { op: "resume" } });
});

// ---- the pointer: drags followed on the window

const main = (root) => one(root, "board");
const place = (root, texts) => texts.forEach((text, i) => (noteWith(root, text).box = { left: 0, top: 100 + 50 * i, width: 240, height: 40 }));
const inert = (root) => ["top", "main"].map((name) => one(root, name).getAttribute("inert") !== null).join(" ");

// Press a note's handle and carry it to `y`: far enough to count as a drag.
function carry(ui, text, y) {
  place(ui.root, ["one", "two", "three"]);
  one(noteWith(ui.root, text), "grip").fire("pointerdown", { clientX: 10, clientY: 215 });
  ui.fireWindow("pointermove", { clientX: 10, clientY: 220 });
  ui.fireWindow("pointermove", { clientX: 10, clientY: y });
}

test("a note is lifted, carried and dropped: one move, in front of the note it was dropped above", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "three"), "grip").fire("pointerdown", { clientX: 10, clientY: 215 });
  ui.fireWindow("pointermove", { clientX: 11, clientY: 216 });
  assert.equal(byClass(ui.root, "drag").length, 0, "a press that barely moves is not a drag");
  ui.fireWindow("pointerup", { clientX: 11, clientY: 216 });
  assert.equal(ui.hearing("pointermove"), 0);

  // The notes stand at 100, 150 and 200, each 40 high. Carried to 110, the
  // third is above the middle of the first, so it goes in front of it.
  carry(ui, "three", 110);
  assert.equal(byClass(ui.root, "drag").length, 1, "a copy follows the pointer");
  assert.ok(noteWith(ui.root, "three").className.includes("slot"), "and the note shows where it would land");
  assert.deepEqual(ui.sent(), [], "nothing is sent while it is carried");
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } }]);
  assert.equal(noteOrder(ui.root, "Went well"), "three one two");
  assert.equal(byClass(ui.root, "drag").length, 0);
  assert.equal(ui.hearing("pointermove") + ui.hearing("pointerup") + ui.hearing("pointercancel") + ui.hearing("blur"), 0, "the window is no longer listened to");
  assert.equal((main(ui.root).listeners.lostpointercapture || []).length, 0);
});

test("Escape ends a drag completely: moving on does not pick it up again, and letting go sends nothing", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", 110);
  ui.press("Escape");
  assert.equal(byClass(ui.root, "drag").length, 0);
  assert.equal(ui.hearing("pointermove"), 0, "the drag is no longer followed");
  ui.fireWindow("pointermove", { clientX: 10, clientY: 160 });
  ui.fireWindow("pointerup", { clientX: 10, clientY: 160 });
  assert.equal(byClass(ui.root, "drag").length, 0, "more movement lifts nothing");
  assert.deepEqual(ui.sent(), []);
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  assert.ok(!byClass(ui.root, "note").some((n) => n.className.includes("slot")));
  assert.equal(ui.document.documentElement.className, "");
});

test("a drag also ends when the window loses focus or the capture is taken away", () => {
  for (const end of [(ui) => ui.fireWindow("blur"), (ui) => main(ui.root).fire("lostpointercapture"), (ui) => ui.fireWindow("pointercancel")]) {
    const ui = load({ host: "new" });
    ui.push(session({ cards: three }, PARTICIPANT));
    carry(ui, "three", 110);
    ui.push(session({ cards: [...three, card("c4", "went-well", "four")] }, PARTICIPANT));
    end(ui);
    assert.equal(byClass(ui.root, "drag").length, 0);
    assert.equal(ui.hearing("pointermove"), 0);
    assert.deepEqual(ui.sent(), []);
    assert.equal(noteOrder(ui.root, "Went well"), "one two three four", "and the state that waited is shown");
  }
  // Capture lost by something inside the board is not the drag's.
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", 110);
  main(ui.root).fire("lostpointercapture", { target: one(noteWith(ui.root, "three"), "grip") });
  assert.equal(byClass(ui.root, "drag").length, 1);
});

test("a teammate's change waits while a note is carried, and is there when it is put down", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", 110);
  ui.push(session({ cards: [...three, card("c4", "went-well", "four")] }, PARTICIPANT));
  absent(noteWith(ui.root, "four"), "the lane is not shuffled under the hand");
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.ok(noteWith(ui.root, "four"));
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } }]);
});

test("a note deleted while it is carried is not moved, and the board says it is gone", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", 110);
  ui.push(session({ cards: three.slice(0, 2) }, PARTICIPANT));
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), []);
  assert.equal(noteOrder(ui.root, "Went well"), "one two");
  assert.equal(byClass(ui.root, "drag").length, 0);
  assert.equal(toastOf(ui.root).textContent, "That note is no longer on the board.");
});

test("a note in a lane sorted by votes is not lifted, and the reason is given", () => {
  const ui = load();
  ui.push(session({ cards: voted }));
  button(lane(ui.root, "Went well"), "Votes").click();
  carry(ui, "one", 110);
  assert.equal(byClass(ui.root, "drag").length, 0);
  assert.equal(toastOf(ui.root).textContent, "Sorted by votes. Show shared order to move notes here.");
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), []);
  assert.equal(noteOrder(ui.root, "Went well"), "two three one");
});

// A stamp this viewer pressed, on a note 240 by 44 at the page's corner.
function pressed(ui) {
  const cards = [card("c1", "went-well", "one")];
  ui.push(session({ cards }, PARTICIPANT));
  one(noteWith(ui.root, "one"), "grip").click();
  menuItem(ui.root, "Add a stamp").click();
  button(ui.root, "Blocker").click();
  const stamps = [{ id: "s1", ...ui.sent()[0].payload }];
  ui.push(session({ cards, stamps }, PARTICIPANT));
  return { cards, stamps, stamp: stampsOf(ui.root, "one")[0] };
}

test("a stamp is dragged to a point on its note and sent once, when it is let go", () => {
  const ui = load({ host: "new" });
  const { stamp } = pressed(ui);
  stamp.fire("pointerdown", { clientX: 6, clientY: 0 });
  ui.fireWindow("pointermove", { clientX: 60, clientY: 5 });
  ui.fireWindow("pointermove", { clientX: 120, clientY: 11 });
  assert.ok(stamp.className.includes("lift"));
  assert.equal(ui.sent().length, 1, "only the press so far");
  ui.fireWindow("pointerup", { clientX: 120, clientY: 11 });
  // 120 of 240 across; 11 down is 17 of the 34 it can travel, counted from 6 above the edge.
  assert.deepEqual(ui.sent()[1], { action: "move-stamp", payload: { stampId: "s1", x: 0.5, y: 0.5 } });
  assert.ok(!stamp.className.includes("lift"));
});

test("a stamp removed while it is dragged, or while its keys are still resting, is let go without a word to the server", () => {
  const ui = load({ host: "new" });
  const { cards, stamp } = pressed(ui);
  stamp.fire("pointerdown", { clientX: 6, clientY: 0 });
  ui.fireWindow("pointermove", { clientX: 120, clientY: 11 });
  ui.push(session({ cards }, PARTICIPANT));
  ui.fireWindow("pointermove", { clientX: 130, clientY: 11 });
  ui.fireWindow("pointerup", { clientX: 130, clientY: 11 });
  assert.equal(ui.sent().length, 1, "the press, and no move");
  assert.equal(toastOf(ui.root).textContent, "That stamp is no longer on the board.");

  const keyed = load({ host: "new" });
  const again = pressed(keyed);
  again.stamp.fire("keydown", { key: "ArrowRight", shiftKey: true });
  keyed.push(session({ cards: again.cards }, PARTICIPANT));
  keyed.runTimers(500);
  assert.equal(keyed.sent().length, 1);
});

// ---- popovers

test("the board under a popover is inert, and is given back on every way out", () => {
  const ways = [
    ["Escape", (ui) => ui.press("Escape")],
    ["a press elsewhere", (ui) => ui.pressOn(lane(ui.root, "Puzzles"))],
    ["its own control", (ui, grip) => grip.click()],
    ["Tab", (ui) => one(ui.root, "menu").fire("keydown", { key: "Tab" })],
    ["choosing an item", (ui) => menuItem(ui.root, "Select to group").click()],
    ["a drag starting", (ui) => carry(ui, "three", 110)],
  ];
  for (const [name, leave] of ways) {
    const ui = load({ host: "new" });
    ui.push(session({ cards: three }, PARTICIPANT));
    assert.equal(inert(ui.root), "false false");
    const grip = one(noteWith(ui.root, "two"), "grip");
    grip.click();
    assert.equal(inert(ui.root), "true true", name);
    leave(ui, grip);
    assert.equal(byClass(ui.root, "pop").length, 0, name);
    assert.equal(inert(ui.root), "false false", name);
  }

  // One popover opened from another: inert throughout, and given back at the end.
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "grip").click();
  menuItem(ui.root, "Delete note").click();
  assert.equal(inert(ui.root), "true true");
  button(ui.root, "Keep it").click();
  assert.equal(inert(ui.root), "false false");
});

test("a popover whose note a teammate deletes is closed, and says why", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "grip").click();
  ui.push(session({ cards: [three[0], three[2]] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "pop").length, 0);
  assert.equal(inert(ui.root), "false false", "the board is not left inert under nothing");
  assert.equal(toastOf(ui.root).textContent, "That was removed from the board while you had it open.");
});

test("a resize, as a phone's keyboard makes when it opens, leaves a popover open", () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 3, cards: three }, FACILITATOR));
  one(noteWith(ui.root, "one"), "target").click();
  const text = all(ui.root, (n) => n.getAttribute("id") === "link-text")[0];
  text.type("half a sentence");
  ui.fireWindow("resize");
  assert.equal(byClass(ui.root, "sheet").length, 1);
  assert.equal(text.value, "half a sentence");
  same(ui.document.activeElement, text, "and focus is still in the field");
  assert.equal(inert(ui.root), "true true");
});

// ---- state strings as keys

test("ids and kinds that are names the language already uses are drawn, or left out, like any other", () => {
  const ui = load({ host: "new" });
  const odd = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const state = {
    columns: [...columns, { id: "constructor", title: "Odd lane" }],
    cards: odd.map((id) => card(id, id === "toString" ? "constructor" : "went-well", "note " + id)),
    groups: [{ id: "valueOf", columnId: "went-well", title: "odd group" }],
    stamps: odd.map((kind, i) => ({ id: "s" + i, cardId: "constructor", kind, x: 0.5, y: 0.5, rot: 0 })).concat([{ id: "__proto__", cardId: "__proto__", kind: "idea", x: 0, y: 0, rot: 0 }]),
    actionItems: [{ id: "__proto__", text: "odd action", owner: "", sourceIds: odd }],
  };
  ui.push(session(state, PARTICIPANT));
  ui.push(session(state, PARTICIPANT));
  assert.equal(byClass(ui.root, "note").length, 4);
  assert.equal(noteOrder(ui.root, "Odd lane"), "note toString");
  assert.equal(byClass(ui.root, "stamp").length, 1, "a kind that is not a stamp is not drawn as one");
  assert.doesNotMatch(ui.root.textContent, /undefined/);
  assert.equal(byClass(one(ui.root, "action"), "src").length, 3, "four sources: two chips and the rest");

  one(noteWith(ui.root, "note __proto__"), "grip").click();
  menuItem(ui.root, "Vote for this note").click();
  assert.deepEqual(ui.sent(), [{ action: "vote", payload: { cardId: "__proto__" } }]);
  ui.acts[0].answer({ ok: false, reason: "constructor" });
  ui.push(session({ cards: [] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "note").length, 0);
  assert.equal({}.lanes, undefined);
});

// ---- deleting

test("deleting a note is asked about, with focus on the way out, and sent as the viewer's own request", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const grip = one(noteWith(ui.root, "two"), "grip");
  grip.click();
  menuItem(ui.root, "Delete note").click();
  const sheet = one(ui.root, "sheet");
  assert.equal(sheet.getAttribute("role"), "alertdialog");
  assert.equal(sheet.getAttribute("aria-label"), "Delete this note?");
  assert.match(sheet.textContent, /Its votes, stamps and links to actions go with it\. This cannot be undone\./);
  same(ui.document.activeElement, button(sheet, "Keep it"), "Enter keeps the note");
  assert.deepEqual(ui.sent(), [], "opening the question deletes nothing");
  button(sheet, "Keep it").click();
  same(ui.document.activeElement, grip);
  assert.deepEqual(ui.sent(), []);

  grip.click();
  menuItem(ui.root, "Delete note").click();
  button(one(ui.root, "sheet"), "Delete note").click();
  assert.deepEqual(ui.sent(), [{ action: "delete-card", payload: { cardId: "c2" } }]);
  ui.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note, or the facilitator, can delete it.");
  assert.ok(noteWith(ui.root, "two"), "a refused delete leaves the note");

  const lead = load({ host: "new" });
  lead.push(session({ cards: three }, FACILITATOR));
  one(noteWith(lead.root, "two"), "grip").click();
  menuItem(lead.root, "Delete note").click();
  button(one(lead.root, "sheet"), "Delete note").click();
  assert.deepEqual(lead.sent(), [{ action: "moderate-card", payload: { cardId: "c2" } }]);
});

test("a delete the bridge will not carry is refused at once and leaves the note", async () => {
  for (const fail of ["throw", "reject"]) {
    const ui = load({ host: "new" });
    ui.push(session({ cards: three }, PARTICIPANT));
    ui.bridge.fail = fail;
    one(noteWith(ui.root, "two"), "grip").click();
    menuItem(ui.root, "Delete note").click();
    button(one(ui.root, "sheet"), "Delete note").click();
    await settled();
    assert.match(toastOf(ui.root).textContent, /could not be sent/, fail);
    assert.ok(noteWith(ui.root, "two"), fail);
  }
});

test("a deleted note is announced without a word about whose it was, and focus moves to the note in its place", () => {
  const ui = load({ host: "new" });
  const stamps = [{ id: "s1", cardId: "c2", kind: "idea", x: 0, y: 0, rot: 0 }];
  ui.push(session({ cards: three, stamps }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "grip").focus();
  ui.push(session({ cards: [three[0], three[2]] }, PARTICIPANT));
  assert.equal(liveOf(ui.root), "A note was removed from Went well.");
  same(ui.document.activeElement, one(noteWith(ui.root, "three"), "grip"));

  ui.push(session({ cards: [] }, PARTICIPANT));
  assert.equal(liveOf(ui.root), "2 notes were removed.");
  same(ui.document.activeElement, composer(ui.root, "Went well"), "with the lane empty, focus goes to its composer");
});

test("once authors are revealed, Delete says whose a note is instead of asking the server", () => {
  const ui = load({ host: "new" });
  ui.push(session({ revealed: true, cards: [card("c1", "went-well", "mine", { authorId: "u-bo" }), card("c2", "went-well", "hers", { authorId: "u-cy" })] }, PARTICIPANT));
  one(noteWith(ui.root, "hers"), "grip").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), "true");
  menuItem(ui.root, "Delete note").click();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note, or the facilitator, can delete it.");
  assert.equal(byClass(ui.root, "sheet").length, 0);
  ui.press("Escape");
  one(noteWith(ui.root, "mine"), "grip").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), null);
});

// ---- owners

test("an action nobody owns says so, and anyone can name an owner or delete it", () => {
  const ui = load({ host: "new" });
  const actionItems = [{ id: "a1", text: "fix it", owner: "", sourceIds: [] }];
  ui.push(session({ actionItems }, PARTICIPANT));
  const row = one(ui.root, "action");
  assert.equal(visible(one(row, "unowned")), true);
  assert.equal(one(row, "unowned").textContent, "Unassigned");
  assert.equal(visible(one(row, "person")), false);
  assert.doesNotMatch(row.textContent, /Former participant|Bo Reyes/, "a blank owner is not the person who wrote it down");

  const menu = labeled(row, "Options for action: fix it");
  menu.click();
  menuItem(ui.root, "Set an owner").click();
  const field = all(ui.root, (n) => n.getAttribute("id") === "owner-name")[0];
  same(ui.document.activeElement, field);
  field.type("  Cy Park ");
  field.fire("keydown", ENTER);
  assert.deepEqual(ui.sent(), [{ action: "set-owner", payload: { actionId: "a1", owner: "Cy Park" } }]);

  ui.push(session({ actionItems: [{ ...actionItems[0], owner: "Cy Park" }] }, PARTICIPANT));
  assert.equal(visible(one(row, "unowned")), false);
  assert.match(one(row, "person").textContent, /Cy Park/);
  assert.equal(liveOf(ui.root), "Cy Park now owns: fix it.");

  menu.click();
  menuItem(ui.root, "Change owner").click();
  assert.equal(all(ui.root, (n) => n.getAttribute("id") === "owner-name")[0].value, "Cy Park");
  ui.press("Escape");
  menu.click();
  menuItem(ui.root, "Delete action").click();
  same(ui.document.activeElement, button(one(ui.root, "sheet"), "Keep it"));
  assert.equal(ui.sent().length, 1);
  button(one(ui.root, "sheet"), "Delete action").click();
  assert.deepEqual(ui.sent()[1], { action: "delete-action", payload: { actionId: "a1" } });
  ui.push(session({ actionItems: [] }, PARTICIPANT));
  assert.equal(liveOf(ui.root), "Action removed: fix it.");
});

// ---- refusals in the board's own words

test("a cap the board answers with is explained as that cap, not as a room that ended", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "one"), "grip").click();
  menuItem(ui.root, "Add a stamp").click();
  button(ui.root, "Blocker").click();
  ui.acts[0].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.equal(
    toastOf(ui.root).textContent,
    "That stamp was not pressed. A note holds twelve stamps, three per person. If that is not it, this organization's storage for the plugin is full: delete notes or actions, or ask an admin.",
  );

  const input = composer(ui.root, "Went well");
  input.type("one more");
  input.fire("keydown", ENTER);
  ui.acts[1].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.match(toastOf(ui.root).textContent, /^That note was not saved\. A board holds 120 notes, 30 from each person\. If that is not it, this organization's storage for the plugin is full/);

  // A change with no limit of its own: the store being full is the likely reason.
  one(noteWith(ui.root, "one"), "grip").click();
  menuItem(ui.root, "Move down").click();
  ui.acts[2].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.equal(toastOf(ui.root).textContent, "The board could not take that. The room has ended, or this organization's storage for the plugin is full: delete notes or actions, or ask an admin.");
  assert.equal(noteOrder(ui.root, "Went well"), "one two three one more", "and the move is taken back; the unsaved note still waits");
});

test("somebody else's change to the timer is not taken for this one landing", () => {
  const ui = load();
  ui.push(session({ stage: 2, timer: timer(1, "running", 300_000) }, FACILITATOR));
  labeled(ui.root, "Timer controls").click();
  button(one(ui.root, "sheet"), "Pause").click();
  // A minute was added from another tab: the timer changed and is still running.
  ui.push(session({ stage: 2, timer: timer(2, "running", 360_000) }, FACILITATOR));
  ui.runTimers(WAIT);
  assert.match(toastOf(ui.root).textContent, /Could not confirm the timer change\./);
  ui.push(session({ stage: 2, timer: timer(3, "paused", 350_000) }, FACILITATOR));
  assert.equal(visible(toastOf(ui.root)), false, "the pause itself, arriving late, takes the message back");
});

// ---- the header on a phone

test("the hint opens and closes from its own control, and Back is named in full for a screen reader", () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 1 }, FACILITATOR));
  const more = one(ui.root, "hint-more");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  one(ui.root, "hints").click();
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.ok(one(ui.root, "hints").className.includes("open"));
  one(ui.root, "hints").click();
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(button(ui.root, "Back").getAttribute("aria-label"), "Back to Write");
  assert.equal(button(ui.root, "Back").textContent, "Back to Write");
});

// ---- a yes the state does not bear out

// Each change the board can make ahead of, or apart from, the state: how it
// is made, and what the board must look like once it is clear that the state
// never agreed. A host without refusals answers yes to all of them.
const others9 = { cards: three, stamps: [{ id: "s9", cardId: "c1", kind: "chat", x: 0.5, y: 0.5, rot: 0 }], actionItems: [{ id: "a1", text: "fix it", owner: "", sourceIds: [] }] };
const unborne = [
  {
    name: "a stamp move",
    who: FACILITATOR,
    make: (ui) => {
      stampsOf(ui.root, "one")[0].fire("keydown", { key: "ArrowRight", shiftKey: true });
      ui.runTimers(500);
    },
    action: "moderate-stamp",
    drawnAhead: (ui) => leftOf(stampsOf(ui.root, "one")[0]) === 52.5,
    back: (ui) => leftOf(stampsOf(ui.root, "one")[0]) === 50,
    said: /Could not confirm that the stamp moved\./,
  },
  {
    name: "a stamp removal",
    who: PARTICIPANT,
    make: (ui) => stampsOf(ui.root, "one")[0].fire("keydown", { key: "Delete" }),
    action: "remove-stamp",
    drawnAhead: (ui) => stampsOf(ui.root, "one").length === 1,
    back: (ui) => stampsOf(ui.root, "one").length === 1 && stampsOf(ui.root, "one")[0].className.split(" ").includes("fixed"),
    said: /Could not confirm that the stamp was removed\./,
  },
  {
    name: "a note move",
    who: PARTICIPANT,
    make: (ui) => noteWith(ui.root, "three").fire("keydown", { key: "ArrowUp", altKey: true }),
    action: "move-card",
    drawnAhead: (ui) => noteOrder(ui.root, "Went well") === "one three two",
    back: (ui) => noteOrder(ui.root, "Went well") === "one two three",
    said: /Could not confirm that move\./,
  },
  {
    name: "a note deletion",
    who: PARTICIPANT,
    make: (ui) => {
      one(noteWith(ui.root, "two"), "grip").click();
      menuItem(ui.root, "Delete note").click();
      button(one(ui.root, "sheet"), "Delete note").click();
    },
    action: "delete-card",
    drawnAhead: (ui) => noteOrder(ui.root, "Went well") === "one two three",
    back: (ui) => noteOrder(ui.root, "Went well") === "one two three",
    said: /Could not confirm that the note was deleted\./,
  },
  {
    name: "an owner",
    who: PARTICIPANT,
    make: (ui) => {
      labeled(ui.root, "Options for action: fix it").click();
      menuItem(ui.root, "Set an owner").click();
      const field = all(ui.root, (n) => n.getAttribute("id") === "owner-name")[0];
      field.type("Cy Park");
      field.fire("keydown", ENTER);
    },
    action: "set-owner",
    drawnAhead: (ui) => visible(one(one(ui.root, "action"), "unowned")),
    back: (ui) => visible(one(one(ui.root, "action"), "unowned")),
    said: /Could not confirm the owner\./,
  },
  {
    name: "an action deletion",
    who: PARTICIPANT,
    make: (ui) => {
      labeled(ui.root, "Options for action: fix it").click();
      menuItem(ui.root, "Delete action").click();
      button(one(ui.root, "sheet"), "Delete action").click();
    },
    action: "delete-action",
    drawnAhead: (ui) => byClass(ui.root, "action").length === 1,
    back: (ui) => byClass(ui.root, "action").length === 1,
    said: /Could not confirm that the action was deleted\./,
  },
];

test("on a host that answers nothing, a change the state never shows is taken back and called unconfirmed", () => {
  for (const c of unborne) {
    const ui = load({ host: "old" });
    ui.push(session(others9, c.who));
    c.make(ui);
    assert.equal(ui.sent().at(-1).action, c.action, c.name);
    assert.ok(c.drawnAhead(ui), c.name + ": as it stands while it is on its way");
    ui.runTimers(WAIT);
    assert.ok(c.back(ui), c.name + ": taken back");
    assert.match(toastOf(ui.root).textContent, c.said, c.name);
  }
});

test("a yes from the host is believed only when the state shows the change", async () => {
  for (const c of unborne) {
    const ui = load({ host: "new" });
    ui.push(session(others9, c.who));
    c.make(ui);
    ui.acts.at(-1).answer({ ok: true });
    await settled();
    assert.ok(c.drawnAhead(ui), c.name + ": a yes alone changes nothing on screen");
    assert.equal(toastOf(ui.root).hidden, true, c.name + ": and nothing is said yet");
    ui.runTimers(WAIT);
    assert.ok(c.back(ui), c.name + ": taken back when the state never agreed");
    assert.match(toastOf(ui.root).textContent, c.said, c.name);
  }
});

test("a stamp is the viewer's once the server said yes and the state shows it, in either order, and not before", async () => {
  const moved = { ...others9, stamps: [{ ...others9.stamps[0], x: 0.6 }] };
  const mine = (ui) => !stampsOf(ui.root, "one")[0].className.split(" ").includes("fixed");
  // Removing is the one change a participant can ask for on a stamp not known
  // to be theirs, so the stamp is first made theirs by a press of their own.
  const press = (ui) => {
    one(noteWith(ui.root, "one"), "grip").click();
    menuItem(ui.root, "Add a stamp").click();
    button(ui.root, "Blocker").click();
    return { id: "s1", ...ui.sent()[0].payload };
  };

  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const s = press(ui);
  ui.acts[0].answer({ ok: true });
  await settled();
  ui.runTimers(WAIT);
  assert.equal(stampsOf(ui.root, "one").length, 0, "a yes with no stamp in the state draws no stamp");
  ui.push(session({ cards: three, stamps: [s] }, PARTICIPANT));
  assert.ok(mine(ui), "the press that the state then shows is the viewer's");

  // The facilitator's every stamp is movable; a participant's yes for a move
  // the state contradicts must not make somebody else's stamp theirs.
  const other = load({ host: "new" });
  other.push(session(others9, PARTICIPANT));
  stampsOf(other.root, "one")[0].fire("keydown", { key: "Delete" });
  other.acts[0].answer({ ok: true });
  await settled();
  other.runTimers(WAIT);
  assert.ok(!mine(other), "yes to a removal that never happened proves nothing");
  other.push(session(moved, PARTICIPANT));
  assert.ok(!mine(other), "and a later change by somebody else does not either");
});

// ---- one pointer per drag

test("a second finger does not drive, drop or commit a drag", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", 110);
  ui.fireWindow("pointermove", { pointerId: 2, clientX: 10, clientY: 500 });
  ui.fireWindow("pointerup", { pointerId: 2, clientX: 10, clientY: 500 });
  assert.equal(byClass(ui.root, "drag").length, 1, "the first finger still holds the note");
  assert.deepEqual(ui.sent(), []);
  ui.fireWindow("pointercancel", { pointerId: 2 });
  assert.equal(byClass(ui.root, "drag").length, 1);
  ui.fireWindow("pointerup", { pointerId: 1, clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } }], "where the first finger left it, not the second");
});

// ---- sheets hold focus

test("Tab and Shift+Tab go round inside a sheet; a menu still closes on Tab", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "grip").click();
  menuItem(ui.root, "Delete note").click();
  const sheet = one(ui.root, "sheet");
  const keep = button(sheet, "Keep it");
  const go = button(sheet, "Delete note");
  same(ui.document.activeElement, keep);
  sheet.fire("keydown", { key: "Tab" });
  same(ui.document.activeElement, go, "Tab goes on");
  sheet.fire("keydown", { key: "Tab" });
  same(ui.document.activeElement, keep, "and round, not out to the page");
  sheet.fire("keydown", { key: "Tab", shiftKey: true });
  same(ui.document.activeElement, go, "Shift+Tab goes back round");
  assert.deepEqual(ui.sent(), [], "going round deletes nothing");
  ui.press("Escape");

  // A field that cannot be used just now is not a stop.
  one(noteWith(ui.root, "two"), "grip").click();
  menuItem(ui.root, "Start an action").click();
  const form = one(ui.root, "sheet");
  const text = all(form, (n) => n.getAttribute("id") === "link-text")[0];
  same(ui.document.activeElement, text);
  form.fire("keydown", { key: "Tab", shiftKey: true });
  same(ui.document.activeElement, button(form, "Cancel"), "the disabled Add action is passed over");
});

test("when the note a confirmation was opened from is deleted, focus goes to the note in its place", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three, actionItems: [{ id: "a1", text: "fix it", owner: "", sourceIds: [] }] }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "grip").click();
  menuItem(ui.root, "Delete note").click();
  ui.push(session({ cards: [three[0], three[2]], actionItems: [{ id: "a1", text: "fix it", owner: "", sourceIds: [] }] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "sheet").length, 0);
  same(ui.document.activeElement, one(noteWith(ui.root, "three"), "grip"), "not the page");

  labeled(ui.root, "Options for action: fix it").click();
  menuItem(ui.root, "Delete action").click();
  ui.push(session({ cards: [three[0], three[2]] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "sheet").length, 0);
  same(ui.document.activeElement, button(one(ui.root, "actions"), "Add an action"), "an action's goes to the way to add one");
});

// ---- a refused delete is remembered

test("after the server says a note is not the viewer's, Delete is shown as unavailable, with the reason", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const remove = () => {
    one(noteWith(ui.root, "two"), "grip").click();
    menuItem(ui.root, "Delete note").click();
  };
  remove();
  button(one(ui.root, "sheet"), "Delete note").click();
  ui.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();

  one(noteWith(ui.root, "two"), "grip").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), "true");
  menuItem(ui.root, "Delete note").click();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note, or the facilitator, can delete it.");
  assert.equal(byClass(ui.root, "sheet").length, 0, "the question is not asked again");
  assert.equal(ui.acts.length, 1);
  ui.press("Escape");
  one(noteWith(ui.root, "one"), "grip").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), null, "another note is still asked about");
});
