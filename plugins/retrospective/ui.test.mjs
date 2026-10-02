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
    const ev = { preventDefault() {}, target: this, ...event };
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
  const window = { parley, addEventListener() {} };
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
  return { root, document, push, acts, sent, runTimers, bridge };
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
  push(session({ cards }));
  const vote = button(noteWith(root, "one"), "Vote");
  vote.focus();
  push(
    session({
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
  assert.match(byClass(root, "authorship")[0].textContent, /cannot be undone/);

  button(root, "Not yet").click();
  assert.deepEqual(sent(), []);

  button(root, "Reveal authors").click();
  const confirm = button(root, "Reveal to everyone");
  confirm.click();
  assert.deepEqual(sent(), [{ action: "reveal", payload: {} }]);
  assert.equal(confirm.disabled, true, "no second press while the first is pending");

  push(session({ revealed: true, cards: [card("c1", "went-well", "one", { authorId: "u-bo" })] }));
  assert.ok(!button(root, "Reveal"), "no such button is offered");
  assert.ok(all(root, (n) => visible(n) && n.text === "Authors visible").length);
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
  const before = session({ cards: [card("c1", "went-well", "one")] });
  const after = session({ cards: [card("c1", "went-well", "one", { voteCount: 1 })] });

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

test("the progress strip follows the board, and a reveal is not progress", () => {
  const { root, push } = load();
  const current = () => byClass(root, "current")[0].textContent;
  push(session({ revealed: true }));
  assert.match(current(), /Write/);
  push(session({ revealed: true, actionItems: [{ id: "a1", text: "x", owner: "u-bo", done: false }] }));
  assert.match(current(), /Decide/);
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
