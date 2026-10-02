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
  fire(type, event = {}) {
    const ev = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
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
  const window = { parley, addEventListener() {}, performance: { now: () => clock.t } };
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
  return { root, document, push, acts, sent, runTimers, bridge, clock, press };
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
  runTimers(WAIT);
  assert.match(byClass(root, "ghost")[0].textContent, /accepted/);
  assert.match(byClass(root, "ghost")[0].textContent, /Saving/);
  assert.equal(toastOf(root).hidden, true, "a slow state is not reported as a problem");

  push(session({ cards: [card("c1", "went-well", "accepted")] }));
  assert.equal(byClass(root, "ghost").length, 0);
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
  same(document.activeElement, menuItem(root, "Move to Puzzles"), "end");
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
  assert.ok(!button(lane(root, "Went well"), "Most votes"), "nothing to rank by yet");
  push(session({ cards: voted }));
  assert.ok(!button(lane(root, "Puzzles"), "Most votes"), "an empty lane has nothing to sort");
  const toggle = button(lane(root, "Went well"), "Most votes");
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
  button(lane(root, "Went well"), "Most votes").click();
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
  button(lane(lead.root, "Went well"), "Most votes").click();
  button(lead.root, "Use this order for everyone").click();
  assert.deepEqual(lead.sent(), [{ action: "order-by-votes", payload: { columnId: "went-well" } }]);
  lead.push(session({ cards: [voted[1], voted[2], voted[0]] }, FACILITATOR));
  assert.equal(button(lane(lead.root, "Went well"), "Most votes").getAttribute("aria-pressed"), "false", "the lens is off: the shared order is now the sorted one");
  assert.equal(noteOrder(lead.root, "Went well"), "two three one");

  const member = load({ host: "new" });
  member.push(session({ cards: voted }, PARTICIPANT));
  button(lane(member.root, "Went well"), "Most votes").click();
  assert.ok(!button(member.root, "Use this order for everyone"));
});

// ---- stamps

const stampsOf = (root, text) => byClass(noteWith(root, text), "stamp");
const leftOf = (node) => Math.round(parseFloat(node.style.left) * 10) / 10;

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
  assert.equal(sent()[0].action, "stamp");
  // The note cannot be measured here, so it is taken to be 240 by 44. The
  // default spot is 72 in from the right, clear of the note's own controls,
  // and 2 up from the bottom edge: 168/240 and 42/44.
  assert.deepEqual(where, { cardId: "c1", kind: "quick-win", x: 0.7, y: 0.955 });
  assert.ok(Math.abs(rot) <= 9, "the tilt is a small one");

  push(session({ cards, stamps: [{ id: "s1", ...where, rot }] }, PARTICIPANT));
  const stamp = stampsOf(root, "one")[0];
  assert.equal(stamp.getAttribute("aria-label"), "Quick win stamp, 1 of 1 on this note");
  assert.equal(stamp.style.left, "70%");
  assert.equal(stamp.style.top, "95.5%");
  same(document.activeElement, stamp, "the stamp just pressed has focus, ready for the arrow keys");

  stamp.fire("keydown", { key: "ArrowRight" });
  stamp.fire("keydown", { key: "ArrowRight" });
  // One step is 6 of the note's 240: 0.7 + 0.025 + 0.025.
  assert.equal(leftOf(stamp), 75, "it moves at once");
  assert.equal(sent().length, 1, "and is not sent until the keys rest");
  runTimers(500);
  assert.deepEqual(sent()[1], { action: "move-stamp", payload: { stampId: "s1", x: 0.75, y: 0.955 } });

  stamp.fire("keydown", { key: "Delete" });
  assert.deepEqual(sent()[2], { action: "remove-stamp", payload: { stampId: "s1" } });
  push(session({ cards }, PARTICIPANT));
  assert.equal(stampsOf(root, "one").length, 0);
  same(document.activeElement, one(noteWith(root, "one"), "grip"), "focus falls back to the note");
});

test("a second stamp from the menu lands beside the first, not on it", () => {
  const { root, push, sent } = load();
  const cards = [card("c1", "went-well", "one")];
  push(session({ cards, stamps: [{ id: "s1", cardId: "c1", kind: "idea", x: 0.7, y: 0.955, rot: 0 }] }));
  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Add a stamp").click();
  button(root, "Blocker").click();
  // The next place along is 30 further left: 138/240.
  assert.equal(sent()[0].payload.x, 0.575);
  assert.equal(sent()[0].payload.y, 0.955);
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

test("a stamp that is somebody else's is refused by the server once, and not asked about again", async () => {
  const { root, push, acts, runTimers } = load({ host: "new" });
  const state = { cards: [card("c1", "went-well", "one")], stamps: [{ id: "s9", cardId: "c1", kind: "chat", x: 0.5, y: 0.5, rot: 0 }] };
  push(session(state, PARTICIPANT));
  const stamp = stampsOf(root, "one")[0];
  stamp.fire("keydown", { key: "ArrowLeft" });
  assert.equal(leftOf(stamp), 47.5);
  runTimers(500);
  assert.deepEqual(acts.map((a) => a.action), ["move-stamp"]);
  acts[0].answer({ ok: false, reason: "failed" });
  await settled();
  assert.match(toastOf(root).textContent, /Only the person who pressed a stamp, or the facilitator, can move or remove it\./);
  assert.equal(leftOf(stamp), 50, "it goes back where it was");

  stamp.fire("keydown", { key: "ArrowLeft" });
  stamp.fire("keydown", { key: "Delete" });
  runTimers(500);
  assert.equal(acts.length, 1, "the answer is remembered");
  assert.equal(leftOf(stamp), 50);
});

test("the facilitator moves and removes any stamp, through the action kept for the facilitator", () => {
  const { root, push, sent, runTimers } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")], stamps: [{ id: "s9", cardId: "c1", kind: "chat", x: 0.5, y: 0.5, rot: 0 }] }, FACILITATOR));
  const stamp = stampsOf(root, "one")[0];
  stamp.fire("keydown", { key: "ArrowDown" });
  runTimers(500);
  // One step is 6 of the note's 44: 0.5 + 6/44 = 0.636.
  assert.deepEqual(sent()[0], { action: "moderate-stamp", payload: { stampId: "s9", x: 0.5, y: 0.636 } });
  stamp.click();
  menuItem(root, "Remove stamp").click();
  assert.deepEqual(sent()[1], { action: "moderate-stamp", payload: { stampId: "s9", remove: true } });
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
  same(document.activeElement, stampsOf(root, "one")[1], "Move puts focus on that stamp, for the arrow keys");
  assert.match(liveOf(root), /Arrow keys move it\. Delete removes it\./);

  one(noteWith(root, "one"), "grip").click();
  menuItem(root, "Stamps on this note (2)").click();
  labeled(root, "Remove Great idea stamp, 1 of 2").click();
  assert.deepEqual(sent(), [{ action: "moderate-stamp", payload: { stampId: "s1", remove: true } }]);
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
  assert.deepEqual([drawn[0].style.left, drawn[0].style.top], ["100%", "0%"]);
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

test("a linked note shows its target in every stage, and an action lists two sources before the rest", () => {
  const { root, push } = load();
  const cards = ["one", "two", "three", "four"].map((t, i) => card("c" + (i + 1), "went-well", t));
  push(session({ stage: 0, cards, actionItems: [{ id: "a1", text: "x", owner: "u-bo", sourceIds: ["c1", "c2", "c3", "c404"] }] }));
  assert.equal(visible(one(noteWith(root, "one"), "target")), true);
  assert.equal(visible(one(noteWith(root, "four"), "target")), false, "an unlinked note keeps its target for Decide");
  const chips = () => byClass(one(root, "action"), "src").map((c) => c.textContent);
  assert.deepEqual(chips(), ["one", "two", "+1 more"], "a source that is gone is not counted");
  button(one(root, "action"), "+1 more").click();
  assert.deepEqual(chips(), ["one", "two", "three"]);
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
