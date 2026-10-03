import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext, SourceTextModule } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const dir = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)("./manifest.json");
// The suite runs ui.board.js, the ui/ modules as `make` joins them. RETRO_UI_SRC
// points it at another build of the board, for checking that a test can fail.
// The tracked sources are never edited for that.
const srcPath = process.env.RETRO_UI_SRC || join(dir, "ui.board.js");
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
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
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
    // With `motion` the document animates: each call is kept, and a test
    // ends it by hand, as finished or as canceled.
    if (doc.motion) {
      this.animate = (frames, timing) => {
        const animation = {
          target: this,
          frames,
          timing,
          finish() {
            if (this.onfinish) this.onfinish();
          },
          cancel() {
            if (this.oncancel) this.oncancel();
          },
        };
        doc.animations.push(animation);
        return animation;
      };
    }
    this.value = "";
    this.text = "";
    this.off = false;
    this.checked = false;
    this.hidden = false;
  }
  // As a browser does: a control that is disabled while it has focus drops it.
  get disabled() {
    return this.off;
  }
  set disabled(value) {
    this.off = !!value;
    if (this.off && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
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
    // Counted, so a test can say how often the board measures.
    this.ownerDocument.rectReads += 1;
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
// `run` puts the board into the fake window; by default it runs the joined
// ui.board.js as the frame does, and loadModules hands it the ui/ modules
// instead.
function load({ host = "old", motion = false, phone = false, dpr, fonts = false, run } = {}) {
  // Timers are kept by id, and an id is never used twice, so clearing a timer
  // that has already run cannot cancel a different one.
  const timers = new Map();
  let lastTimer = 0;
  const bridge = { fail: null, scheme: "dark", tokens: null };
  // The frame's clock. A test moves it by hand; nothing reads the real time.
  const clock = { t: 0 };
  const acts = [];
  const scrolls = [];
  const observers = [];
  const document = {
    activeElement: null,
    hidden: false,
    rectReads: 0,
    motion,
    animations: [],
    listeners: {},
    createElement: (tag) => new FakeNode(document, tag),
    createElementNS: (_, tag) => new FakeNode(document, tag),
    // The boxes of a paragraph's lines of words: a test says where they are
    // by setting `lines` on the paragraph; otherwise there are none.
    createRange: () => ({
      selectNodeContents(node) {
        this.node = node;
      },
      getClientRects() {
        return (this.node.lines || []).map(([left, top, right, bottom]) => ({ left, top, right, bottom, width: right - left }));
      },
    }),
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
    // How far the board asked the page to scroll, each time it asked.
    scrollBy(x, y) {
      scrolls.push(y);
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((other) => other !== fn);
    },
    performance: { now: () => clock.t },
    // Size observers do nothing until a test says a node has changed size.
    ResizeObserver: class {
      constructor(heard) {
        this.heard = heard;
        this.nodes = [];
        observers.push(this);
      }
      observe(node) {
        this.nodes.push(node);
      }
      unobserve(node) {
        this.nodes = this.nodes.filter((other) => other !== node);
      }
    },
  };
  if (phone) window.matchMedia = (query) => ({ matches: query.includes("max-width:480px") });
  if (dpr) window.devicePixelRatio = dpr;
  let fontsReady = () => {};
  if (fonts) document.fonts = { ready: new Promise((resolve) => (fontsReady = resolve)) };
  // Tell whoever watches `node` that it is now `width` wide.
  const resize = (node, width) => {
    for (const o of observers) if (o.nodes.includes(node)) o.heard([{ target: node, contentRect: { width } }]);
  };
  const watched = (node) => observers.reduce((n, o) => n + o.nodes.filter((other) => other === node).length, 0);
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
  const context = createContext({ window, document, setTimeout, clearTimeout });
  if (run) run(context);
  else {
    runInContext(src, context);
    assert.equal(typeof push, "function");
  }
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
  const fireDocument = (type) => {
    for (const fn of document.listeners[type] || []) fn({ type });
  };
  return { root, document, push: (state) => push(state), acts, sent, runTimers, bridge, clock, press, pressOn, fireWindow, fireDocument, hearing, scrolls, resize, watched, window, fontsReady, timerCount: () => timers.size };
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
// A menu item by its words, or by its name when it is drawn as an icon.
const menuItem = (root, label) => all(root, (n) => n.getAttribute("role") === "menuitem" && (n.getAttribute("aria-label") || n.textContent).startsWith(label))[0];
const noteOrder = (root, title) => byClass(lane(root, title), "note").map((n) => one(n, "note-text").textContent).join(" ");
const liveOf = (root) => one(root, "live").textContent;
// A note's thumb, up or down.
const thumb = (root, text, way) => byClass(noteWith(root, text), "rate").find((n) => n.className.split(" ").includes(way));
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

test("the shipped ui.js is the fonts followed by the joined board", () => {
  assert.equal(distSrc, fontSrc + readFileSync(join(dir, "ui.board.js"), "utf8"));
});

// The ui/ files are ES modules a browser could load as they are, not text
// that only works once joined: loaded natively from main.js, the graph links,
// every file under ui/ is in it, and the board runs from it. Writes to the
// shared state go through `ui` in bridge/state.js; a file that assigned a
// binding it imports would throw "Assignment to constant variable" here.
async function loadModules(opts) {
  assert.equal(typeof SourceTextModule, "function", "needs --experimental-vm-modules, which make test sets");
  let context;
  const ui = load({ ...opts, run: (ctx) => (context = ctx) });
  const modules = new Map();
  const moduleAt = (path) => {
    if (!modules.has(path)) modules.set(path, new SourceTextModule(readFileSync(path, "utf8"), { context, identifier: path }));
    return modules.get(path);
  };
  const entry = moduleAt(join(dir, "ui", "main.js"));
  await entry.link((specifier, from) => moduleAt(resolve(dirname(from.identifier), specifier)));
  await entry.evaluate();
  return { ...ui, modules };
}

test("the ui/ files load as native ES modules, and the board runs from them", async () => {
  const ui = await loadModules({ host: "new" });
  const files = readdirSync(join(dir, "ui"), { recursive: true }).filter((f) => f.endsWith(".js"));
  assert.equal(ui.modules.size, files.length, "every file under ui/ is reached from main.js");

  ui.push(session({ cards: three }, PARTICIPANT));
  const box = composer(ui.root, "To improve");
  box.type("flaky deploys");
  box.fire("keydown", ENTER);
  noteWith(ui.root, "one").fire("keydown", { key: "u", target: one(noteWith(ui.root, "one"), "note-text") });
  // A drag, with a state push held back while it is carried: the shared
  // drag, gesture and held state are all written along the way.
  carry(ui, "three", 110);
  ui.push(session({ cards: [...three, card("c4", "went-well", "four")] }, PARTICIPANT));
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), [
    { action: "add-card", payload: { columnId: "to-improve", text: "flaky deploys" } },
    { action: "vote", payload: { cardId: "c1", value: "up" } },
    { action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } },
  ]);
  assert.ok(noteWith(ui.root, "four"), "the push held back during the drag is drawn once it is dropped");
});

// What the native load proves for the paths it runs, this proves for every
// line: no ui/ file assigns a name it imports.
test("no ui/ file assigns a binding it imports", () => {
  const files = readdirSync(join(dir, "ui"), { recursive: true }).filter((f) => f.endsWith(".js"));
  const found = [];
  for (const f of files) {
    const text = readFileSync(join(dir, "ui", f), "utf8");
    const imported = [...text.matchAll(/^import \{([^}]*)\} from/gm)].flatMap((m) => m[1].split(",").map((n) => n.trim()).filter(Boolean));
    const code = codeOnly(text.replace(/^import \{[^}]*\} from "[^"]*";$/gm, ""));
    for (const name of imported) {
      const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const assigned = new RegExp(`(^|[^.\\w$])${n}\\s*(=(?![=>])|[-+*/%&|^]=|\\*\\*=|<<=|>>>?=|&&=|\\|\\|=|\\?\\?=|\\+\\+|--)|(\\+\\+|--)\\s*${n}(?![\\w$.])`);
      if (assigned.test(code)) found.push(f + ": " + name);
    }
  }
  assert.deepEqual(found, []);
});

// The code of a file with its comments, strings and regular expressions
// blanked, so a word inside them is never read as a name.
function codeOnly(text) {
  let out = "";
  let last = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i++;
      out += " 0 ";
      last = "0";
    } else if (c === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last))) {
      i++;
      let inClass = false;
      while (i < text.length && (text[i] !== "/" || inClass)) {
        if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      while (/[a-z]/.test(text[i] || "")) i++;
      out += " 0 ";
      last = "0";
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

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
  const vote = thumb(root, "one", "up");
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
  const pressed = (root, way = "up") => thumb(root, "one", way).getAttribute("aria-pressed");
  const before = session({ stage: 2, cards: [card("c1", "went-well", "one")] });
  const after = session({ stage: 2, cards: [card("c1", "went-well", "one", { up: 1, down: 1 })] });

  const watcher = load({ host: "new" });
  watcher.push(before);
  watcher.push(after);
  assert.deepEqual([pressed(watcher.root, "up"), pressed(watcher.root, "down")], [null, null], "not known, so neither pressed nor not");
  assert.equal(liveOf(watcher.root), "", "and other people's votes are not read out");

  // An older host cannot say whose vote moved the count.
  const old = load();
  old.push(before);
  thumb(old.root, "one", "up").click();
  assert.equal(pressed(old.root), "true", "pressed while it is on its way");
  old.push(after);
  assert.equal(pressed(old.root), null, "the count moved, but whose vote it was is not known");

  const voter = load({ host: "new" });
  voter.push(before);
  thumb(voter.root, "one", "up").click();
  voter.acts[0].answer({ ok: true });
  await settled();
  assert.equal(pressed(voter.root), "true");
  assert.match(thumb(voter.root, "one", "up").getAttribute("aria-label"), /Your vote\. Press to take it back\.$/);
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
  const vote = thumb(root, "one", "up");
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
  assert.match(shownHint(root)[0].textContent, /^Vote each note up or down/);
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
  assert.equal(liveOf(root), "Alice Ng moved the room to Vote. Vote each note up or down. One vote per person per note; press your thumb again to take it back. The tag on a note's corner is its ups less its downs.");
  push(session({ stage: 2 }, PARTICIPANT));
  assert.equal(liveOf(root), "", "the same state again says nothing");
  push(session({ stage: 1 }, PARTICIPANT));
  assert.equal(liveOf(root), "Alice Ng moved the room back to Group.");
});

test("a note's handle and its menu button are there in every stage, in the same places; the stage adds one control", () => {
  const { root, push } = load();
  const note = () => noteWith(root, "one");
  const shown = (name) => visible(one(note(), name));
  // The controls in front of the text and after it, in the order they stand.
  const row = (part) => one(note(), part).children.filter(visible).map((n) => n.className.split(" ")[0]).join(" ");
  const cards = [card("c1", "went-well", "one")];
  const expected = [
    ["grip", ""],
    ["grip pick", ""],
    ["grip", ""],
    ["grip", "target"],
  ];
  expected.forEach(([lead, chips], stage) => {
    push(session({ stage, cards }));
    assert.equal(row("lead"), lead, "in front of the text, stage " + stage);
    assert.equal(row("trail"), "more", "after the text, the menu and only the menu, stage " + stage);
    assert.equal(visible(one(note(), "chips")) ? row("chips") : "", chips, "under the text, stage " + stage);
    assert.deepEqual(one(note(), "rx").children.map((n) => n.className), ["rb add-st", "rb rate up", "rb rate down"], "on the lower edge: the plus and the two thumbs, stage " + stage);
    assert.deepEqual(byClass(note(), "rate").map(visible), [true, true], "the thumbs are never taken out of the note, stage " + stage);
  });
  const more = one(note(), "more");
  assert.equal(more.getAttribute("aria-haspopup"), "menu");
  assert.equal(more.getAttribute("aria-label"), "Options for note: one");
  same(one(note(), "trail").lastChild, more, "the menu button is the last control on the note");
  // A vote already cast stays in sight in every stage.
  push(session({ stage: 0, cards: [card("c1", "went-well", "one", { voteCount: 2 })] }));
  assert.equal(shown("rate"), true);
  assert.equal(one(note(), "tally").hidden, false, "as a tag on the corner");
  assert.equal(one(note(), "chips").hidden, true, "and no row under the words");
  assert.equal(row("trail"), "more");
});

test("a handle only drags: pressed or clicked it opens no menu, and says how a move is made", () => {
  const { root, push, sent, runTimers } = load();
  push(session({ cards: three }));
  const grip = one(noteWith(root, "two"), "grip");
  assert.equal(grip.getAttribute("aria-haspopup"), null, "it does not claim to open anything");
  assert.equal(grip.getAttribute("aria-expanded"), null);
  assert.equal(grip.getAttribute("aria-label"), "Drag to reorder: two");
  assert.equal(grip.getAttribute("aria-describedby"), "grip-help");
  const help = all(root, (n) => n.getAttribute("id") === "grip-help")[0];
  assert.match(help.textContent, /Alt and the Up or Down arrow/);
  grip.click();
  assert.equal(byClass(root, "pop").length, 0, "no menu");
  assert.deepEqual(sent(), [], "and nothing moved");
  runTimers(60);
  assert.equal(liveOf(root), help.textContent, "the keys are read out");
  assert.equal(noteOrder(root, "Went well"), "one two three");
});

test("a group has a handle and a menu button of its own, and the handle opens nothing", () => {
  const { root, push } = load();
  push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1" })], groups: [{ id: "g1", columnId: "went-well", title: "Pair" }] }));
  const head = one(root, "group-head");
  const grip = one(head, "grip");
  assert.equal(grip.getAttribute("aria-label"), "Drag to reorder group: Pair");
  assert.equal(grip.getAttribute("aria-haspopup"), null);
  grip.click();
  assert.equal(byClass(root, "pop").length, 0);
  same(head.lastChild, one(head, "more"), "the menu button ends the heading");
  one(head, "more").click();
  assert.equal(one(root, "menu").getAttribute("aria-label"), "Options for group: Pair");
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

  noteWith(root, "one").fire("keydown", { key: "u", target: one(noteWith(root, "one"), "note-text") });
  assert.deepEqual(sent(), [
    { action: "add-card", payload: { columnId: "went-well", text: "a late thought" } },
    { action: "vote", payload: { cardId: "c1", value: "up" } },
  ]);
});

test("focus follows the control when a stage change takes it away", () => {
  const { root, document, push } = load();
  const cards = [card("c1", "went-well", "one")];
  push(session({ stage: 0, cards }));
  const note = noteWith(root, "one");
  one(note, "grip").focus();
  push(session({ stage: 1, cards }));
  same(document.activeElement, one(note, "grip"), "the handle stays where it is, and focus with it");
  push(session({ stage: 2, cards }));
  thumb(root, "one", "down").focus();
  push(session({ stage: 3, cards }));
  same(document.activeElement, thumb(root, "one", "down"), "a thumb is there in every stage, so focus on it stays");
  one(note, "target").focus();
  push(session({ stage: 0, cards }));
  same(document.activeElement, one(note, "more"), "a control that went away hands focus to the note's menu button");
});

// ---- the menu

test("a menu is walked with the arrow keys and a typed letter, and Escape hands focus back", () => {
  const { root, document, push, press } = load();
  push(session({ cards: three }));
  const grip = one(noteWith(root, "two"), "more");
  grip.click();
  const menu = one(root, "menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(grip.getAttribute("aria-expanded"), "true");
  same(document.activeElement, menuItem(root, "Edit note"), "the first item has focus");
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Add a sticker"), "down");
  menu.fire("keydown", { key: "End" });
  same(document.activeElement, menuItem(root, "Delete note"), "end");
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Edit note"), "and round again");
  menu.fire("keydown", { key: "Home" });
  same(document.activeElement, menuItem(root, "Edit note"), "home");
  menu.fire("keydown", { key: "ArrowUp" });
  same(document.activeElement, menuItem(root, "Delete note"), "up from the first is the last");
  menu.fire("keydown", { key: "s" });
  same(document.activeElement, menuItem(root, "Start an action"), "a letter goes to the next item that starts with it");
  menu.fire("keydown", { key: "s" });
  same(document.activeElement, menuItem(root, "Select to group"), "and then the one after");
  menu.fire("keydown", { key: "m" });
  same(document.activeElement, menuItem(root, "Move to top"), "a button of the strip is reached by its name");

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
  one(noteWith(root, "three"), "more").click();
  menuItem(root, "Move up").click();
  assert.deepEqual(sent(), [{ action: "move-card", payload: { cardId: "c3", beforeId: "c2" } }]);
  assert.equal(noteOrder(root, "Went well"), "one three two");
  assert.equal(liveOf(root), "Moved up. Position 2 of 3 in Went well.");

  one(noteWith(root, "one"), "more").click();
  menuItem(root, "Move to\u2026").click();
  menuItem(root, "Puzzles").click();
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
  assert.equal(liveOf(root), "Notes were reordered in Went well. Great idea sticker placed on: one. 1 sticker on that note.");
  assert.equal(box.value, "still typing");
  same(document.activeElement, box, "focus stays in the composer");
});

// ---- most votes, for one reader

const voted = [card("c1", "went-well", "one"), card("c2", "went-well", "two", { voteCount: 2 }), card("c3", "went-well", "three", { voteCount: 1 })];

test("Most votes re-sorts a lane for one reader and sends nothing", () => {
  const { root, push, sent } = load();
  push(session({ cards: three }));
  assert.ok(!button(lane(root, "Went well"), "Top rated"), "nothing to rank by yet");
  push(session({ cards: voted }));
  assert.ok(!button(lane(root, "Puzzles"), "Top rated"), "an empty lane has nothing to sort");
  const toggle = button(lane(root, "Went well"), "Top rated");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(noteOrder(root, "Went well"), "two three one");
  assert.match(lane(root, "Went well").textContent, /Top rated first, only for you: ups less downs\./);
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
  button(lane(root, "Went well"), "Top rated").click();
  noteWith(root, "one").fire("keydown", { key: "ArrowUp", altKey: true });
  assert.match(toastOf(root).textContent, /Sorted by rating\. Show shared order to move notes here\./);
  one(noteWith(root, "one"), "more").click();
  assert.equal(menuItem(root, "Move up").getAttribute("aria-disabled"), "true");
  menuItem(root, "Move up").click();
  assert.deepEqual(sent(), []);
  assert.equal(noteOrder(root, "Went well"), "two three one");
});

test("the facilitator can make the vote order everyone's; a participant is not offered it", () => {
  const lead = load({ host: "new" });
  lead.push(session({ cards: voted }, FACILITATOR));
  button(lane(lead.root, "Went well"), "Top rated").click();
  button(lead.root, "Use this order for everyone").click();
  assert.deepEqual(lead.sent(), [{ action: "order-by-votes", payload: { columnId: "went-well" } }]);
  lead.push(session({ cards: [voted[1], voted[2], voted[0]] }, FACILITATOR));
  assert.equal(button(lane(lead.root, "Went well"), "Top rated").getAttribute("aria-pressed"), "false", "the lens is off: the shared order is now the sorted one");
  assert.equal(noteOrder(lead.root, "Went well"), "two three one");

  const member = load({ host: "new" });
  member.push(session({ cards: voted }, PARTICIPANT));
  button(lane(member.root, "Went well"), "Top rated").click();
  assert.ok(!button(member.root, "Use this order for everyone"));
});

// ---- stickers

const stickersOf = (root, text) => byClass(noteWith(root, text), "st");
const addOf = (root, text) => one(noteWith(root, text), "add-st");
// Where a sticker is drawn: its center, as fractions, 8px inside the note's
// sides and 4px outside its top and bottom.
const AT = (x, y) => ["calc(8px + " + x + " * (100% - 16px))", "calc(" + y + " * (100% + 8px) - 4px)"];
const placeOf = (node) => [node.style.left, node.style.top];
const pileOf = (root, text) => stickersOf(root, text).map((n) => n.getAttribute("aria-label").split(" sticker,")[0]);
const bookOf = (root) => one(root, "book-pop");
// The book, by its key: the menu's row for it is there only on a bare note.
const openBook = (root, text) => {
  noteWith(root, text).fire("keydown", { key: "s", target: one(noteWith(root, text), "note-text") });
};
const st = (id, kind, x, y, cardId = "c1") => ({ id, cardId, kind, x, y, rot: 0 });

test("the book holds fourteen stickers, seven meanings in vinyl and in pixel, each drawn from its own art", () => {
  const { root, push } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  openBook(root, "one");
  const book = bookOf(root);
  assert.equal(book.getAttribute("role"), "dialog");
  assert.equal(book.getAttribute("aria-label"), "Add a sticker to: one");
  const groups = all(book, (n) => n.getAttribute("role") === "group");
  assert.deepEqual(groups.map((g) => g.getAttribute("aria-label")), ["Vinyl stickers", "Pixel stickers"]);
  assert.deepEqual(
    byClass(book, "choice").map((c) => c.getAttribute("aria-label")),
    [
      "Me too, vinyl", "Thank you, vinyl", "Great idea, vinyl", "Quick win, vinyl", "Needs a chat, vinyl", "Blocker, vinyl", "Made me laugh, vinyl",
      "Me too, pixel", "Thank you, pixel", "Great idea, pixel", "Quick win, pixel", "Needs a chat, pixel", "Blocker, pixel", "Made me laugh, pixel",
    ],
  );
  assert.equal(one(book, "spine").getAttribute("aria-hidden"), "true", "the meanings between the sheets are for the eye: every choice says its own");
  assert.match(one(book, "spine").textContent, /1Me too2Thank you3Great idea4Quick win5Needs a chat6Blocker7Made me laugh/);

  const paths = (name) => labeled(book, name).children[0].children[0].children.map((p) => [p.getAttribute("class"), p.getAttribute("d")]);
  const svg = (name) => labeled(book, name).children[0].children[0];
  // Vinyl: the outline four times, then its details.
  const heart = paths("Thank you, vinyl");
  assert.equal(svg("Thank you, vinyl").getAttribute("viewBox"), "3 3 34 34");
  assert.deepEqual(heart.map((p) => p[0]), ["e", "w", "o", "c", "p"]);
  assert.ok(heart.slice(0, 4).every((p) => p[1] === heart[0][1] && p[1].startsWith("M20 33.5C9 26")));
  assert.equal(heart[4][1], "M11.2 15.4a3.4 3.4 0 0 1 2.9-3.6");
  assert.deepEqual(paths("Great idea, vinyl").map((p) => p[0]), ["e", "w", "o", "c", "f", "s"]);

  // Pixel "Me too": seven rows, eleven wide, so it starts one cell in and
  // three down in the box of fourteen. Counted by hand from the art: sixty
  // cells of color, thirteen of paper, none of ink.
  const tag = paths("Me too, pixel");
  assert.equal(svg("Me too, pixel").getAttribute("viewBox"), "0 0 14 14");
  assert.equal(svg("Me too, pixel").getAttribute("shape-rendering"), "crispEdges");
  assert.deepEqual(tag.map((p) => p[0]), ["e", "w", "o", "c", "q"], "an empty fill draws no path");
  const cells = (d) => [...d.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
  const d = Object.fromEntries(tag);
  assert.ok(d.c.startsWith("M2 3h9v1h-9zM1 4h7v1h-7zM9 4h3v1h-3z"), d.c.slice(0, 40));
  assert.ok(d.q.startsWith("M8 4h1v1h-1z"), d.q.slice(0, 20));
  assert.equal(cells(d.c), 60);
  assert.equal(cells(d.q), 13);
  // The ring is the art grown by one cell: its first run lies over the top row.
  assert.ok(d.e.startsWith("M2 2h9v1h-9z"), d.e.slice(0, 20));
  assert.equal(d.e, d.w);
  assert.equal(d.e, d.o);
  // Every row of the laugh is drawn inside the fourteen cells.
  for (const name of ["Made me laugh, pixel", "Blocker, pixel", "Quick win, pixel"]) {
    for (const [, path] of paths(name)) for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) assert.ok(Number(m[1]) + Number(m[3]) <= 14 && Number(m[2]) < 14, name);
  }
  assert.ok(Object.fromEntries(paths("Made me laugh, pixel")).f, "the laugh has ink of its own");
});

test("a sticker is placed from the book, lands clear of the words under focus, and is moved and removed by key", () => {
  const { root, document, push, sent, runTimers } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  push(session({ cards }, PARTICIPANT));
  openBook(root, "one");
  labeled(bookOf(root), "Quick win, pixel").click();
  assert.equal(byClass(root, "book-pop").length, 0, "the book closes");

  const { rot, ...where } = sent()[0].payload;
  const bare = noteWith(root, "one").className;
  assert.equal(sent()[0].action, "stamp");
  // The note cannot be measured here, so it is taken to be 240 by 44. The
  // first spot is on the bottom edge, 14 in: 6 of the 224 a center can
  // travel across, and at the very end of its travel down.
  assert.deepEqual(where, { cardId: "c1", kind: "p-quick-win", x: 0.027, y: 1 });
  assert.ok(Math.abs(rot) <= 9, "the tilt is a small one");

  push(session({ cards, stamps: [{ id: "s1", ...where, rot }] }, PARTICIPANT));
  const sticker = stickersOf(root, "one")[0];
  assert.equal(sticker.getAttribute("aria-label"), "Quick win, pixel sticker, 1 of 1 on this note, counting from the bottom of the pile");
  assert.deepEqual(placeOf(sticker), AT(0.027, 1));
  assert.equal(sticker.className, "st k-quick-win px", "a sticker this viewer placed looks movable");
  // The room a sticker hangs into is the gap every note already has: the
  // note is given no class and no style of its own for having one.
  assert.equal(noteWith(root, "one").className, bare, "a first sticker changes nothing about its note");
  assert.equal(noteWith(root, "one").style.marginTop, undefined);
  same(document.activeElement, sticker, "the sticker just placed has focus, ready for the keys");

  sticker.fire("keydown", { key: "ArrowRight" });
  sticker.fire("keydown", { key: "ArrowRight" });
  // One step is 6px. The center is at 8 + 0.027 * 224 = 14.05; 20.05 is
  // 12.05 / 224 = 0.054, and the next step from there is 0.081.
  assert.deepEqual(placeOf(sticker), AT(0.081, 1), "it moves at once");
  assert.equal(sent().length, 1, "and is not sent until the keys rest");
  runTimers(500);
  assert.deepEqual(sent()[1], { action: "move-stamp", payload: { stampId: "s1", x: 0.081, y: 1 } });
  assert.equal(liveOf(root), "Quick win sticker moved.");

  // With Shift a step is 24px: 8 + 0.081 * 224 + 24 = 50.14, and 42.14 / 224 = 0.188.
  sticker.fire("keydown", { key: "ArrowRight", shiftKey: true });
  assert.deepEqual(placeOf(sticker), AT(0.188, 1));
  runTimers(500);
  assert.deepEqual(sent()[2], { action: "move-stamp", payload: { stampId: "s1", x: 0.188, y: 1 } });

  sticker.fire("keydown", { key: "ArrowDown" });
  assert.equal(liveOf(root), "At the edge of the note.");
  runTimers(500);
  assert.equal(sent().length, 3, "a move that goes nowhere is not sent");

  sticker.fire("keydown", { key: "ArrowUp", altKey: true });
  runTimers(500);
  assert.equal(sent().length, 3, "Alt with an arrow is the note's key, not the sticker's");

  sticker.fire("keydown", { key: "Delete" });
  assert.deepEqual(sent()[3], { action: "remove-stamp", payload: { stampId: "s1" } });
  push(session({ cards }, PARTICIPANT));
  assert.equal(stickersOf(root, "one").length, 0);
  assert.equal(noteWith(root, "one").className, bare);
  same(document.activeElement, addOf(root, "one"), "with the pile empty, focus goes to where a sticker is added");
});

test("stickers land along the bottom edge, each on a spot of its own, and a tall note's first goes in its corner", () => {
  const { root, push, sent } = load();
  const cards = [card("c1", "went-well", "one")];
  const pick = (name) => {
    openBook(root, "one");
    labeled(bookOf(root), name).click();
    const { x, y } = sent().at(-1).payload;
    return [x, y];
  };
  push(session({ cards }));
  // 240 wide: the row runs 14, 44, 74 ... in steps of 30, 4px below the edge.
  assert.deepEqual(pick("Blocker, vinyl"), [0.027, 1]);
  assert.deepEqual(pick("Blocker, pixel"), [0.161, 1], "one still on its way keeps its spot");

  // With the first six spots taken by teammates, the next goes between them: 29px in.
  const row = [0.027, 0.161, 0.295, 0.429, 0.563, 0.696].map((x, i) => st("t" + i, "laugh", x, 1));
  const full = load();
  full.push(session({ cards, stamps: row }));
  openBook(full.root, "one");
  labeled(bookOf(full.root), "Thank you, vinyl").click();
  assert.deepEqual([full.sent()[0].payload.x, full.sent()[0].payload.y], [0.094, 1]);

  // A note 80 tall has room under its handle: 14 in and 10 above the bottom
  // edge, which is 74 of the 88 a center can travel down. The next is on the
  // bottom edge, 50 in.
  const tall = load();
  tall.push(session({ cards }));
  noteWith(tall.root, "one").box = { left: 0, top: 0, width: 240, height: 80 };
  for (const [name, x, y] of [["Me too, vinyl", 0.027, 0.841], ["Me too, pixel", 0.188, 1]]) {
    openBook(tall.root, "one");
    labeled(bookOf(tall.root), name).click();
    assert.deepEqual([tall.sent().at(-1).payload.x, tall.sent().at(-1).payload.y], [x, y]);
  }
});

test("the book counts what is left: three per person on a note, twelve on a note, and then it places nothing", () => {
  const { root, push, sent } = load();
  const cards = [card("c1", "went-well", "one")];
  const stamps = [];
  push(session({ cards }));
  const left = () => one(bookOf(root), "left3");
  for (let i = 0; i < 3; i++) {
    addOf(root, "one").click();
    assert.equal(left().textContent, 3 - i + " of 3 left on this note");
    assert.equal(byClass(left(), "have").length, 3 - i, "one pip for each");
    bookOf(root).fire("keydown", { key: "1" });
    stamps.push({ id: "s" + i, ...sent()[i].payload });
    push(session({ cards, stamps }));
  }
  assert.equal(addOf(root, "one").hidden, true, "the plus goes once the viewer has placed three");
  openBook(root, "one");
  assert.equal(left().textContent, "0 of 3 left on this note");
  assert.match(bookOf(root).textContent, /You have placed your three on this note\./);
  assert.ok(byClass(bookOf(root), "choice").every((c) => c.disabled));
  bookOf(root).fire("keydown", { key: "1" });
  labeled(bookOf(root), "Blocker, pixel").click();
  assert.equal(sent().length, 3, "nothing more is sent");

  // Twelve on the note, none of them this viewer's.
  const other = load();
  const twelve = Array.from({ length: 12 }, (_, i) => st("t" + i, i % 2 ? "p-chat" : "chat", i / 12, 0));
  other.push(session({ cards, stamps: twelve.slice(0, 11) }));
  assert.equal(addOf(other.root, "one").hidden, false);
  other.push(session({ cards, stamps: twelve }));
  assert.equal(addOf(other.root, "one").hidden, true, "and at twelve on the note");
  openBook(other.root, "one");
  assert.doesNotMatch(bookOf(other.root).textContent, /of 3 left/, "whose those twelve are is not known, so no number is claimed");
  assert.match(bookOf(other.root).textContent, /Up to 3 of yours on a note/);
  assert.match(bookOf(other.root).textContent, /This note is full: twelve stickers\./);
  bookOf(other.root).fire("keydown", { key: "5" });
  assert.deepEqual(other.sent(), []);
});

test("in the book the keys 1 to 7 place from the marked sheet, V and P and Up, Down and Tab change sheets, and the sheet is remembered", () => {
  const { root, document, push, sent, press } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two")];
  push(session({ cards }, PARTICIPANT));
  const key = (k) => bookOf(root).fire("keydown", { key: k });
  const marked = () => byClass(bookOf(root), "leaf").filter((l) => l.className.includes("active")).map((l) => l.getAttribute("aria-label")).join();
  const focused = () => document.activeElement.getAttribute("aria-label");

  const plus = addOf(root, "one");
  assert.equal(plus.getAttribute("aria-label"), "Add a sticker to: one");
  assert.equal(plus.getAttribute("aria-haspopup"), "dialog");
  plus.click();
  assert.equal(plus.getAttribute("aria-expanded"), "true");
  assert.equal(marked(), "Vinyl stickers", "vinyl first");
  assert.equal(focused(), "Me too, vinyl");
  key("ArrowRight");
  key("ArrowRight");
  assert.equal(focused(), "Great idea, vinyl");
  key("ArrowLeft");
  assert.equal(focused(), "Thank you, vinyl");
  key("ArrowDown");
  assert.equal(focused(), "Thank you, pixel", "down changes sheet and keeps the column");
  assert.equal(marked(), "Pixel stickers");
  key("Tab");
  assert.equal(focused(), "Thank you, vinyl", "Tab goes between the sheets, not out of the book");
  key("P");
  assert.equal(focused(), "Thank you, pixel");
  key("ArrowLeft");
  key("ArrowLeft");
  assert.equal(focused(), "Made me laugh, pixel", "and round");
  key("v");
  assert.equal(focused(), "Made me laugh, vinyl");
  assert.deepEqual(sent(), [], "going about the book places nothing");
  key("3");
  assert.equal(sent()[0].payload.kind, "idea", "3 on the vinyl sheet");
  assert.equal(byClass(root, "book-pop").length, 0);
  same(document.activeElement, plus, "focus is back on the plus until the sticker lands");

  plus.click();
  key("p");
  key("4");
  assert.equal(sent()[1].payload.kind, "p-quick-win", "4 on the pixel sheet");

  // Another note, later in the visit: the pixel sheet is still the marked one.
  addOf(root, "two").click();
  assert.equal(marked(), "Pixel stickers");
  assert.equal(focused(), "Me too, pixel");
  key("7");
  assert.deepEqual([sent()[2].payload.cardId, sent()[2].payload.kind], ["c2", "p-laugh"]);

  addOf(root, "two").click();
  for (const k of ["8", "0", "x", "Enter"]) key(k);
  bookOf(root).fire("keydown", { key: "1", ctrlKey: true });
  assert.equal(sent().length, 3, "no other key places anything");
  press("Escape");
  assert.equal(byClass(root, "book-pop").length, 0);
  same(document.activeElement, addOf(root, "two"), "Escape hands focus back to the plus");
  assert.equal(byClass(root, "scrim").length, 0, "and the scrim goes with the book");
});

test("S on a note opens the book, but not from one of its stickers and not as part of a chord", () => {
  const { root, push } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("s1", "idea", 0.5, 0.5)] }, FACILITATOR));
  const note = noteWith(root, "one");
  note.fire("keydown", { key: "s", ctrlKey: true });
  note.fire("keydown", { key: "s", metaKey: true });
  note.fire("keydown", { key: "s", target: stickersOf(root, "one")[0] });
  assert.equal(byClass(root, "book-pop").length, 0);
  note.fire("keydown", { key: "S" });
  assert.equal(byClass(root, "book-pop").length, 1);
  assert.equal(addOf(root, "one").getAttribute("aria-expanded"), "true", "it hangs from the plus");
});

test("the pile is the order of the state, bottom to top, and what this viewer moves goes on top at once", () => {
  const { root, push, sent, fireWindow } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  const a = st("s1", "idea", 0.5, 0.5);
  const b = st("s2", "p-laugh", 0.5, 0.5);
  const c = st("s3", "chat", 0.5, 0.5);
  push(session({ cards, stamps: [a, b, c] }, FACILITATOR));
  assert.deepEqual(pileOf(root, "one"), ["Great idea, vinyl", "Made me laugh, pixel", "Needs a chat, vinyl"]);
  assert.match(stickersOf(root, "one")[2].getAttribute("aria-label"), /3 of 3 on this note, counting from the bottom of the pile$/);

  // A teammate moved the first: the server put it at the end, and so is it drawn.
  push(session({ cards, stamps: [b, c, { ...a, x: 0.6 }] }, FACILITATOR));
  assert.deepEqual(pileOf(root, "one"), ["Made me laugh, pixel", "Needs a chat, vinyl", "Great idea, vinyl"]);
  assert.equal(liveOf(root), "Great idea sticker moved.");

  // Dragged a little and let go, the bottom one is on top before the server has said anything.
  const bottom = stickersOf(root, "one")[0];
  bottom.fire("pointerdown", { clientX: 120, clientY: 22 });
  fireWindow("pointermove", { clientX: 130, clientY: 22 });
  fireWindow("pointerup", { clientX: 130, clientY: 22 });
  assert.deepEqual(pileOf(root, "one"), ["Needs a chat, vinyl", "Great idea, vinyl", "Made me laugh, pixel"]);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].action, "moderate-stamp");
});

test("a sticker is dragged anywhere on its note, held where it was taken hold of, and stops at the limits", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("s9", "chat", 0.5, 0.5)] }, FACILITATOR));
  // The note is 240 by 44 at 100, 200. A center travels 224 across, from 8
  // inside the left edge, and 52 down, from 4 above the top edge: at a half
  // and a half it is at 120, 22 on the note, 220, 222 on the page.
  noteWith(ui.root, "one").box = { left: 100, top: 200, width: 240, height: 44 };
  const sticker = stickersOf(ui.root, "one")[0];
  const drag = (from, to) => {
    sticker.fire("pointerdown", { clientX: from[0], clientY: from[1] });
    ui.fireWindow("pointermove", { clientX: to[0], clientY: to[1] });
    assert.ok(sticker.className.includes("lift"));
    const sentBefore = ui.sent().length;
    ui.fireWindow("pointerup", { clientX: to[0], clientY: to[1] });
    assert.equal(ui.sent().length, sentBefore + 1, "sent once, when it is let go");
    assert.ok(!sticker.className.includes("lift"));
    const { x, y } = ui.sent().at(-1).payload;
    ui.push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("s9", "chat", x, y)] }, FACILITATOR));
    ui.runTimers(0);
    return [x, y];
  };
  // To 164, 235 on the page: 56 of 224 across and 39 of 52 down.
  assert.deepEqual(drag([220, 222], [164, 235]), [0.25, 0.75]);
  assert.deepEqual(placeOf(sticker), AT(0.25, 0.75));
  // Taken hold of 5 right and 3 below its center, and carried by that point:
  // the center goes to 220, 222 again, not to the pointer.
  assert.deepEqual(drag([169, 238], [225, 225]), [0.5, 0.5]);
  // Far past the top-left corner, and far past the bottom-right one.
  assert.deepEqual(drag([220, 222], [-400, -400]), [0, 0]);
  assert.deepEqual(placeOf(sticker), AT(0, 0));
  assert.deepEqual(drag([108, 196], [2000, 2000]), [1, 1]);
  assert.deepEqual(placeOf(sticker), AT(1, 1));
  assert.equal(liveOf(ui.root), "Needs a chat sticker moved.");

  // A press that barely moves is a click, and a canceled drag puts it back.
  sticker.fire("pointerdown", { clientX: 332, clientY: 248 });
  ui.fireWindow("pointermove", { clientX: 333, clientY: 249 });
  ui.fireWindow("pointerup", { clientX: 333, clientY: 249 });
  sticker.fire("pointerdown", { clientX: 332, clientY: 248 });
  ui.fireWindow("pointermove", { clientX: 200, clientY: 220 });
  ui.press("Escape");
  assert.deepEqual(placeOf(sticker), AT(1, 1));
  assert.equal(ui.sent().length, 4, "neither sent anything");
});

test("a sticker removed while it is dragged, or while its keys are still resting, is let go without a word to the server", () => {
  const cards = [card("c1", "went-well", "one")];
  const state = { cards, stamps: [st("s1", "blocker", 0.5, 0.5)] };
  const ui = load({ host: "new" });
  ui.push(session(state, FACILITATOR));
  const sticker = stickersOf(ui.root, "one")[0];
  sticker.fire("pointerdown", { clientX: 120, clientY: 22 });
  ui.fireWindow("pointermove", { clientX: 150, clientY: 22 });
  ui.push(session({ cards }, FACILITATOR));
  ui.fireWindow("pointermove", { clientX: 160, clientY: 22 });
  ui.fireWindow("pointerup", { clientX: 160, clientY: 22 });
  assert.deepEqual(ui.sent(), [], "no move");
  assert.equal(toastOf(ui.root).textContent, "That sticker is no longer on the board.");

  const keyed = load({ host: "new" });
  keyed.push(session(state, FACILITATOR));
  stickersOf(keyed.root, "one")[0].fire("keydown", { key: "ArrowRight" });
  keyed.push(session({ cards }, FACILITATOR));
  keyed.runTimers(500);
  assert.deepEqual(keyed.sent(), []);
});

test("stickers lying over a note's words are marked, and step back while the words are pointed at", () => {
  const { root, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  push(session({ cards }, PARTICIPANT));
  const note = noteWith(root, "one");
  const words = one(note, "note-text");
  // The note is 240 by 60. Its words are drawn from 40 to 190 across and,
  // inside the paragraph's 6px of padding, from 11 to 31 down.
  note.box = { left: 0, top: 0, width: 240, height: 60 };
  words.box = { left: 40, top: 5, width: 150, height: 32 };
  // Centers: 120, 23 (on the words); 8, 23 (17 across reaches 25, short of
  // the words); 120, 64 (17 up reaches 47, below them); 204, 23 (reaches
  // back to 187, three inside the words' right edge).
  push(session({ cards, stamps: [st("s1", "idea", 0.5, 0.4), st("s2", "p-idea", 0, 0.4), st("s3", "thanks", 0.5, 1), st("s4", "p-thanks", 0.875, 0.4)] }, PARTICIPANT));
  assert.deepEqual(stickersOf(root, "one").map((n) => n.className.includes("over")), [true, false, false, true]);

  assert.ok(!note.className.includes("peek"));
  words.fire("pointerenter", { pointerType: "mouse" });
  assert.ok(note.className.includes("peek"), "pointing at the words thins the stickers over them");
  words.fire("pointerleave", { pointerType: "mouse" });
  assert.ok(!note.className.includes("peek"));
  words.fire("pointerenter", { pointerType: "touch" });
  assert.ok(!note.className.includes("peek"), "a finger passing over is not pointing");
  words.fire("pointerup", { pointerType: "touch" });
  assert.ok(note.className.includes("peek"), "a tap on the words does it on touch");
  words.fire("pointerup", { pointerType: "touch" });
  assert.ok(!note.className.includes("peek"), "and a second tap puts them back");
  words.fire("pointerup", { pointerType: "mouse" });
  assert.ok(!note.className.includes("peek"), "a mouse click is not a tap");
  // The words under a sticker are pointed at by pointing at the sticker:
  // one that lies on the words peeks the note, one that does not does not.
  const [onWords, offWords] = stickersOf(root, "one");
  onWords.fire("pointerenter", { pointerType: "mouse" });
  assert.ok(note.className.includes("peek"), "pointing at a sticker over the words shows the words");
  onWords.fire("pointerleave", { pointerType: "mouse" });
  assert.ok(!note.className.includes("peek"));
  offWords.fire("pointerenter", { pointerType: "mouse" });
  assert.ok(!note.className.includes("peek"), "a sticker beside the words is only a sticker");
  onWords.fire("pointerenter", { pointerType: "touch" });
  assert.ok(!note.className.includes("peek"));
  assert.equal(words.textContent, "one", "the words themselves are never taken away");
  // The rule that thins them, and the one for a control in the note holding focus.
  assert.match(src, /\.note\.peek \.st\.over:not\(\.lift\):not\(:focus-visible\),\.note:has\(\.lead :focus-visible,\.trail :focus-visible,\.chips :focus-visible,\.rx :focus-visible\) \.st\.over\{opacity:\.2/);
});

test("a sticker is announced by what it is and how many there are, never by who or by which set", () => {
  const { root, push } = load({ host: "new" });
  // The note ends with a full stop of its own, which is not said twice.
  const cards = [card("c1", "went-well", "Flaky.", { authorId: "u-cy" })];
  const say = (stamps) => {
    push(session({ revealed: true, cards, stamps }, PARTICIPANT));
    return liveOf(root);
  };
  say([]);
  assert.equal(say([st("s1", "blocker", 0.5, 0.5)]), "Blocker sticker placed on: Flaky. 1 sticker on that note.");
  assert.equal(say([st("s1", "blocker", 0.5, 0.5), st("s2", "p-thanks", 0.5, 0.5)]), "Thank you sticker placed on: Flaky. 2 stickers on that note.");
  assert.equal(say([st("s2", "p-thanks", 0.5, 0.5), st("s1", "blocker", 0.7, 0.5)]), "Blocker sticker moved.");
  assert.equal(say([st("s1", "blocker", 0.7, 0.5), st("s2", "p-thanks", 0.5, 0.5)]), "Thank you sticker brought to the front.");
  assert.equal(say([st("s2", "p-thanks", 0.5, 0.5)]), "Blocker sticker removed from: Flaky. 1 sticker on that note.");
  assert.equal(say([st("s3", "idea", 0.1, 0.1), st("s4", "p-idea", 0.2, 0.2)]), "Stickers changed on the board.");
  assert.equal(say([st("s3", "idea", 0.1, 0.1), st("s4", "p-idea", 0.2, 0.2)]), "", "nothing changed, nothing said");
  for (const sticker of stickersOf(root, "Flaky")) assert.doesNotMatch(sticker.getAttribute("aria-label"), /Alice|Reyes|Park|yours|mine/i);
  assert.doesNotMatch(src, /\b[Ss]tamps? (pressed|moved|removed)|a stamp\b|Stamps on|Add a stamp/, "the board says sticker everywhere");
});

const others = { cards: [card("c1", "went-well", "one")], stamps: [st("s9", "chat", 0.5, 0.5)] };

test("a sticker not known to be the viewer's does not look movable, does not come along, and says why", () => {
  const { root, push, sent, runTimers, fireWindow } = load({ host: "new" });
  push(session(others, PARTICIPANT));
  const sticker = stickersOf(root, "one")[0];
  assert.ok(sticker.className.split(" ").includes("fixed"), "no grab cursor, no lift on hover");

  sticker.fire("pointerdown", { clientX: 120, clientY: 22 });
  fireWindow("pointermove", { clientX: 180, clientY: 30 });
  assert.ok(!sticker.className.includes("lift"), "a drag does not carry it");
  const why = "You can move a sticker you placed in this visit. Open an older one of yours to remove it.";
  assert.equal(toastOf(root).textContent, why, "and the pull says why, as the keys do");
  toastOf(root).text = "";
  fireWindow("pointermove", { clientX: 190, clientY: 40 });
  fireWindow("pointermove", { clientX: 200, clientY: 50 });
  assert.equal(toastOf(root).textContent, "", "once, not at every move");
  fireWindow("pointerup", { clientX: 200, clientY: 50 });
  assert.deepEqual(placeOf(sticker), AT(0.5, 0.5));
  sticker.click();
  assert.equal(byClass(root, "menu").length, 0, "the release of that pull is not a click");
  runTimers(0);
  // A press that does not pull says nothing.
  toastOf(root).hidden = true;
  sticker.fire("pointerdown", { clientX: 120, clientY: 22 });
  fireWindow("pointermove", { clientX: 121, clientY: 22 });
  fireWindow("pointerup", { clientX: 121, clientY: 22 });
  assert.equal(toastOf(root).hidden, true);

  for (const key of ["ArrowLeft", "f"]) {
    sticker.fire("keydown", { key });
    runTimers(500);
    assert.deepEqual(placeOf(sticker), AT(0.5, 0.5));
    assert.equal(toastOf(root).textContent, "You can move a sticker you placed in this visit. Open an older one of yours to remove it.");
  }
  assert.deepEqual(sent(), [], "nothing is asked of the server");

  sticker.click();
  const menu = one(root, "menu");
  assert.equal(menu.getAttribute("aria-label"), "Needs a chat, vinyl sticker");
  assert.deepEqual(all(root, (n) => n.getAttribute("role") === "menuitem").map((n) => n.children[0].textContent), ["Remove, if you placed it"]);
  assert.match(menu.textContent, /You can move a sticker you placed in this visit\./);
});

test("removing a sticker is the server's to refuse, once: the answer is remembered", async () => {
  const { root, push, acts } = load({ host: "new" });
  push(session(others, PARTICIPANT));
  const sticker = stickersOf(root, "one")[0];
  sticker.click();
  menuItem(root, "Remove, if you placed it").click();
  assert.deepEqual(acts.map((a) => a.action), ["remove-stamp"], "after a reload the board does not know whose it is; the server does");
  acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(root).textContent, "Only the person who placed a sticker, or the facilitator, can move or remove it.");

  sticker.fire("keydown", { key: "Delete" });
  sticker.click();
  assert.equal(menuItem(root, "Remove sticker").getAttribute("aria-disabled"), "true");
  assert.match(one(root, "menu").textContent, /Only the person who placed a sticker, or the facilitator, can move or remove it\./);
  menuItem(root, "Remove sticker").click();
  assert.equal(acts.length, 1, "it is not asked again");
});

test("the facilitator moves and removes any sticker, through the action kept for the facilitator", () => {
  const { root, push, sent, runTimers } = load({ host: "new" });
  push(session(others, FACILITATOR));
  const sticker = stickersOf(root, "one")[0];
  assert.ok(!sticker.className.includes("fixed"));
  sticker.fire("keydown", { key: "ArrowDown" });
  runTimers(500);
  // One step is 6 of the 52 a center travels down a note 44 high: the center
  // is at 22, and 28 + 4 over 52 is 0.615.
  assert.deepEqual(sent()[0], { action: "moderate-stamp", payload: { stampId: "s9", x: 0.5, y: 0.615 } });
  sticker.click();
  assert.deepEqual(all(root, (n) => n.getAttribute("role") === "menuitem").map((n) => n.textContent), ["Bring to frontF", "Move with the arrow keysArrows", "Remove stickerDelete"]);
  menuItem(root, "Remove sticker").click();
  assert.deepEqual(sent()[1], { action: "moderate-stamp", payload: { stampId: "s9", remove: true } });
});

test("a sticker is brought to the front by F or from its menu: a move to where it is, on top at once, and back if it is refused", async () => {
  const cards = [card("c1", "went-well", "one")];
  const pile = [st("s1", "idea", 0.2, 0.5), st("s2", "p-laugh", 0.25, 0.5), st("s3", "chat", 0.3, 0.5)];
  const ui = load({ host: "new" });
  ui.push(session({ cards, stamps: pile }, FACILITATOR));
  const [bottom, middle] = stickersOf(ui.root, "one");
  bottom.focus();
  bottom.fire("keydown", { key: "f" });
  assert.deepEqual(ui.sent(), [{ action: "moderate-stamp", payload: { stampId: "s1", x: 0.2, y: 0.5 } }]);
  assert.deepEqual(pileOf(ui.root, "one"), ["Made me laugh, pixel", "Needs a chat, vinyl", "Great idea, vinyl"], "on top before the server answers");
  assert.equal(liveOf(ui.root), "Great idea sticker brought to the front.");
  same(ui.document.activeElement, bottom, "and focus stays on it");
  assert.deepEqual(placeOf(bottom), AT(0.2, 0.5), "it has not moved");

  bottom.fire("keydown", { key: "F" });
  assert.equal(ui.sent().length, 1, "already there: nothing more is sent");
  assert.equal(liveOf(ui.root), "Already at the front.");

  ui.push(session({ cards, stamps: [pile[1], pile[2], pile[0]] }, FACILITATOR));
  assert.deepEqual(pileOf(ui.root, "one"), ["Made me laugh, pixel", "Needs a chat, vinyl", "Great idea, vinyl"]);
  ui.runTimers(WAIT);
  assert.equal(toastOf(ui.root).hidden, true, "the state showed it: nothing is in doubt");

  middle.click();
  menuItem(ui.root, "Bring to front").click();
  assert.deepEqual(ui.sent()[1], { action: "moderate-stamp", payload: { stampId: "s2", x: 0.25, y: 0.5 } });
  assert.deepEqual(pileOf(ui.root, "one"), ["Needs a chat, vinyl", "Great idea, vinyl", "Made me laugh, pixel"]);
  ui.acts[1].answer({ ok: false, reason: "failed" });
  await settled();
  assert.deepEqual(pileOf(ui.root, "one"), ["Made me laugh, pixel", "Needs a chat, vinyl", "Great idea, vinyl"], "refused: the pile is the server's again");

  // A participant asks as themselves.
  const member = load({ host: "new" });
  member.push(session({ cards }, PARTICIPANT));
  addOf(member.root, "one").click();
  bookOf(member.root).fire("keydown", { key: "2" });
  const mine = { id: "s7", ...member.sent()[0].payload };
  member.push(session({ cards, stamps: [mine, st("s8", "p-chat", 0.5, 0.5)] }, PARTICIPANT));
  stickersOf(member.root, "one")[0].fire("keydown", { key: "f" });
  assert.deepEqual(member.sent()[1], { action: "move-stamp", payload: { stampId: "s7", x: mine.x, y: mine.y } });
});

test("a note's stickers are one Tab stop, the one on top, and Page Up and Page Down walk the pile without moving anything", () => {
  const { root, document, push, sent } = load({ host: "new" });
  const stamps = ["idea", "p-laugh", "chat"].map((kind, i) => st("s" + i, kind, 0.5, 0.5));
  push(session({ cards: [card("c1", "went-well", "one")], stamps }, PARTICIPANT));
  const [bottom, middle, top] = stickersOf(root, "one");
  const stops = () => stickersOf(root, "one").map((n) => n.getAttribute("tabindex")).join(" ");
  assert.equal(stops(), "-1 -1 0", "Tab lands on the one that can be seen");
  top.focus();
  top.fire("keydown", { key: "PageDown" });
  same(document.activeElement, middle, "down the pile, to the one underneath");
  middle.fire("focus");
  assert.equal(stops(), "-1 0 -1", "and Tab comes back to the one that was left");
  middle.fire("keydown", { key: "PageDown" });
  same(document.activeElement, bottom);
  bottom.fire("keydown", { key: "PageDown" });
  same(document.activeElement, bottom, "no further than the bottom");
  assert.equal(liveOf(root), "Bottom of the pile.");
  bottom.fire("keydown", { key: "End" });
  same(document.activeElement, top);
  top.fire("keydown", { key: "PageUp" });
  assert.equal(liveOf(root), "Top of the pile.");
  top.fire("keydown", { key: "Home" });
  same(document.activeElement, bottom);
  bottom.fire("keydown", { key: "PageUp" });
  same(document.activeElement, middle);
  assert.deepEqual(sent(), [], "walking the pile moves none of them");
  assert.match(all(root, (n) => n.getAttribute("id") === "stamp-help")[0].textContent, /The arrow keys move this sticker, with Shift for bigger steps\. Page Up and Page Down go up and down the pile\. F brings it to the front\. Delete removes it\./);
  assert.equal(top.getAttribute("aria-describedby"), "stamp-help");
});

test("focus on a sticker that is removed goes to the next one down the pile", () => {
  const { root, document, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  const stamps = ["idea", "p-laugh", "chat"].map((kind, i) => st("s" + i, kind, 0.5, 0.5));
  push(session({ cards, stamps }, FACILITATOR));
  const [bottom, middle] = stickersOf(root, "one");
  middle.focus();
  push(session({ cards, stamps: [stamps[0], stamps[2]] }, FACILITATOR));
  same(document.activeElement, bottom, "the one that was under it");
  push(session({ cards, stamps: [stamps[2]] }, FACILITATOR));
  same(document.activeElement, stickersOf(root, "one")[0], "from the bottom, the one now there");
});

test("every sticker on a note can be reached from the note's menu, without aiming at it", () => {
  const { root, document, push, sent } = load({ host: "new" });
  const stamps = [st("s1", "p-idea", 0.5, 0.5), st("s2", "laugh", 0.5, 0.5)];
  push(session({ cards: [card("c1", "went-well", "one")], stamps }, FACILITATOR));
  const list = () => {
    one(noteWith(root, "one"), "more").click();
    menuItem(root, "Stickers (2)").click();
    return one(root, "sheet");
  };
  assert.equal(list().getAttribute("aria-label"), "Stickers on: one");
  assert.match(one(root, "sheet").textContent, /Stickers on this note/);
  assert.match(one(root, "sheet").textContent, /Bottom of the pile first\./);
  labeled(root, "Move Made me laugh, vinyl sticker, 2 of 2").click();
  same(document.activeElement, stickersOf(root, "one")[1], "Move puts focus on that sticker, for the keys");
  assert.match(liveOf(root), /^Made me laugh, vinyl sticker, 2 of 2\. The arrow keys move this sticker/);

  list();
  labeled(root, "Bring to front Great idea, pixel sticker, 1 of 2").click();
  assert.deepEqual(sent(), [{ action: "moderate-stamp", payload: { stampId: "s1", x: 0.5, y: 0.5 } }]);
  assert.deepEqual(pileOf(root, "one"), ["Made me laugh, vinyl", "Great idea, pixel"], "the one underneath is on top");

  list();
  labeled(root, "Remove Made me laugh, vinyl sticker, 1 of 2").click();
  assert.deepEqual(sent()[1], { action: "moderate-stamp", payload: { stampId: "s2", remove: true } });

  const member = load({ host: "new" });
  member.push(session({ cards: [card("c1", "went-well", "one")], stamps }, PARTICIPANT));
  one(noteWith(member.root, "one"), "more").click();
  menuItem(member.root, "Stickers (2)").click();
  assert.ok(!labeled(member.root, "Move Made me laugh"), "Move is not offered for a sticker that may be somebody else's");
  assert.ok(!labeled(member.root, "Bring to front"), "nor is the front");
  assert.ok(labeled(member.root, "Remove Made me laugh, vinyl sticker, 2 of 2"));
  assert.match(one(member.root, "sheet").textContent, /You can move ones you placed in this visit, and remove yours\./);
});

test("a sticker of a kind this version does not know is drawn plain, named, counted and removable; one off the note is brought back onto it", () => {
  const { root, push, sent } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  push(
    session(
      {
        cards,
        stamps: [
          { id: "s1", cardId: "c1", kind: "<img>", x: 0.5, y: 0.5 },
          { id: "s2", cardId: "c1", kind: "p-idea", x: 7, y: -3, rot: "x" },
          { id: "s3", cardId: "c404", kind: "idea", x: 0.5, y: 0.5 },
          { id: "s4", cardId: "c1", kind: "p-sparkle", x: 0.2, y: 0.5 },
          { id: "s5", cardId: "c1", kind: "constructor", x: 0.3, y: 0.5 },
          { id: "s6", cardId: "c1", kind: 7, x: 0.3, y: 0.5 },
          null,
        ],
      },
      PARTICIPANT,
    ),
  );
  const drawn = stickersOf(root, "one");
  assert.deepEqual(drawn.map((n) => n.getAttribute("aria-label").split(" on this")[0]), ["Sticker, 1 of 4", "Great idea, pixel sticker, 2 of 4", "Sticker, 3 of 4", "Sticker, 4 of 4"]);
  assert.deepEqual(drawn.map((n) => n.className.includes("k-other")), [true, false, true, true]);
  assert.deepEqual(placeOf(drawn[1]), AT(1, 0));
  assert.equal(all(root, (n) => n.tagName === "IMG").length, 0);
  // It counts: with these four the book has eight places left to give, not twelve.
  openBook(root, "one");
  assert.match(bookOf(root).textContent, /Up to 3 of yours on a note/);
  // Its menu opens, and whoever placed it can take it off.
  drawn[0].click();
  assert.equal(one(root, "menu").getAttribute("aria-label"), "Sticker");
  menuItem(root, "Remove, if you placed it").click();
  assert.deepEqual(sent(), [{ action: "remove-stamp", payload: { stampId: "s1" } }]);
  push(session({ cards, stamps: [{ id: "s4", cardId: "c1", kind: "p-sparkle", x: 0.2, y: 0.5 }] }, PARTICIPANT));
  assert.match(liveOf(root), /^Stickers changed on the board\.$/);
  push(session({ cards, stamps: [] }, PARTICIPANT));
  assert.equal(liveOf(root), "Sticker removed from: one. 0 stickers on that note.");
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
  same(document.activeElement, one(noteWith(root, "one"), "more"), "the chip goes to its note");
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
const place = (root, texts, left = 0) => texts.forEach((text, i) => (noteWith(root, text).box = { left, top: 100 + 50 * i, width: 240, height: 44 }));
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

  // The notes stand at 100, 150 and 200, each 44 high. Carried to 110, the
  // third is over the top quarter of the first, so it goes in front of it.
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

test("a note in a lane sorted by votes can be lifted, but a drop inside that lane moves nothing and says why", () => {
  const ui = load();
  ui.push(session({ cards: voted }));
  button(lane(ui.root, "Went well"), "Top rated").click();
  carry(ui, "one", 110);
  assert.equal(byClass(ui.root, "drag").length, 1, "it can still be carried to another lane");
  assert.equal(liveOf(ui.root), "Sorted by rating. Show shared order to move notes here.");
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), []);
  assert.equal(toastOf(ui.root).textContent, "Sorted by rating. Show shared order to move notes here.");
  assert.equal(noteOrder(ui.root, "Went well"), "two three one");
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
    const grip = one(noteWith(ui.root, "two"), "more");
    grip.click();
    assert.equal(inert(ui.root), "true true", name);
    leave(ui, grip);
    assert.equal(byClass(ui.root, "pop").length, 0, name);
    assert.equal(inert(ui.root), "false false", name);
  }

  // One popover opened from another: inert throughout, and given back at the end.
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "more").click();
  menuItem(ui.root, "Delete note").click();
  assert.equal(inert(ui.root), "true true");
  button(ui.root, "Keep it").click();
  assert.equal(inert(ui.root), "false false");
});

test("a popover whose note a teammate deletes is closed, and says why", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  one(noteWith(ui.root, "two"), "more").click();
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
  assert.equal(byClass(ui.root, "st").length, 5, "every one is drawn, the four of no known kind as plain stickers");
  assert.equal(byClass(ui.root, "k-other").length, 4);
  assert.doesNotMatch(ui.root.textContent, /undefined/);
  assert.equal(byClass(one(ui.root, "action"), "src").length, 3, "four sources: two chips and the rest");

  noteWith(ui.root, "note __proto__").fire("keydown", { key: "u", target: one(noteWith(ui.root, "note __proto__"), "note-text") });
  assert.deepEqual(ui.sent(), [{ action: "vote", payload: { cardId: "__proto__", value: "up" } }]);
  ui.acts[0].answer({ ok: false, reason: "constructor" });
  ui.push(session({ cards: [] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "note").length, 0);
  assert.equal({}.lanes, undefined);
});

// ---- deleting

test("deleting a note is asked about, with focus on the way out, and sent as the viewer's own request", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const grip = one(noteWith(ui.root, "two"), "more");
  grip.click();
  menuItem(ui.root, "Delete note").click();
  const sheet = one(ui.root, "sheet");
  assert.equal(sheet.getAttribute("role"), "alertdialog");
  assert.equal(sheet.getAttribute("aria-label"), "Delete this note?");
  assert.match(sheet.textContent, /Its votes, stickers and links to actions go with it\. This cannot be undone\./);
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
  one(noteWith(lead.root, "two"), "more").click();
  menuItem(lead.root, "Delete note").click();
  button(one(lead.root, "sheet"), "Delete note").click();
  assert.deepEqual(lead.sent(), [{ action: "moderate-card", payload: { cardId: "c2" } }]);
});

test("a delete the bridge will not carry is refused at once and leaves the note", async () => {
  for (const fail of ["throw", "reject"]) {
    const ui = load({ host: "new" });
    ui.push(session({ cards: three }, PARTICIPANT));
    ui.bridge.fail = fail;
    one(noteWith(ui.root, "two"), "more").click();
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
  same(ui.document.activeElement, one(noteWith(ui.root, "three"), "more"));

  ui.push(session({ cards: [] }, PARTICIPANT));
  assert.equal(liveOf(ui.root), "2 notes were removed.");
  same(ui.document.activeElement, composer(ui.root, "Went well"), "with the lane empty, focus goes to its composer");
});

test("once authors are revealed, Delete says whose a note is instead of asking the server", () => {
  const ui = load({ host: "new" });
  ui.push(session({ revealed: true, cards: [card("c1", "went-well", "mine", { authorId: "u-bo" }), card("c2", "went-well", "hers", { authorId: "u-cy" })] }, PARTICIPANT));
  one(noteWith(ui.root, "hers"), "more").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), "true");
  menuItem(ui.root, "Delete note").click();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note, or the facilitator, can delete it.");
  assert.equal(byClass(ui.root, "sheet").length, 0);
  ui.press("Escape");
  one(noteWith(ui.root, "mine"), "more").click();
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
  one(noteWith(ui.root, "one"), "more").click();
  menuItem(ui.root, "Add a sticker").click();
  labeled(ui.root, "Blocker, vinyl").click();
  ui.acts[0].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.equal(
    toastOf(ui.root).textContent,
    "That sticker was not placed. A note holds twelve stickers, three per person. If that is not it, this organization's storage for the plugin is full: delete notes or actions, or ask an admin.",
  );

  const input = composer(ui.root, "Went well");
  input.type("one more");
  input.fire("keydown", ENTER);
  ui.acts[1].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.match(toastOf(ui.root).textContent, /^That note was not saved\. A board holds 120 notes, 30 from each person\. If that is not it, this organization's storage for the plugin is full/);

  // A change with no limit of its own: the store being full is the likely reason.
  one(noteWith(ui.root, "one"), "more").click();
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
    name: "a sticker move",
    who: FACILITATOR,
    make: (ui) => {
      stickersOf(ui.root, "one")[0].fire("keydown", { key: "ArrowRight" });
      ui.runTimers(500);
    },
    action: "moderate-stamp",
    // One step from the middle of a note 240 wide: 126 - 8 over 224 is 0.527.
    drawnAhead: (ui) => stickersOf(ui.root, "one")[0].style.left === AT(0.527, 0.5)[0],
    back: (ui) => stickersOf(ui.root, "one")[0].style.left === AT(0.5, 0.5)[0],
    said: /Could not confirm that the sticker moved\./,
  },
  {
    name: "a sticker removal",
    who: PARTICIPANT,
    make: (ui) => stickersOf(ui.root, "one")[0].fire("keydown", { key: "Delete" }),
    action: "remove-stamp",
    drawnAhead: (ui) => stickersOf(ui.root, "one").length === 1,
    back: (ui) => stickersOf(ui.root, "one").length === 1 && stickersOf(ui.root, "one")[0].className.split(" ").includes("fixed"),
    said: /Could not confirm that the sticker was removed\./,
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
      one(noteWith(ui.root, "two"), "more").click();
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

test("a sticker is the viewer's once the server said yes and the state shows it, in either order, and not before", async () => {
  const moved = { ...others9, stamps: [{ ...others9.stamps[0], x: 0.6 }] };
  const mine = (ui) => !stickersOf(ui.root, "one")[0].className.split(" ").includes("fixed");
  // Removing is the one change a participant can ask for on a sticker not
  // known to be theirs, so one is first made theirs by placing it.
  const press = (ui) => {
    openBook(ui.root, "one");
    labeled(ui.root, "Blocker, vinyl").click();
    return { id: "s1", ...ui.sent()[0].payload };
  };

  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const s = press(ui);
  ui.acts[0].answer({ ok: true });
  await settled();
  ui.runTimers(WAIT);
  assert.equal(stickersOf(ui.root, "one").length, 0, "a yes with no sticker in the state draws no sticker");
  ui.push(session({ cards: three, stamps: [s] }, PARTICIPANT));
  assert.ok(mine(ui), "the one that the state then shows is the viewer's");

  // The facilitator's every sticker is movable; a participant's yes for a
  // move the state contradicts must not make somebody else's sticker theirs.
  const other = load({ host: "new" });
  other.push(session(others9, PARTICIPANT));
  stickersOf(other.root, "one")[0].fire("keydown", { key: "Delete" });
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
  one(noteWith(ui.root, "two"), "more").click();
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
  one(noteWith(ui.root, "two"), "more").click();
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
  one(noteWith(ui.root, "two"), "more").click();
  menuItem(ui.root, "Delete note").click();
  ui.push(session({ cards: [three[0], three[2]], actionItems: [{ id: "a1", text: "fix it", owner: "", sourceIds: [] }] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "sheet").length, 0);
  same(ui.document.activeElement, one(noteWith(ui.root, "three"), "more"), "not the page");

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
    one(noteWith(ui.root, "two"), "more").click();
    menuItem(ui.root, "Delete note").click();
  };
  remove();
  button(one(ui.root, "sheet"), "Delete note").click();
  ui.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();

  one(noteWith(ui.root, "two"), "more").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), "true");
  menuItem(ui.root, "Delete note").click();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note, or the facilitator, can delete it.");
  assert.equal(byClass(ui.root, "sheet").length, 0, "the question is not asked again");
  assert.equal(ui.acts.length, 1);
  ui.press("Escape");
  one(noteWith(ui.root, "one"), "more").click();
  assert.equal(menuItem(ui.root, "Delete note").getAttribute("aria-disabled"), null, "another note is still asked about");
});

// ---- carrying a note to another lane, into a group, or onto another note

// Three lanes side by side, each 300 wide and 600 tall. "Went well" holds
// one, two and three at 100, 150 and 200; "To improve" holds four and five at
// 100 and 150. Every note is 44 high: its top quarter ends at 11, its middle
// half runs from 11 to 33.
const five = [...three, card("c4", "to-improve", "four"), card("c5", "to-improve", "five")];
const pair = [{ id: "g1", columnId: "to-improve", title: "Pair" }];
const paired = [...three, card("c4", "to-improve", "four", { groupId: "g1" }), card("c5", "to-improve", "five", { groupId: "g1" })];

function lanesLaid(ui) {
  ["Went well", "To improve", "Puzzles"].forEach((title, i) => (lane(ui.root, title).box = { left: 320 * i, top: 0, width: 300, height: 600 }));
  place(ui.root, ["one", "two", "three"]);
  place(ui.root, ["four", "five"], 320);
}

function board5(state = { cards: five }, who = PARTICIPANT) {
  const ui = load({ host: "new" });
  ui.push(session(state, who));
  lanesLaid(ui);
  return ui;
}

// Press the handle of a note and carry it to a point.
function carryTo(ui, text, x, y) {
  const from = noteWith(ui.root, text).box;
  one(noteWith(ui.root, text), "grip").fire("pointerdown", { clientX: from.left + 10, clientY: from.top + 15 });
  ui.fireWindow("pointermove", { clientX: from.left + 10, clientY: from.top + 25 });
  ui.fireWindow("pointermove", { clientX: x, clientY: y });
}
const drop = (ui, x, y) => ui.fireWindow("pointerup", { clientX: x, clientY: y });
const marked = (root, name) => byClass(root, name).length;
const byMenu = (ui, text, ...labels) => {
  one(noteWith(ui.root, text), "more").click();
  for (const label of labels) menuItem(ui.root, label).click();
};

test("a note dropped on another lane's empty space goes to the end of it: the request the menu sends", () => {
  const ui = board5();
  carryTo(ui, "one", 700, 300);
  assert.ok(lane(ui.root, "Puzzles").className.includes("dropzone"), "the lane under the pointer is marked");
  assert.equal(marked(ui.root, "dropzone"), 1, "and only that one");
  assert.equal(liveOf(ui.root), "Drop at the end of Puzzles");
  assert.deepEqual(ui.sent(), []);
  drop(ui, 700, 300);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "puzzles" } }]);
  assert.equal(noteOrder(ui.root, "Puzzles"), "one");
  assert.equal(noteOrder(ui.root, "Went well"), "two three");
  assert.equal(liveOf(ui.root), "Moved to Puzzles, position 1 of 1.");
  assert.equal(marked(ui.root, "dropzone"), 0, "the mark is gone once it is put down");

  const other = board5();
  byMenu(other, "one", "Move to\u2026", "Puzzles");
  assert.deepEqual(other.sent(), ui.sent(), "the menu and the drop ask for the same thing");
  assert.equal(liveOf(other.root), "Moved to Puzzles, position 1 of 1.");
});

test("a note dropped between two notes of another lane lands between them", () => {
  const ui = board5();
  // 160 is above the middle of five (150 to 194) and below four.
  carryTo(ui, "one", 400, 160);
  assert.ok(lane(ui.root, "To improve").className.includes("dropzone"));
  assert.equal(liveOf(ui.root), "Drop to move before: five");
  drop(ui, 400, 160);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "to-improve", beforeId: "c5" } }]);
  assert.equal(noteOrder(ui.root, "To improve"), "four one five");
  assert.equal(liveOf(ui.root), "Moved to To improve, position 2 of 3.");
});

test("a note's own lane is not marked as somewhere to drop it", () => {
  const ui = board5();
  carryTo(ui, "three", 10, 105);
  assert.equal(marked(ui.root, "dropzone"), 0);
  drop(ui, 10, 105);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } }]);
});

test("a note dropped on a group joins it where it was dropped, also from another lane; the menu's Move to asks for the same", () => {
  const ui = board5({ cards: paired, groups: pair });
  one(ui.root, "group").box = { left: 320, top: 60, width: 300, height: 150 };
  // Over the group's heading: in front of its first note.
  carryTo(ui, "one", 400, 70);
  assert.ok(one(ui.root, "group").className.includes("dropzone"), "the group is marked");
  assert.equal(liveOf(ui.root), "Drop into Pair");
  ui.fireWindow("pointermove", { clientX: 400, clientY: 160 });
  drop(ui, 400, 160);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", groupId: "g1", beforeId: "c5" } }]);
  assert.equal(noteOrder(ui.root, "To improve"), "four one five");
  assert.equal(liveOf(ui.root), "Moved to the group Pair, position 2 of 3.");
  assert.equal(marked(ui.root, "dropzone"), 0);

  // Dropped under its last note, it is the request the menu sends.
  const end = board5({ cards: paired, groups: pair });
  one(end.root, "group").box = { left: 320, top: 60, width: 300, height: 150 };
  carryTo(end, "one", 400, 205);
  drop(end, 400, 205);
  const menu = board5({ cards: paired, groups: pair });
  byMenu(menu, "one", "Move to\u2026", "Pair");
  assert.deepEqual(end.sent(), [{ action: "move-card", payload: { cardId: "c1", groupId: "g1" } }]);
  assert.deepEqual(menu.sent(), end.sent());
});

test("a grouped note dropped among loose notes, or in another lane, leaves its group", () => {
  const ui = board5({ cards: paired, groups: pair });
  one(ui.root, "group").box = { left: 320, top: 60, width: 300, height: 150 };
  carryTo(ui, "four", 400, 400);
  assert.equal(liveOf(ui.root), "Drop at the end of To improve");
  drop(ui, 400, 400);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c4", groupId: null } }]);

  const away = board5({ cards: paired, groups: pair });
  one(away.root, "group").box = { left: 320, top: 60, width: 300, height: 150 };
  carryTo(away, "four", 700, 300);
  drop(away, 700, 300);
  assert.deepEqual(away.sent(), [{ action: "move-card", payload: { cardId: "c4", columnId: "puzzles" } }]);
  assert.equal(noteOrder(away.root, "Puzzles"), "four");
  assert.equal(byClass(lane(away.root, "Puzzles"), "group").length, 0, "it arrives loose");
});

test("a lane sorted by votes takes a note from another lane, at its end, and says the sort is the viewer's own", () => {
  const cards = [...three, card("c4", "to-improve", "four", { voteCount: 1 }), card("c5", "to-improve", "five", { voteCount: 3 })];
  const ui = board5({ cards });
  button(lane(ui.root, "To improve"), "Top rated").click();
  assert.equal(noteOrder(ui.root, "To improve"), "five four");
  carryTo(ui, "one", 400, 105);
  assert.equal(liveOf(ui.root), "Drop to add to To improve. That lane is sorted by rating for you, so no place in it can be picked.");
  drop(ui, 400, 105);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "to-improve" } }], "no place is asked for");
  assert.equal(noteOrder(ui.root, "To improve"), "five four one");
  assert.equal(liveOf(ui.root), "Moved to To improve, position 3 of 3. That lane is sorted by rating for you: this is its place in the shared order.");
});

test("a note can be carried out of a lane sorted by votes", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: voted }, PARTICIPANT));
  lanesLaid2(ui);
  button(lane(ui.root, "Went well"), "Top rated").click();
  carryTo(ui, "one", 700, 300);
  drop(ui, 700, 300);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "puzzles" } }]);
});
function lanesLaid2(ui) {
  ["Went well", "To improve", "Puzzles"].forEach((title, i) => (lane(ui.root, title).box = { left: 320 * i, top: 0, width: 300, height: 600 }));
  place(ui.root, ["one", "two", "three"]);
}

test("Escape over another lane returns the note and sends nothing", () => {
  const ui = board5();
  carryTo(ui, "one", 400, 160);
  assert.equal(noteOrder(ui.root, "To improve"), "four one five", "the slot shows where it would land");
  ui.press("Escape");
  assert.deepEqual(ui.sent(), []);
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  assert.equal(noteOrder(ui.root, "To improve"), "four five");
  assert.equal(marked(ui.root, "dropzone") + marked(ui.root, "slot") + marked(ui.root, "drag"), 0);
  assert.equal(liveOf(ui.root), "Not moved.");
  drop(ui, 400, 160);
  assert.deepEqual(ui.sent(), [], "letting go afterwards is not a drop");
});

test("a lane change the server refuses is taken back, with the server's reason", async () => {
  const ui = board5();
  carryTo(ui, "one", 400, 160);
  drop(ui, 400, 160);
  assert.equal(noteOrder(ui.root, "To improve"), "four one five");
  ui.acts[0].answer({ ok: false, reason: "rate-limited" });
  await settled();
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  assert.equal(noteOrder(ui.root, "To improve"), "four five");
  assert.equal(toastOf(ui.root).textContent, "Too many changes at once. Wait a moment, then try again.");
});

test("Alt with Left or Right moves a note to the next lane, the way its menu does, and says where it is", () => {
  const ui = board5();
  const note = noteWith(ui.root, "two");
  one(note, "grip").focus();
  note.fire("keydown", { key: "ArrowLeft", altKey: true });
  assert.deepEqual(ui.sent(), [], "there is no lane before the first");
  assert.equal(liveOf(ui.root), "Already in the first lane.");
  note.fire("keydown", { key: "ArrowRight", altKey: true });
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c2", columnId: "to-improve" } }]);
  assert.equal(liveOf(ui.root), "Moved to To improve, position 3 of 3.");
  same(ui.document.activeElement, one(note, "grip"), "focus goes with the note");

  const menu = board5();
  byMenu(menu, "two", "Move to\u2026", "To improve");
  assert.deepEqual(menu.sent(), ui.sent());
});

test("the middle of a note means group with it only after the pointer rests there, and is kept until it is nearly off the note", () => {
  const ui = board5();
  const two = noteWith(ui.root, "two");
  const three3 = noteWith(ui.root, "three");
  // two stands from 150 to 194. Its middle half is 161 to 183.
  carryTo(ui, "three", 10, 165);
  assert.equal(marked(ui.root, "merge"), 0, "passing over is not resting");
  assert.equal(noteOrder(ui.root, "Went well"), "one two three", "and the slot has not moved either");
  ui.runTimers(300);
  assert.ok(two.className.includes("merge"), "after a rest the note is the target");
  assert.ok(three3.className.includes("faded"), "and the slot steps back");
  assert.equal(liveOf(ui.root), "Drop to group with: two");
  // 156 is in the top quarter, but still inside the margin a held target keeps.
  ui.fireWindow("pointermove", { clientX: 10, clientY: 156 });
  assert.ok(two.className.includes("merge"), "a small slip does not lose it");
  // 152 is nearly off the note.
  ui.fireWindow("pointermove", { clientX: 10, clientY: 152 });
  assert.equal(marked(ui.root, "merge") + marked(ui.root, "faded"), 0);
  assert.equal(liveOf(ui.root), "Drop to move before: two");
  assert.equal(noteOrder(ui.root, "Went well"), "one three two", "the top quarter means in front of it");
  // Back in the middle: the rest starts again.
  ui.fireWindow("pointermove", { clientX: 10, clientY: 170 });
  assert.equal(marked(ui.root, "merge"), 0);
  // The bottom quarter means after it.
  ui.fireWindow("pointermove", { clientX: 10, clientY: 190 });
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  ui.runTimers(300);
  assert.equal(marked(ui.root, "merge"), 0, "a rest that was left does not ripen later");
  drop(ui, 10, 190);
  assert.deepEqual(ui.sent(), [], "back where it started, nothing is sent");
});

test("a note dropped on another asks for the group's name, sends what the Group bar sends, and Cancel sends nothing", () => {
  const ui = board5();
  const ontoTwo = () => {
    carryTo(ui, "three", 10, 172);
    ui.runTimers(300);
    drop(ui, 10, 172);
  };
  ontoTwo();
  const sheet = one(ui.root, "sheet");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(sheet.getAttribute("aria-label"), "Group these two notes");
  const name = all(sheet, (n) => n.tagName === "INPUT")[0];
  assert.equal(name.value, "two", "the name starts as the first words of the note it was dropped on");
  same(ui.document.activeElement, name);
  assert.deepEqual(ui.sent(), [], "nothing is sent until it is named");
  assert.equal(noteOrder(ui.root, "Went well"), "one two three", "and neither note has moved");
  button(sheet, "Cancel").click();
  assert.equal(byClass(ui.root, "sheet").length, 0);
  assert.deepEqual(ui.sent(), []);
  same(ui.document.activeElement, one(noteWith(ui.root, "two"), "more"), "focus is on the note it was dropped on");

  ontoTwo();
  const again = all(one(ui.root, "sheet"), (n) => n.tagName === "INPUT")[0];
  again.type("  ");
  assert.equal(button(one(ui.root, "sheet"), "Group").disabled, true, "a group needs a name");
  again.type("Pairing");
  button(one(ui.root, "sheet"), "Group").click();
  assert.deepEqual(ui.sent(), [{ action: "group-cards", payload: { cardIds: ["c2", "c3"], title: "Pairing" } }]);

  const bar = board5();
  select(bar.root, "three");
  select(bar.root, "two");
  all(one(bar.root, "select-bar"), (n) => n.tagName === "INPUT")[0].type("Pairing");
  button(one(bar.root, "select-bar"), "Group").click();
  assert.deepEqual(bar.sent(), ui.sent(), "the bar and the drop make the same group");
});

test("a note is never grouped with a note of another lane by a drop: there it is set down", () => {
  const ui = board5();
  carryTo(ui, "one", 400, 172);
  ui.runTimers(300);
  assert.equal(marked(ui.root, "merge"), 0);
  drop(ui, 400, 172);
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "to-improve" } }]);
});

test("a group or a note that is deleted while something is carried to it is not sent anything", () => {
  const ui = board5({ cards: paired, groups: pair });
  one(ui.root, "group").box = { left: 320, top: 60, width: 300, height: 150 };
  carryTo(ui, "one", 400, 160);
  ui.push(session({ cards: three }, PARTICIPANT));
  drop(ui, 400, 160);
  assert.deepEqual(ui.sent(), []);
  assert.equal(toastOf(ui.root).textContent, "That is no longer on the board.");
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");

  const onto = board5();
  carryTo(onto, "three", 10, 172);
  onto.runTimers(300);
  onto.push(session({ cards: [five[0], five[2], five[3], five[4]] }, PARTICIPANT));
  drop(onto, 10, 172);
  assert.deepEqual(onto.sent(), []);
  assert.equal(byClass(onto.root, "sheet").length, 0);
  assert.equal(toastOf(onto.root).textContent, "That is no longer on the board.");
});

test("a group is carried to another lane whole, by its handle or from its menu", async () => {
  const ui = board5({ cards: paired, groups: pair });
  const group = one(ui.root, "group");
  group.box = { left: 320, top: 60, width: 300, height: 150 };
  one(group, "grip").fire("pointerdown", { clientX: 330, clientY: 70 });
  ui.fireWindow("pointermove", { clientX: 330, clientY: 80 });
  ui.fireWindow("pointermove", { clientX: 700, clientY: 300 });
  assert.ok(lane(ui.root, "Puzzles").className.includes("dropzone"));
  drop(ui, 700, 300);
  assert.deepEqual(ui.sent(), [{ action: "move-group", payload: { groupId: "g1", columnId: "puzzles" } }]);
  assert.equal(noteOrder(ui.root, "Puzzles"), "four five");
  assert.equal(byClass(lane(ui.root, "Puzzles"), "group").length, 1);
  assert.equal(liveOf(ui.root), "Group Pair moved to Puzzles, position 1 of 1.");

  const menu = board5({ cards: paired, groups: pair });
  labeled(menu.root, "Options for group: Pair").click();
  menuItem(menu.root, "Move to\u2026").click();
  menuItem(menu.root, "Puzzles").click();
  assert.deepEqual(menu.sent(), ui.sent());

  // Refused, it goes back, group and notes together.
  ui.acts[0].answer({ ok: false, reason: "not-found" });
  await settled();
  assert.equal(noteOrder(ui.root, "To improve"), "four five");
  assert.equal(byClass(lane(ui.root, "To improve"), "group").length, 1);
  assert.equal(noteOrder(ui.root, "Puzzles"), "");
});

test("a drag that ends without a release gives the pointer back to the page", () => {
  for (const end of [(ui) => ui.press("Escape"), (ui) => ui.fireWindow("blur"), (ui) => drop(ui, 400, 160)]) {
    const ui = board5();
    const board = main(ui.root);
    let captured = null;
    board.setPointerCapture = (id) => (captured = id);
    board.hasPointerCapture = (id) => captured === id;
    board.releasePointerCapture = () => (captured = null);
    carryTo(ui, "one", 400, 160);
    assert.equal(captured, 1, "the board follows the pointer while it carries");
    end(ui);
    assert.equal(captured, null, "and lets it go however the drag ends");
  }
});

test("the click that ends a drag is not a press, and the next press anywhere is one again", () => {
  const ui = board5();
  const grip = one(noteWith(ui.root, "one"), "grip");
  carryTo(ui, "one", 10, 105);
  drop(ui, 10, 105);
  const said = liveOf(ui.root);
  assert.notEqual(said, "");
  grip.click();
  assert.equal(liveOf(ui.root), said, "the release is not read as a press of the handle: nothing new is said");
  // No timer has run: the next press on the page clears it on its own.
  ui.pressOn(lane(ui.root, "Puzzles"));
  grip.click();
  ui.runTimers(60);
  assert.match(liveOf(ui.root), /^Drag to move this/);
});

test("a press while a drag is still open, its release never heard, ends that drag before anything else", () => {
  const ui = board5();
  carryTo(ui, "one", 400, 160);
  ui.push(session({ cards: [...five, card("c6", "puzzles", "six")] }, PARTICIPANT));
  assert.equal(marked(ui.root, "drag"), 1);
  ui.pressOn(lane(ui.root, "Puzzles"));
  assert.equal(marked(ui.root, "drag") + marked(ui.root, "slot") + marked(ui.root, "dropzone"), 0);
  assert.equal(ui.hearing("pointermove") + ui.hearing("pointerup"), 0, "the window is let go");
  assert.equal(ui.document.documentElement.className, "");
  assert.deepEqual(ui.sent(), [], "it is a cancel, not a drop");
  assert.ok(noteWith(ui.root, "six"), "and the state that waited is shown");
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
});

// ---- review round: pointers, emptied groups, scrolling, measuring, names

test("a second finger set down on a sticker, or on another handle, does not end the drag the first is making", () => {
  const state = { cards: three, stamps: [st("s1", "idea", 0.5, 0.5)] };
  const ui = load({ host: "new" });
  ui.push(session(state, FACILITATOR));
  carry(ui, "three", 110);
  assert.equal(byClass(ui.root, "drag").length, 1);
  const sticker = stickersOf(ui.root, "one")[0];
  sticker.fire("pointerdown", { pointerId: 2, clientX: 120, clientY: 122 });
  assert.equal(byClass(ui.root, "drag").length, 1, "the note is still carried");
  ui.fireWindow("pointermove", { pointerId: 2, clientX: 180, clientY: 130 });
  ui.fireWindow("pointerup", { pointerId: 2, clientX: 180, clientY: 130 });
  assert.ok(!sticker.className.includes("lift"), "and the second finger carries nothing of its own");
  assert.deepEqual(ui.sent(), []);
  one(noteWith(ui.root, "two"), "grip").fire("pointerdown", { pointerId: 3, clientX: 10, clientY: 165 });
  ui.fireWindow("pointermove", { pointerId: 3, clientX: 10, clientY: 400 });
  assert.equal(byClass(ui.root, "drag").length, 1, "nor does a third on another handle");
  ui.fireWindow("pointerup", { pointerId: 1, clientX: 10, clientY: 110 });
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c3", groupId: null, beforeId: "c1" } }], "the first finger's drop is the one that counts");

  // A press that has not yet become a drag is not canceled either.
  const early = load({ host: "new" });
  early.push(session(state, FACILITATOR));
  place(early.root, ["one", "two", "three"]);
  one(noteWith(early.root, "three"), "grip").fire("pointerdown", { pointerId: 1, clientX: 10, clientY: 215 });
  stickersOf(early.root, "one")[0].fire("pointerdown", { pointerId: 2, clientX: 120, clientY: 122 });
  early.fireWindow("pointermove", { pointerId: 1, clientX: 10, clientY: 180 });
  assert.equal(byClass(early.root, "drag").length, 1, "the first finger goes on to lift its note");
});

const solo = { cards: [card("c1", "went-well", "one", { groupId: "g1" }), three[1], three[2]], groups: [{ id: "g1", columnId: "went-well", title: "Solo" }] };

test("taking the last note out of a group takes the group away at once, as the server does, and a refusal brings it back whole", async () => {
  const ui = load({ host: "new" });
  ui.push(session(solo, PARTICIPANT));
  assert.equal(byClass(ui.root, "group").length, 1);
  byMenu(ui, "one", "Move to\u2026", "Out of \u201cSolo\u201d");
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c1", groupId: null } }]);
  assert.equal(byClass(ui.root, "group").length, 0, "the emptied group is gone before the server answers");
  assert.equal(noteOrder(ui.root, "Went well"), "two three one", "with no place named, the note goes to the end");
  // The server's own state: the note loose at the end, and no group.
  ui.acts[0].answer({ ok: true });
  await settled();
  ui.push(session({ cards: [three[1], three[2], three[0]] }, PARTICIPANT));
  ui.runTimers(WAIT);
  assert.equal(toastOf(ui.root).hidden, true, "the state agrees with what was drawn, so nothing is in doubt");
  assert.equal(byClass(ui.root, "group").length, 0);

  const refused = load({ host: "new" });
  refused.push(session(solo, PARTICIPANT));
  byMenu(refused, "one", "Move to\u2026", "Out of \u201cSolo\u201d");
  assert.equal(byClass(refused.root, "group").length, 0);
  refused.acts[0].answer({ ok: false, reason: "conflict" });
  await settled();
  const group = one(refused.root, "group");
  assert.ok(group, "the group is back");
  assert.match(one(group, "group-title").textContent, /Solo/);
  assert.deepEqual(byClass(group, "note").map((n) => one(n, "note-text").textContent), ["one"], "with its note inside it");
  assert.equal(noteOrder(refused.root, "Went well"), "one two three");

  // Carried out of its group into another lane: the same, by a drop.
  const dragged = board5({ cards: [...solo.cards, five[3], five[4]], groups: solo.groups });
  carryTo(dragged, "one", 400, 400);
  drop(dragged, 400, 400);
  assert.deepEqual(dragged.sent(), [{ action: "move-card", payload: { cardId: "c1", columnId: "to-improve" } }]);
  assert.equal(byClass(dragged.root, "group").length, 0);
  dragged.acts[0].answer({ ok: false, reason: "failed" });
  await settled();
  assert.equal(byClass(one(dragged.root, "group"), "note").length, 1, "and back in it when refused");
});

// The window is 800 tall, and a drag scrolls within 56 of its top or bottom.
function nearEdge(y = 790) {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  carry(ui, "three", y);
  return ui;
}
const frame = (ui, ms = 16) => {
  ui.clock.t += ms;
  ui.runTimers(16);
};

test("a note held near the edge of what is in sight scrolls the page, faster the nearer it is, and not at all away from it", () => {
  const down = nearEdge(790);
  assert.deepEqual(down.scrolls, [], "nothing until a frame has passed");
  frame(down);
  // 46 of the 56 past the line: 120 + 46/56 * 780 = 760.7 pixels a second, 12 in 16ms.
  assert.deepEqual(down.scrolls, [12]);
  frame(down);
  frame(down);
  assert.deepEqual(down.scrolls, [12, 12, 12], "it goes on while the pointer stays, without the pointer moving");

  const up = nearEdge(10);
  frame(up);
  assert.deepEqual(up.scrolls, [-12], "up, near the top");

  const out = nearEdge(1200);
  frame(out);
  // Past the edge it is as fast as it gets: 900 a second, 14 in 16ms.
  assert.deepEqual(out.scrolls, [14]);

  const just = nearEdge(745);
  frame(just);
  // One pixel past the line: 120 + 1/56 * 780 = 133.9 a second, 2 in 16ms.
  assert.deepEqual(just.scrolls, [2]);

  const middle = nearEdge(400);
  frame(middle);
  frame(middle);
  assert.deepEqual(middle.scrolls, []);

  // Carried back to the middle, it stops; carried out again, it starts.
  down.fireWindow("pointermove", { clientX: 10, clientY: 400 });
  frame(down);
  frame(down);
  assert.deepEqual(down.scrolls, [12, 12, 12], "the frame already on its way finds nothing to do");
  down.fireWindow("pointermove", { clientX: 10, clientY: 790 });
  frame(down);
  assert.deepEqual(down.scrolls, [12, 12, 12, 12]);
});

test("every way a drag ends stops the scrolling with it", () => {
  const ends = {
    "the pointer let go": (ui) => ui.fireWindow("pointerup", { clientX: 10, clientY: 790 }),
    Escape: (ui) => ui.press("Escape"),
    "the window losing focus": (ui) => ui.fireWindow("blur"),
    "the capture being taken away": (ui) => main(ui.root).fire("lostpointercapture"),
    "the pointer being canceled": (ui) => ui.fireWindow("pointercancel"),
    "the page being hidden": (ui) => {
      ui.document.hidden = true;
      ui.fireDocument("visibilitychange");
    },
    "the carried note leaving the page": (ui) => {
      const node = noteWith(ui.root, "three");
      node.parentNode.removeChild(node);
    },
  };
  for (const [name, end] of Object.entries(ends)) {
    const ui = nearEdge(790);
    frame(ui);
    assert.deepEqual(ui.scrolls, [12], name);
    end(ui);
    for (let i = 0; i < 5; i++) frame(ui);
    assert.deepEqual(ui.scrolls, [12], name + ": not one more step");
    assert.equal(byClass(ui.root, "drag").length, 0, name + ": and nothing is carried any more");
    assert.equal(ui.hearing("pointermove"), 0, name);
  }
  // A page that is merely told it is visible again is not interrupted.
  const seen = nearEdge(790);
  seen.document.hidden = false;
  seen.fireDocument("visibilitychange");
  frame(seen);
  assert.deepEqual(seen.scrolls, [12]);
  assert.equal(byClass(seen.root, "drag").length, 1);
});

test("a pointer held still at the edge does not scroll for ever: it stops after ten seconds, or once the page has gone as far as the board is tall", () => {
  const timed = nearEdge(790);
  frame(timed);
  assert.deepEqual(timed.scrolls, [12]);
  // Ten seconds on with the pointer not moved: the frame on its way runs, and no other follows.
  frame(timed, 10001);
  assert.equal(timed.scrolls.length, 2);
  for (let i = 0; i < 20; i++) frame(timed);
  assert.equal(timed.scrolls.length, 2, "it has stopped");
  assert.equal(byClass(timed.root, "drag").length, 1, "the note is still held");
  timed.fireWindow("pointermove", { clientX: 10, clientY: 791 });
  frame(timed);
  assert.equal(timed.scrolls.length, 3, "and a move of the pointer starts it again");

  // A board 1000 tall in a window 800 tall: 1800 at most, in steps of 12.
  // After 150 steps it has gone exactly 1800, which is not yet past it, so
  // there is one more: 151 steps, 1812.
  const far = nearEdge(790);
  main(far.root).box = { left: 0, top: 0, width: 1280, height: 1000 };
  for (let i = 0; i < 400; i++) frame(far);
  assert.equal(far.scrolls.length, 151);
  assert.equal(far.scrolls.reduce((a, b) => a + b, 0), 1812);
});

test("while a note is carried each box is measured once, until the slot, the window or the scroll moves things", () => {
  const ui = board5();
  carryTo(ui, "three", 10, 108);
  assert.equal(noteOrder(ui.root, "Went well"), "three one two", "in front of one");
  // Still over the top quarter of "one", which runs from 100 to 111.
  ui.fireWindow("pointermove", { clientX: 12, clientY: 107 });
  const before = ui.document.rectReads;
  for (let i = 0; i < 20; i++) ui.fireWindow("pointermove", { clientX: 10 + i, clientY: 101 + (i % 9) });
  assert.equal(ui.document.rectReads - before, 0, "twenty moves, and nothing measured again");
  assert.equal(noteOrder(ui.root, "Went well"), "three one two");

  // The window is resized and "one" is now far down the lane. Measured
  // afresh, a pointer at 140 is above its middle, so the slot stays in front
  // of it. Had the old box (100 to 144) been kept, 140 would be past its
  // middle and the slot would have gone after it.
  noteWith(ui.root, "one").box = { left: 0, top: 400, width: 240, height: 44 };
  ui.fireWindow("resize");
  ui.fireWindow("pointermove", { clientX: 10, clientY: 140 });
  assert.ok(ui.document.rectReads > before, "measured again");
  assert.equal(noteOrder(ui.root, "Went well"), "three one two");

  // The same for a scroll of the frame itself.
  noteWith(ui.root, "one").box = { left: 0, top: 100, width: 240, height: 44 };
  ui.fireWindow("scroll");
  ui.fireWindow("pointermove", { clientX: 10, clientY: 140 });
  assert.equal(noteOrder(ui.root, "Went well"), "one three two", "back where it was, 140 is past its middle");
  // And the slot having moved is itself a reason: two, at 150, is now measured where it stands.
  ui.fireWindow("pointermove", { clientX: 10, clientY: 190 });
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  drop(ui, 10, 190);
  assert.deepEqual(ui.sent(), [], "back where it started");
});

test("on a touch screen the checkbox, the handle, the menu button and the action button are 44 by 44, and what is drawn smaller is pressed over 44", () => {
  const coarse = src.split("\n").find((line) => line.includes("@media (pointer:coarse){.btn"));
  assert.match(coarse, /\.pick,\.grip,\.more\{width:44px;height:44px\}/);
  assert.match(coarse, /\.stage-3 \.target\{min-width:44px;height:44px\}/);
  assert.doesNotMatch(src, /width:36px;height:44px/);
  const reach = src.split("\n").find((line) => line.includes(".st::after"));
  assert.match(reach, /\.target\{position:relative;justify-content:center;min-width:44px\}/);
  assert.match(reach, /\.board:not\(\.stage-3\) \.target::after\{content:"";position:absolute;inset:-7px -1px\}/);
  assert.match(reach, /\.st::after\{content:"";position:absolute;inset:-1px\}/);
  // The plus and the thumbs: 32 drawn with a 1px ring, so 30 inside it and 7 more on
  // every side is 44 pressed; 44 apart (12 between); and 60 in from the note's edge, so
  // the 7 around the last one stop short of the menu button, which starts 52 in.
  const edge = src.split("\n").find((line) => line.includes(".rb::after"));
  assert.match(edge, /\.rx\{gap:12px;bottom:-16px;right:60px\}\.rb\{width:32px;height:32px;opacity:1\}\.rb::after\{content:"";position:absolute;inset:-7px\}/);
});

// Drop the third note on the second, whose text is `text`, and read the name the sheet offers.
function nameSheet(text) {
  const ui = load({ host: "new" });
  ui.push(session({ cards: [card("c1", "went-well", "first"), card("c2", "went-well", text), card("c3", "went-well", "third")] }, PARTICIPANT));
  lane(ui.root, "Went well").box = { left: 0, top: 0, width: 300, height: 600 };
  const notes = byClass(ui.root, "note");
  notes.forEach((n, i) => (n.box = { left: 0, top: 100 + 50 * i, width: 240, height: 44 }));
  one(notes[2], "grip").fire("pointerdown", { clientX: 10, clientY: 215 });
  ui.fireWindow("pointermove", { clientX: 10, clientY: 225 });
  ui.fireWindow("pointermove", { clientX: 10, clientY: 172 });
  ui.runTimers(300);
  drop(ui, 10, 172);
  return { ui, name: all(one(ui.root, "sheet"), (n) => n.tagName === "INPUT")[0] };
}
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("the name offered for a group is the note's first three words: whole characters, at most eighty long, and nothing invisible", () => {
  assert.equal(nameSheet("standup ran long again today").name.value, "standup ran long");
  assert.equal(nameSheet("  two\n\twords  ").name.value, "two words");

  // One word of 200 letters is cut at 80.
  assert.equal(nameSheet("a".repeat(200)).name.value, "a".repeat(80));
  // Letters that take two code units each: forty fit, and with one plain
  // letter in front thirty-nine do, 79 in all, since the fortieth would be cut in half.
  const wide = "\u{1d4b3}";
  assert.equal(nameSheet(wide.repeat(200)).name.value, wide.repeat(40));
  const odd = nameSheet("a" + wide.repeat(100)).name.value;
  assert.equal(odd, "a" + wide.repeat(39));
  assert.equal(odd.length, 79);
  assert.doesNotMatch(odd, loneSurrogate);

  // A family is one character to its reader and eleven code units: seven fit in eighty.
  const family = "\u{1f469}‍\u{1f469}‍\u{1f467}‍\u{1f466}";
  assert.equal(family.length, 11);
  const families = nameSheet(family.repeat(100)).name.value;
  assert.equal(families, family.repeat(7));
  assert.doesNotMatch(families, loneSurrogate);
  assert.equal(nameSheet("\u{1f389}\u{1f389} party \u{1f389} time now").name.value, "\u{1f389}\u{1f389} party \u{1f389}");

  // Right-to-left text keeps its letters and loses the marks that override direction.
  assert.equal(nameSheet("‮שלום ‏עולם​ טוב מאוד").name.value, "שלום עולם טוב");
  assert.equal(nameSheet("⁦evil⁩‭name‬ here and more").name.value, "evil name here");
  // Controls and other marks that draw nothing are not carried into a name.
  assert.equal(nameSheet("line\u0000one﻿two\u0007 three­ four").name.value, "line one two");
});

test("the name sheet closes, gives the board back and says why when either of its two notes is deleted", () => {
  const cards = (ids) => [card("c1", "went-well", "first"), card("c2", "went-well", "second"), card("c3", "went-well", "third")].filter((c) => ids.includes(c.id));
  for (const [name, left, focus] of [["the note that was dropped", ["c1", "c2"], "second"], ["the note it was dropped on", ["c1", "c3"], null]]) {
    const { ui, name: field } = nameSheet("second");
    assert.equal(inert(ui.root), "true true", "the board waits under the sheet");
    field.type("Pair");
    ui.push(session({ cards: cards(left) }, PARTICIPANT));
    assert.equal(byClass(ui.root, "sheet").length, 0, name + ": the sheet is closed");
    assert.equal(inert(ui.root), "false false", name + ": and the board is usable again");
    assert.equal(toastOf(ui.root).textContent, "That was removed from the board while you had it open.", name);
    assert.deepEqual(ui.sent(), [], "nothing was grouped");
    if (focus) same(ui.document.activeElement, one(noteWith(ui.root, focus), "more"), "focus goes to the note that is left");
  }
  // A teammate's change that touches neither note leaves the sheet, and what was typed, alone.
  const { ui, name: field } = nameSheet("second");
  field.type("Pair");
  ui.push(session({ cards: [...cards(["c1", "c2", "c3"]), card("c4", "puzzles", "new")] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "sheet").length, 1);
  assert.equal(field.value, "Pair");
});

test("a handle says how a move is made every time it is pressed, and once for a burst of presses", () => {
  const { root, push, runTimers } = load();
  push(session({ cards: three }));
  const grip = one(noteWith(root, "two"), "grip");
  const help = all(root, (n) => n.getAttribute("id") === "grip-help")[0].textContent;
  grip.click();
  assert.equal(liveOf(root), "", "the region is emptied first, so the same words are a change");
  runTimers(60);
  assert.equal(liveOf(root), help);
  grip.click();
  assert.equal(liveOf(root), "", "the second press is not silent: it empties the region again");
  runTimers(60);
  assert.equal(liveOf(root), help);
  // Five quick presses are one announcement.
  let spoken = 0;
  for (let i = 0; i < 5; i++) grip.click();
  for (let i = 0; i < 5; i++) {
    const was = liveOf(root);
    runTimers(60);
    if (liveOf(root) !== was) spoken += 1;
  }
  assert.equal(spoken, 1);
  // Something said in the meantime is not written over.
  grip.click();
  push(session({ cards: [...three, card("c4", "puzzles", "new")] }));
  runTimers(60);
  assert.equal(liveOf(root), "New note in Puzzles.");
});

test("a note's words share their row with the handle and the menu only: the action count and the edited mark are a row under them, there only when there is one, and votes are never in it", () => {
  const { root, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "plain"), card("c2", "went-well", "voted", { voteCount: 2 }), card("c3", "went-well", "linked")];
  push(session({ stage: 1, cards, actionItems: [{ id: "a1", text: "fix", owner: "", sourceIds: ["c3"] }] }, PARTICIPANT));
  const kids = (text) => noteWith(root, text).children.map((n) => n.className.split(" ")[0]);
  assert.deepEqual(kids("plain").slice(0, 4), ["lead", "note-text", "trail", "chips"]);
  for (const text of ["plain", "voted", "linked"]) {
    const note = noteWith(root, text);
    assert.deepEqual(one(note, "trail").children.map((n) => n.className), ["more"], "beside the words: the menu and nothing else");
    assert.deepEqual(one(note, "chips").children.map((n) => n.className.split(" ")[0]), ["edited", "target"], "no vote is in the row under the words");
    same(one(note, "chips").parentNode, note, "the chips are a row of the note, not part of the first one");
  }
  assert.equal(one(noteWith(root, "plain"), "chips").hidden, true, "nothing to show, no row: the note stays one line");
  assert.equal(one(noteWith(root, "voted"), "chips").hidden, true, "votes do not make a row: they are a tag on the corner");
  assert.equal(one(noteWith(root, "linked"), "chips").hidden, false);
  push(session({ stage: 2, cards }, PARTICIPANT));
  assert.deepEqual(["plain", "voted"].map((t) => one(noteWith(root, t), "chips").hidden), [true, true], "in the Vote stage too: a one-line note has no footer");
  assert.match(src, /\.chips\{grid-column:2\/-1;justify-self:start/);
  assert.match(src, /\.note-text\{padding:6px 0;white-space:pre-wrap;overflow-wrap:break-word;border-radius:4px\}/);
  assert.doesNotMatch(src, /word-break:break-all|overflow-wrap:anywhere\}".*note-text/);
});

// ---- design review round

test("a pixel sticker is never tilted, whatever tilt is stored; a vinyl one keeps its own", () => {
  const { root, push } = load();
  push(session({ cards: [card("c1", "went-well", "one")], stamps: [{ ...st("s1", "p-idea", 0.2, 0.5), rot: 8.3 }, { ...st("s2", "idea", 0.6, 0.5), rot: -7.5 }, { ...st("s3", "p-laugh", 0.8, 0.5), rot: -1.3 }] }));
  assert.deepEqual(stickersOf(root, "one").map((n) => n.style["--rot"]), ["0deg", "-7.5deg", "0deg"]);
  assert.match(src, /\.st\.px svg\{rotate:none\}/);
  assert.match(src, /\.st\.px\{width:var\(--px,42px\);height:var\(--px,42px\)/);
});

test("a sticker picked from the book lands on no word where there is room, and otherwise on a place of its own, never on the pile", () => {
  const pick = (ui, name) => {
    openBook(ui.root, "one");
    labeled(bookOf(ui.root), name).click();
    const { x, y } = ui.sent().at(-1).payload;
    return [x, y];
  };
  const laid = (lines, more = {}) => {
    const ui = load();
    ui.push(session({ cards: [card("c1", "went-well", "one")], ...more }));
    const note = noteWith(ui.root, "one");
    note.box = { left: 0, top: 0, width: 240, height: 44 };
    one(note, "note-text").lines = lines;
    return ui;
  };
  // One line of words from 38 to 110 across and 11 to 31 down. A sticker is
  // 21 from its center to its rim and sits 48 down, so it reaches up to 27:
  // on the bottom edge it is on the words anywhere from 17 to 131 across.
  // 14 is clear (in the handle's column); 44, 74 and 104 are not; 134 is.
  const short = laid([[38, 11, 110, 31]]);
  assert.deepEqual(pick(short, "Blocker, vinyl"), [0.027, 1], "the corner under the handle");
  assert.deepEqual(pick(short, "Blocker, pixel"), [0.563, 1], "then past the end of the words: 134, not 44");
  assert.deepEqual(pick(short, "Thank you, vinyl"), [0.696, 1], "then 164");

  // Words across the whole line: nowhere on the bottom edge is clear but the
  // corner. The second and the third do not go onto the first: each takes
  // the next place along, 30 apart, though it lies on the words.
  const full = laid([[38, 11, 200, 31]]);
  const spots = ["Me too, vinyl", "Me too, pixel", "Thank you, pixel"].map((name) => pick(full, name));
  assert.deepEqual(spots, [[0.027, 1], [0.161, 1], [0.295, 1]], "14, 44 and 74 across");
  // The plus is not placed: it stands with the thumbs on the note's lower edge.
  const bare = laid([[38, 11, 110, 31]]);
  bare.push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("t0", "chat", 0.1, 0.1)] }));
  const plus = addOf(bare.root, "one");
  assert.equal(plus.hidden, false);
  same(plus.parentNode, one(noteWith(bare.root, "one"), "rx"));
  assert.equal(plus.style.left, undefined, "nothing moves it about");
});

test("the book says how many are left only when it can know: not for stickers that were there before this visit", () => {
  const cards = [card("c1", "went-well", "one")];
  const ui = load();
  ui.push(session({ cards, stamps: [st("old", "idea", 0.5, 0.5)] }));
  addOf(ui.root, "one").click();
  assert.match(one(bookOf(ui.root), "left3").textContent, /^Up to 3 of yours on a note$/);
  assert.ok(all(one(bookOf(ui.root), "left3"), (n) => n.tagName === "I").every((pip) => pip.hidden), "no pips for a number that is not known");
  bookOf(ui.root).fire("keydown", { key: "1" });
  ui.push(session({ cards, stamps: [st("old", "idea", 0.5, 0.5), { id: "new", ...ui.sent()[0].payload }] }));
  openBook(ui.root, "one");
  assert.match(one(bookOf(ui.root), "left3").textContent, /^2 of 3 left on this note$/, "one placed in this visit is one the board knows of");
  ui.press("Escape");

  // A note that was bare when this visit began: everything on it is known.
  const bare = load({ phone: true });
  bare.push(session({ cards }));
  bare.push(session({ cards, stamps: [st("mate", "chat", 0.5, 0.5)] }));
  addOf(bare.root, "one").click();
  assert.match(one(bookOf(bare.root), "left3").textContent, /^3 of 3 left on this note$/);
  // The book has a Done of its own, for a phone.
  const done = button(bookOf(bare.root), "Done");
  assert.ok(done);
  done.click();
  assert.equal(byClass(bare.root, "book-pop").length, 0);
});

test("the list of a note's stickers keeps up: one a teammate removes leaves the list, and a press on a row that is gone says so", () => {
  const cards = [card("c1", "went-well", "one")];
  const stamps = [st("s1", "p-idea", 0.5, 0.5), st("s2", "laugh", 0.5, 0.5)];
  const ui = load({ host: "new" });
  ui.push(session({ cards, stamps }, FACILITATOR));
  one(noteWith(ui.root, "one"), "more").click();
  menuItem(ui.root, "Stickers (2)").click();
  const sheet = one(ui.root, "sheet");
  const rows = () => all(sheet, (n) => n.tagName === "LI").length;
  assert.equal(rows(), 2);
  const stale = labeled(sheet, "Bring to front Great idea, pixel sticker, 1 of 2");
  ui.push(session({ cards, stamps: [stamps[1]] }, FACILITATOR));
  assert.equal(rows(), 1, "the removed sticker's row is gone");
  assert.ok(labeled(sheet, "Remove Made me laugh, vinyl sticker, 1 of 1"), "and the one left is counted again");
  assert.equal(byClass(ui.root, "sheet").length, 1, "the list stays open");
  // A press that was already on its way to the old row.
  stale.click();
  assert.deepEqual(ui.sent(), [], "nothing is sent for a sticker that is gone");
  assert.equal(toastOf(ui.root).textContent, "That sticker is no longer on the board.");

  one(noteWith(ui.root, "one"), "more").click();
  menuItem(ui.root, "Stickers (1)").click();
  ui.push(session({ cards, stamps: [] }, FACILITATOR));
  assert.match(one(ui.root, "sheet").textContent, /There are no stickers on this note now\./);
  ui.push(session({ cards: [] }, FACILITATOR));
  assert.equal(byClass(ui.root, "sheet").length, 0, "with the note gone the list closes");
  assert.equal(toastOf(ui.root).textContent, "That was removed from the board while you had it open.");
});

test("which stickers lie on the words is worked out again when a vote gives the note its row of chips", () => {
  const { root, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  const stamps = [st("s1", "idea", 0.5, 0.4)];
  push(session({ cards }, PARTICIPANT));
  const note = noteWith(root, "one");
  const words = one(note, "note-text");
  note.box = { left: 0, top: 0, width: 240, height: 60 };
  words.box = { left: 40, top: 5, width: 150, height: 32 };
  push(session({ cards, stamps }, PARTICIPANT));
  assert.equal(stickersOf(root, "one")[0].className.includes("over"), true);
  // A first vote: the note grows by its chips row and the words move within
  // it. The sticker is where it was, as fractions, and no longer on them.
  note.box = { left: 0, top: 0, width: 240, height: 120 };
  words.box = { left: 40, top: 60, width: 150, height: 32 };
  push(session({ cards: [card("c1", "went-well", "one", { voteCount: 1 })], stamps }, PARTICIPANT));
  assert.equal(stickersOf(root, "one")[0].className.includes("over"), false, "measured again, not remembered");
});

test("a held arrow key is one move, sent once when it rests, and says the edge once", () => {
  const { root, push, sent, runTimers } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("s9", "chat", 0.9, 0.5)] }, FACILITATOR));
  const sticker = stickersOf(root, "one")[0];
  const live = one(root, "live");
  sticker.fire("keydown", { key: "ArrowRight" });
  for (let i = 0; i < 30; i++) sticker.fire("keydown", { key: "ArrowRight", repeat: true });
  assert.deepEqual(sent(), [], "nothing is sent while the key is down");
  assert.deepEqual(placeOf(sticker), AT(1, 0.5), "it stops at the note's edge");
  assert.notEqual(live.textContent, "At the edge of the note.", "a key held against the edge is not announced on every repeat");
  runTimers(500);
  assert.deepEqual(sent(), [{ action: "moderate-stamp", payload: { stampId: "s9", x: 1, y: 0.5 } }], "one move for the whole hold");
  sticker.fire("keydown", { key: "ArrowRight" });
  assert.equal(live.textContent, "At the edge of the note.", "a fresh press against the edge says so");
  live.text = "";
  for (let i = 0; i < 5; i++) sticker.fire("keydown", { key: "ArrowRight", repeat: true });
  assert.equal(live.textContent, "", "and its repeats do not say it again");
});

test("a note's name in an announcement is cut at a word, with an ellipsis, and not ended twice", () => {
  const { root, push } = load({ host: "new" });
  const text = "We should stop doing the thing where everyone waits for the release train and then nobody is on it when it leaves";
  const cards = [card("c1", "went-well", text)];
  push(session({ cards }, PARTICIPANT));
  push(session({ cards, stamps: [st("s1", "thanks", 0.5, 0.5)] }, PARTICIPANT));
  assert.equal(liveOf(root), "Thank you sticker placed on: We should stop doing the thing where everyone waits for the release train and… 1 sticker on that note.");
});

// ---- small fix round: the peel, the observer, Done, cuts, peek, fonts, sizes

function peeling() {
  const ui = load({ host: "new", motion: true });
  const cards = [card("c1", "went-well", "one")];
  const stamps = [st("s1", "idea", 0.2, 0.5), st("s2", "p-laugh", 0.6, 0.5)];
  ui.push(session({ cards, stamps }, FACILITATOR));
  ui.document.animations.length = 0;
  ui.push(session({ cards, stamps: [stamps[0]] }, FACILITATOR));
  const leaving = byClass(noteWith(ui.root, "one"), "leaving");
  const peel = ui.document.animations.find((a) => a.target.className.includes("leaving"));
  return { ui, cards, stamps, leaving, peel, gone: () => byClass(noteWith(ui.root, "one"), "leaving").length === 0 && stickersOf(ui.root, "one").length === 1 };
}

test("a removed sticker peels off and is always gone afterwards: when the peel finishes, when it is canceled, and when neither is ever heard", () => {
  const during = peeling();
  assert.equal(during.leaving.length, 1, "it is still there, leaving");
  const node = during.leaving[0];
  assert.equal(node.getAttribute("tabindex"), "-1");
  assert.equal(node.getAttribute("aria-hidden"), "true");
  assert.match(src, /\.st\.leaving\{pointer-events:none\}/);
  assert.equal(during.peel.timing.fill, "forwards");
  assert.deepEqual(stickersOf(during.ui.root, "one").filter((n) => n.getAttribute("tabindex") === "0").map((n) => n.className.includes("leaving")), [false], "the Tab stop is the sticker that is staying");
  // A teammate's change while it leaves does not cut the peel short or double it.
  during.ui.push(session({ cards: during.cards, stamps: [during.stamps[0]] }, FACILITATOR));
  during.ui.push(session({ cards: during.cards, stamps: [{ ...during.stamps[0], x: 0.3 }] }, FACILITATOR));
  assert.equal(byClass(noteWith(during.ui.root, "one"), "leaving").length, 1, "one node, still leaving, through two more pushes");
  during.peel.finish();
  assert.ok(during.gone(), "gone when the peel finishes");
  during.peel.finish();
  during.peel.cancel();
  during.ui.runTimers();
  assert.ok(during.gone(), "ending it again is harmless");

  const canceled = peeling();
  canceled.peel.cancel();
  assert.ok(canceled.gone(), "gone when the peel is canceled: the note was hidden, or the tab put away");
  canceled.ui.push(session({ cards: canceled.cards, stamps: [canceled.stamps[0]] }, FACILITATOR));
  assert.ok(canceled.gone(), "and the next push does not bring a ghost back");

  const silent = peeling();
  silent.ui.runTimers(400);
  assert.equal(silent.leaving.length, 1);
  assert.ok(!silent.gone(), "not before the spring would have rested");
  silent.ui.runTimers(600);
  assert.ok(silent.gone(), "gone a little after it, with neither end heard");

  // The same sticker put back while its old self is still leaving: one live sticker.
  const back = peeling();
  back.ui.push(session({ cards: back.cards, stamps: back.stamps }, FACILITATOR));
  const live = stickersOf(back.ui.root, "one").filter((n) => !n.className.includes("leaving"));
  assert.equal(live.length, 2);
  assert.equal(byClass(noteWith(back.ui.root, "one"), "leaving").length, 1);
  back.peel.cancel();
  assert.equal(stickersOf(back.ui.root, "one").length, 2, "and the old one goes without taking the new one with it");

  // The note itself removed mid-peel: nothing is left to end, and ending it does not throw.
  const noteGone = peeling();
  noteGone.ui.push(session({ cards: [] }, FACILITATOR));
  noteGone.peel.finish();
  noteGone.ui.runTimers();
  assert.equal(byClass(noteGone.ui.root, "leaving").length, 0);
});

test("a note that changes size has its own stickers looked at again, and only its own; nothing follows from a look that changes nothing", () => {
  const ui = load({ host: "new" });
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two")];
  const stamps = [st("s1", "idea", 0.5, 0.4), st("s2", "idea", 0.5, 0.4, "c2")];
  ui.push(session({ cards }, PARTICIPANT));
  for (const text of ["one", "two"]) {
    noteWith(ui.root, text).box = { left: 0, top: 0, width: 240, height: 60 };
    one(noteWith(ui.root, text), "note-text").box = { left: 40, top: 5, width: 150, height: 32 };
  }
  ui.push(session({ cards, stamps }, PARTICIPANT));
  const over = (text) => stickersOf(ui.root, text)[0].className.includes("over");
  assert.deepEqual([over("one"), over("two")], [true, true]);
  // Both notes are re-laid by the page (their words move down), but only
  // "one" is reported as having changed size.
  for (const text of ["one", "two"]) one(noteWith(ui.root, text), "note-text").box = { left: 40, top: 80, width: 150, height: 32 };
  noteWith(ui.root, "one").box = { left: 0, top: 0, width: 240, height: 130 };
  const timersBefore = ui.timerCount();
  ui.resize(noteWith(ui.root, "one"), 240);
  assert.deepEqual([over("one"), over("two")], [false, true], "only the note that was reported");
  const reads = ui.document.rectReads;
  ui.resize(noteWith(ui.root, "one"), 240);
  assert.ok(ui.document.rectReads - reads <= 6, "one note's worth of measuring, not the board's");
  assert.equal(ui.timerCount(), timersBefore, "and nothing is scheduled by a look");
  assert.deepEqual([over("one"), over("two")], [false, true]);

  // A lane says when it is narrow, and when it no longer is.
  const laneEl = lane(ui.root, "Went well");
  ui.resize(laneEl, 280);
  assert.ok(laneEl.className.split(" ").includes("narrow"));
  ui.resize(laneEl, 420);
  assert.ok(!laneEl.className.split(" ").includes("narrow"));

  // Watched once, and not at all once it has left the board.
  const first = noteWith(ui.root, "one");
  assert.equal(ui.watched(first), 1);
  ui.push(session({ cards, stamps }, PARTICIPANT));
  assert.equal(ui.watched(first), 1, "a push does not watch it again");
  ui.push(session({ cards: [cards[1]] }, PARTICIPANT));
  assert.equal(ui.watched(first), 0, "a removed note is let go");
  ui.push(session({ cards }, PARTICIPANT));
  assert.equal(ui.watched(noteWith(ui.root, "one")), 1, "and put back, it is watched once");
  const puzzles = lane(ui.root, "Puzzles");
  assert.equal(ui.watched(puzzles), 1);
  ui.push(session({ columns: columns.slice(0, 2), cards }, PARTICIPANT));
  assert.equal(ui.watched(puzzles), 0, "a removed lane too");
});

test("on a phone the book's Done is a Tab stop inside the book, after the two sheets", () => {
  const ui = load({ host: "new", phone: true });
  ui.push(session({ cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  openBook(ui.root, "one");
  const book = bookOf(ui.root);
  const done = button(book, "Done");
  assert.equal(done.hidden, false);
  assert.equal(done.getAttribute("tabindex"), null, "an ordinary stop");
  const at = () => (ui.document.activeElement === done ? "Done" : ui.document.activeElement.getAttribute("aria-label"));
  const tab = (shiftKey = false) => book.fire("keydown", { key: "Tab", shiftKey });
  assert.equal(at(), "Me too, vinyl");
  tab();
  assert.equal(at(), "Me too, pixel");
  tab();
  assert.equal(at(), "Done");
  tab();
  assert.equal(at(), "Me too, vinyl", "and round, not out to the page");
  tab(true);
  assert.equal(at(), "Done", "Shift+Tab goes back");
  done.click();
  assert.equal(byClass(ui.root, "book-pop").length, 0);

  // On a wide screen there is no Done, and Tab goes between the sheets as before.
  const wide = load({ host: "new" });
  wide.push(session({ cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  openBook(wide.root, "one");
  assert.equal(all(bookOf(wide.root), (n) => n.textContent === "Done" && n.tagName === "BUTTON")[0].hidden, true);
  bookOf(wide.root).fire("keydown", { key: "Tab" });
  bookOf(wide.root).fire("keydown", { key: "Tab" });
  assert.equal(wide.document.activeElement.getAttribute("aria-label"), "Me too, vinyl");
});

test("a long note's name is cut between whole characters, never through an emoji", () => {
  const { root, push } = load({ host: "new" });
  const family = "\u{1f469}‍\u{1f469}‍\u{1f467}‍\u{1f466}";
  // Eleven code units each, no spaces: seven fit in 77, the eighth would not.
  const cards = [card("c1", "went-well", family.repeat(20)), card("c2", "puzzles", "ab " + "\u{1f389}".repeat(60))];
  push(session({ cards }, PARTICIPANT));
  const label = (i) => byClass(root, "note")[i].children[2].children[0].getAttribute("aria-label");
  assert.equal(label(0), "Options for note: " + family.repeat(7) + "…");
  // "ab " and then two units a piece: 3 + 37 * 2 = 77.
  assert.equal(label(1), "Options for note: ab " + "\u{1f389}".repeat(37) + "…");
  for (const i of [0, 1]) assert.doesNotMatch(label(i), loneSurrogate);
});

test("peek does not stick when the sticker that was pointed at is removed, or the pointer leaves the note", () => {
  const { root, push } = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  push(session({ cards }, PARTICIPANT));
  const note = noteWith(root, "one");
  note.box = { left: 0, top: 0, width: 240, height: 60 };
  one(note, "note-text").box = { left: 40, top: 5, width: 150, height: 32 };
  const stamps = [st("s1", "idea", 0.5, 0.4), st("s2", "chat", 0.4, 0.4)];
  push(session({ cards, stamps }, PARTICIPANT));
  stickersOf(root, "one")[0].fire("pointerenter", { pointerType: "mouse" });
  assert.ok(note.className.includes("peek"));
  // A teammate removes it from under the pointer: no pointerleave is ever heard.
  push(session({ cards, stamps: [stamps[1]] }, PARTICIPANT));
  assert.ok(!note.className.includes("peek"), "the note is no longer peeking");

  stickersOf(root, "one")[0].fire("pointerenter", { pointerType: "mouse" });
  assert.ok(note.className.includes("peek"));
  note.fire("pointerleave", { pointerType: "mouse" });
  assert.ok(!note.className.includes("peek"), "leaving the note ends it too");
  // A sticker other than the one pointed at going away changes nothing.
  push(session({ cards, stamps }, PARTICIPANT));
  stickersOf(root, "one")[0].fire("pointerenter", { pointerType: "mouse" });
  push(session({ cards, stamps: [stamps[1]] }, PARTICIPANT));
  assert.ok(!note.className.includes("peek"));
});

test("when the faces finish loading, every note's stickers are looked at again", async () => {
  const ui = load({ host: "new", fonts: true });
  const cards = [card("c1", "went-well", "one")];
  ui.push(session({ cards }, PARTICIPANT));
  const note = noteWith(ui.root, "one");
  note.box = { left: 0, top: 0, width: 240, height: 60 };
  one(note, "note-text").box = { left: 40, top: 5, width: 150, height: 32 };
  ui.push(session({ cards, stamps: [st("s1", "idea", 0.5, 0.4)] }, PARTICIPANT));
  assert.equal(stickersOf(ui.root, "one")[0].className.includes("over"), true);
  // The face arrives, the words set narrower, and the note's size is the same.
  one(note, "note-text").box = { left: 40, top: 5, width: 40, height: 32 };
  assert.equal(stickersOf(ui.root, "one")[0].className.includes("over"), true, "stale until then");
  ui.fontsReady();
  await settled();
  assert.equal(stickersOf(ui.root, "one")[0].className.includes("over"), false);
  // A document with no font set is left alone.
  assert.doesNotThrow(() => load());
});

test("a pixel sticker is a whole number of device pixels a cell at every zoom, and is measured at that size", () => {
  // Fourteen cells of round(3 * ratio) device pixels: 3, 3, 4, 5, 6 and 9.
  const table = [[1, 42], [1.1, 38.18], [1.25, 44.8], [1.5, 46.67], [2, 42], [3, 42]];
  for (const [dpr, px] of table) {
    const ui = load({ dpr });
    const size = parseFloat(ui.document.documentElement.style["--px"]);
    assert.equal(Math.round(size * 100) / 100, px, "at " + dpr);
    assert.match(ui.document.documentElement.style["--px"], /px$/);
  }
  // The zoom changes: the window is resized, and the size follows.
  const ui = load({ dpr: 1 });
  ui.window.devicePixelRatio = 1.5;
  ui.fireWindow("resize");
  assert.equal(Math.round(parseFloat(ui.document.documentElement.style["--px"]) * 100) / 100, 46.67);

  // At 1.5 a pixel sticker is 46.67 across, 23.3 to its rim, and 19.3 counts
  // for lying on the words; a vinyl one is 21 and 17. Words begin 139 across:
  // a center at 120 reaches 139.3 as pixel art and 137 as vinyl.
  const big = load({ host: "new", dpr: 1.5 });
  const cards = [card("c1", "went-well", "one")];
  big.push(session({ cards }, PARTICIPANT));
  const note = noteWith(big.root, "one");
  note.box = { left: 0, top: 0, width: 240, height: 60 };
  one(note, "note-text").box = { left: 139, top: 5, width: 60, height: 32 };
  big.push(session({ cards, stamps: [st("s1", "p-idea", 0.5, 0.4), st("s2", "idea", 0.5, 0.4)] }, PARTICIPANT));
  assert.deepEqual(stickersOf(big.root, "one").map((n) => n.className.includes("over")), [true, false]);
  // And where one lands from the book: words from 38 to 112 on a note 44
  // tall. At 134 on the bottom edge a vinyl sticker reaches back to 113 and
  // is clear; a pixel one at this zoom reaches 110.7, so it goes on to 164.
  const lay = () => {
    const ui = load({ dpr: 1.5 });
    ui.push(session({ cards, stamps: [st("t0", "chat", 0.027, 1)] }));
    noteWith(ui.root, "one").box = { left: 0, top: 0, width: 240, height: 44 };
    one(noteWith(ui.root, "one"), "note-text").lines = [[38, 11, 112, 31]];
    return ui;
  };
  const pick = (name) => {
    const ui = lay();
    openBook(ui.root, "one");
    labeled(bookOf(ui.root), name).click();
    return ui.sent()[0].payload.x;
  };
  assert.equal(pick("Blocker, vinyl"), 0.563, "134");
  assert.equal(pick("Blocker, pixel"), 0.696, "164");
});

// ---- pixel dust

const dustOf = (ui) => byClass(ui.root, "dust");
// Place one sticker from the book on the note "one" and let it land.
function landed(name, opts = { host: "new", motion: true }, who = PARTICIPANT) {
  const ui = load(opts);
  const cards = [card("c1", "went-well", "one"), card("c2", "went-well", "two")];
  ui.push(session({ cards }, who));
  openBook(ui.root, "one");
  labeled(bookOf(ui.root), name).click();
  ui.document.animations.length = 0;
  const stamps = [{ id: "s1", ...ui.sent()[0].payload }];
  ui.push(session({ cards, stamps }, who));
  return { ui, cards, stamps, arcs: () => ui.document.animations.filter((a) => a.target.className.includes("dust")) };
}

test("a pixel sticker kicks up four cells of dust when its placer sets it down, and a vinyl one does not", () => {
  const pixel = landed("Great idea, pixel");
  const bits = dustOf(pixel.ui);
  assert.equal(bits.length, 4);
  assert.equal(pixel.arcs().length, 4);
  for (const bit of bits) {
    assert.equal(bit.tagName, "I", "not a control");
    assert.equal(bit.getAttribute("aria-hidden"), "true");
    assert.equal(bit.getAttribute("tabindex"), null);
    same(bit.parentNode, noteWith(pixel.ui.root, "one"), "on the note, outside the list of stickers");
    assert.match(bit.style.cssText, /^width:3px;height:3px;left:calc\(8px \+ 0\.027 \* \(100% - 16px\)\);top:calc\(calc\(1 \* \(100% \+ 8px\) - 4px\) \+ 18px\);background:var\(--(k|color-ink-soft)\)$/);
  }
  assert.match(src, /\.dust\{position:absolute;z-index:1;pointer-events:none\}/);
  assert.equal(stickersOf(pixel.ui.root, "one").length, 1, "dust is not a sticker");
  assert.equal(stickersOf(pixel.ui.root, "one")[0].getAttribute("aria-label"), "Great idea, pixel sticker, 1 of 1 on this note, counting from the bottom of the pile");
  // It starts at the moment of contact and each arc is the flight of that cell:
  // thrown up at 190, 250, 240 and 180 a second under 1500, so 253, 333, 320 and 240ms.
  assert.deepEqual(pixel.arcs().map((a) => [a.timing.delay, Math.round(a.timing.duration)]), [[142, 253], [142, 333], [142, 320], [142, 240]]);
  // Every step is a whole number of cells from where it began.
  for (const arc of pixel.arcs()) for (const f of arc.frames.slice(1)) for (const n of f.transform.match(/-?[\d.]+(?=px)/g) || []) assert.equal(Math.abs(Number(n)) % 3, 0, f.transform);

  assert.equal(dustOf(landed("Great idea, vinyl").ui).length, 0, "vinyl lands as it did");
  assert.equal(dustOf(landed("Great idea, pixel", { host: "new" }).ui).length, 0, "nothing where nothing moves");
});

test("dust is for a fresh landing by its placer only: not a teammate's, not the first paint, not a move", () => {
  const cards = [card("c1", "went-well", "one")];
  const mate = load({ host: "new", motion: true });
  mate.push(session({ cards }, PARTICIPANT));
  mate.push(session({ cards, stamps: [st("s1", "p-idea", 0.5, 1)] }, PARTICIPANT));
  assert.equal(dustOf(mate).length, 0, "a teammate's arrives lighter, without");
  assert.ok(mate.document.animations.some((a) => a.target.className.includes("st ")), "though it does arrive");

  const first = load({ host: "new", motion: true });
  first.push(session({ cards, stamps: [st("s1", "p-idea", 0.5, 1), st("s2", "p-laugh", 0.2, 1)] }, PARTICIPANT));
  assert.equal(dustOf(first).length, 0, "nothing on the first paint");

  const own = landed("Blocker, pixel", { host: "new", motion: true }, FACILITATOR);
  own.arcs().forEach((a) => a.finish());
  assert.equal(dustOf(own.ui).length, 0);
  const sticker = stickersOf(own.ui.root, "one")[0];
  sticker.fire("keydown", { key: "ArrowRight" });
  sticker.fire("keydown", { key: "f" });
  own.ui.runTimers(500);
  own.ui.push(session({ cards: own.cards, stamps: [{ ...own.stamps[0], x: 0.5 }] }, FACILITATOR));
  own.ui.push(session({ cards: own.cards, stamps: [{ ...own.stamps[0], x: 0.5 }, st("s9", "chat", 0.1, 0.1)] }, FACILITATOR));
  assert.equal(dustOf(own.ui).length, 0, "a move, a bring to front and a redraw raise none");
});

test("dust is always swept up: when an arc finishes, when it is canceled, when neither is heard, and when the note goes", () => {
  const finished = landed("Thank you, pixel");
  finished.arcs().forEach((a) => a.finish());
  assert.equal(dustOf(finished.ui).length, 0);
  finished.arcs().forEach((a) => a.cancel());
  finished.ui.runTimers();
  assert.equal(dustOf(finished.ui).length, 0, "ending twice is harmless");

  const canceled = landed("Thank you, pixel");
  canceled.arcs().forEach((a) => a.cancel());
  assert.equal(dustOf(canceled.ui).length, 0, "canceled: the note was hidden, or the tab put away");

  const silent = landed("Thank you, pixel");
  silent.ui.runTimers(300);
  assert.equal(dustOf(silent.ui).length, 4, "not before the arcs would have ended");
  silent.ui.runTimers(800);
  assert.equal(dustOf(silent.ui).length, 0, "and gone a little after, with nothing heard");

  const gone = landed("Thank you, pixel");
  gone.ui.push(session({ cards: [gone.cards[1]] }, PARTICIPANT));
  assert.equal(dustOf(gone.ui).length, 0, "the note took its dust with it");
  gone.arcs().forEach((a) => a.finish());
  gone.ui.runTimers();
  assert.equal(dustOf(gone.ui).length, 0);

  // Never more than twenty-four cells at once, however fast stickers land:
  // six bursts are on the board, and the seventh and later raise none.
  const ui = load({ host: "new", motion: true });
  const cards = Array.from({ length: 9 }, (_, i) => card("c" + i, "went-well", "note " + i));
  const stamps = [];
  ui.push(session({ cards }, PARTICIPANT));
  for (let i = 0; i < 9; i++) {
    one(byClass(ui.root, "note")[i], "more").click();
    menuItem(ui.root, "Add a sticker").click();
    labeled(bookOf(ui.root), "Me too, pixel").click();
    stamps.push({ id: "s" + i, ...ui.sent()[i].payload });
    ui.push(session({ cards, stamps }, PARTICIPANT));
  }
  assert.equal(dustOf(ui).length, 24);
  assert.equal(byClass(ui.root, "st").length, 9, "every sticker landed all the same");
  ui.document.animations.filter((a) => a.target.className.includes("dust")).forEach((a) => a.finish());
  assert.equal(dustOf(ui).length, 0);
});

// ---- editing a note's words

const editorOf = (root) => all(root, (n) => n.tagName === "TEXTAREA" && n.className === "note-edit")[0];
const NOT_YOURS = "Only the person who wrote a note can edit it.";

test("a note's words are edited in place from its menu, E, F2 or a double click; Enter saves and the note is believed when the state shows it", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const note = noteWith(ui.root, "two");
  byMenu(ui, "two", "Edit note");
  const area = editorOf(ui.root);
  assert.ok(area, "the menu opens the editor");
  same(area.parentNode, note, "inside the note itself");
  assert.equal(area.value, "two");
  assert.equal(area.getAttribute("maxlength"), "500");
  assert.equal(area.getAttribute("aria-label"), "Edit note: two");
  same(ui.document.activeElement, area);
  assert.ok(note.className.split(" ").includes("editing"));
  assert.equal(liveOf(ui.root), "Editing. Enter saves, Escape cancels.");
  const save = button(note, "Save");
  assert.ok(button(note, "Cancel"));

  area.type("   ");
  assert.equal(save.disabled, true, "a note cannot be saved empty");
  assert.match(one(note, "edit-said").textContent, /A note needs words\. To remove it, use Delete in its menu\./);
  area.fire("keydown", ENTER);
  assert.deepEqual(ui.sent(), []);

  area.type("x".repeat(450));
  assert.equal(one(note, "edit-said").textContent, "50 characters left", "the limit is said as it is approached");
  area.type("two, reworded");
  assert.equal(one(note, "edit-said").hidden, true);
  area.fire("keydown", { key: "Enter", shiftKey: true });
  area.fire("keydown", { key: "Enter", isComposing: true });
  assert.deepEqual(ui.sent(), [], "Shift and Enter is a new line; an input method's Enter is its own");
  area.fire("keydown", ENTER);
  assert.deepEqual(ui.sent(), [{ action: "edit-card", payload: { cardId: "c2", text: "two, reworded" } }]);
  assert.equal(area.readOnly, true, "pending");
  assert.equal(save.disabled, true);
  assert.equal(one(note, "edit-said").textContent, "Saving…");
  area.fire("keydown", ENTER);
  save.click();
  assert.equal(ui.sent().length, 1, "no second send while the first is out");
  // The host says yes: not believed until the state shows the words.
  ui.acts[0].answer({ ok: true });
  await settled();
  assert.ok(editorOf(ui.root), "a yes alone does not close it");
  ui.push(session({ cards: [three[0], { ...three[1], text: "two, reworded", edited: true }, three[2]] }, PARTICIPANT));
  absent(editorOf(ui.root), "the state shows it: the editor is gone");
  assert.ok(!note.className.includes("editing"));
  assert.equal(one(note, "note-text").textContent, "two, reworded");
  same(ui.document.activeElement, one(note, "more"), "focus is back on the note's menu button");
  assert.equal(one(note, "edited").hidden, false, "and the note says it was edited, in a word");
  assert.equal(one(note, "edited").textContent, "edited");
  assert.equal(one(noteWith(ui.root, "one"), "edited").hidden, true);

  // The other ways in.
  for (const open of [(n) => n.fire("keydown", { key: "e" }), (n) => n.fire("keydown", { key: "F2" }), (n) => one(n, "note-text").fire("dblclick")]) {
    open(noteWith(ui.root, "one"));
    assert.equal(editorOf(ui.root).value, "one");
    editorOf(ui.root).fire("keydown", { key: "Escape" });
    absent(editorOf(ui.root), "Escape cancels");
    same(ui.document.activeElement, one(noteWith(ui.root, "one"), "more"));
  }
  noteWith(ui.root, "one").fire("keydown", { key: "e", ctrlKey: true });
  noteWith(ui.root, "one").fire("keydown", { key: "e", target: editorOf(ui.root) || { tagName: "TEXTAREA" } });
  absent(editorOf(ui.root), "a chord, or an e typed into a box, opens nothing");
  assert.equal(ui.sent().length, 1, "canceling sent nothing");
  // Saving words that did not change sends nothing either.
  noteWith(ui.root, "one").fire("keydown", { key: "e" });
  editorOf(ui.root).fire("keydown", ENTER);
  absent(editorOf(ui.root));
  assert.equal(ui.sent().length, 1);
});

test("a teammate's change while a note is being edited leaves the draft, the editor and the focus where they are", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  noteWith(ui.root, "two").fire("keydown", { key: "e" });
  const area = editorOf(ui.root);
  area.type("two, half typ");
  // A vote on this note, a new note, and the note itself moved to another lane.
  ui.push(session({ cards: [three[0], { ...three[1], voteCount: 1 }, three[2], card("c4", "puzzles", "four")] }, PARTICIPANT));
  ui.push(session({ cards: [three[0], three[2], { ...three[1], columnId: "puzzles", voteCount: 1 }, card("c4", "puzzles", "four")] }, PARTICIPANT));
  same(editorOf(ui.root), area, "the same box");
  assert.equal(area.value, "two, half typ");
  same(ui.document.activeElement, area, "still holding focus");
  assert.equal(noteOrder(ui.root, "Puzzles"), "two four", "the note went where it was moved, editor and all");
  // Somebody else rewording it meanwhile does not write over what is being typed.
  ui.push(session({ cards: [three[0], three[2], { ...three[1], columnId: "puzzles", text: "two, by its author elsewhere", edited: true }] }, PARTICIPANT));
  assert.equal(area.value, "two, half typ");

  // While it is open the note is not dragged, and a second editor does not throw the first away.
  const grip = one(noteWith(ui.root, "half") || area.parentNode, "grip");
  grip.fire("pointerdown", { clientX: 10, clientY: 10 });
  ui.fireWindow("pointermove", { clientX: 10, clientY: 60 });
  assert.equal(byClass(ui.root, "drag").length, 0, "no drag while its words are being typed");
  ui.fireWindow("pointerup", { clientX: 10, clientY: 60 });
  noteWith(ui.root, "one").fire("keydown", { key: "e" });
  assert.equal(all(ui.root, (n) => n.tagName === "TEXTAREA" && n.className === "note-edit").length, 1, "one editor at a time");
  same(editorOf(ui.root), area);
  assert.equal(toastOf(ui.root).textContent, "Save or cancel the note you are editing first.");
  // With nothing changed in the first, the second simply takes over.
  area.type("two, by its author elsewhere");
  noteWith(ui.root, "one").fire("keydown", { key: "e" });
  assert.equal(editorOf(ui.root).value, "one");
});

test("a refused edit keeps what was typed, says why, and a note known to be somebody else's is not offered for editing again", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  noteWith(ui.root, "two").fire("keydown", { key: "e" });
  const area = editorOf(ui.root);
  area.type("not mine to change");
  area.fire("keydown", ENTER);
  ui.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(ui.root).textContent, NOT_YOURS);
  same(editorOf(ui.root), area, "the editor stays, with the words");
  assert.equal(area.value, "not mine to change");
  assert.equal(area.readOnly, false);
  assert.equal(one(noteWith(ui.root, "two") || area.parentNode, "note-text").textContent, "two", "the note itself was never changed");
  area.fire("keydown", { key: "Escape" });
  area.fire("keydown", { key: "Escape" });
  // Remembered for the visit: the menu says why, and the keys do too.
  one(noteWith(ui.root, "two"), "more").click();
  assert.equal(menuItem(ui.root, "Edit note").getAttribute("aria-disabled"), "true");
  menuItem(ui.root, "Edit note").click();
  assert.equal(toastOf(ui.root).textContent, NOT_YOURS);
  ui.press("Escape");
  noteWith(ui.root, "two").fire("keydown", { key: "F2" });
  absent(editorOf(ui.root));
  assert.equal(ui.acts.length, 1, "the server is not asked again");
  // Nobody answers at all: the words are still there, and it can be sent again.
  noteWith(ui.root, "one").fire("keydown", { key: "e" });
  editorOf(ui.root).type("one, again");
  editorOf(ui.root).fire("keydown", ENTER);
  ui.runTimers(WAIT);
  assert.match(toastOf(ui.root).textContent, /Could not confirm that the note was saved\. Your words are still in the box\./);
  assert.equal(editorOf(ui.root).value, "one, again");
  assert.equal(button(noteWith(ui.root, "one"), "Save").disabled, false);

  // After the reveal the board knows whose a note is.
  const shown = load({ host: "new" });
  const cards = [card("c1", "went-well", "mine", { authorId: "u-bo" }), card("c2", "went-well", "hers", { authorId: "u-cy" })];
  shown.push(session({ revealed: true, cards }, PARTICIPANT));
  noteWith(shown.root, "hers").fire("keydown", { key: "e" });
  absent(editorOf(shown.root));
  assert.equal(toastOf(shown.root).textContent, NOT_YOURS);
  noteWith(shown.root, "mine").fire("keydown", { key: "e" });
  assert.equal(editorOf(shown.root).value, "mine");
  // The facilitator has no way in to other people's words either.
  const lead = load({ host: "new" });
  lead.push(session({ revealed: true, cards }, FACILITATOR));
  noteWith(lead.root, "hers").fire("keydown", { key: "e" });
  absent(editorOf(lead.root));
});

test("a note deleted while it is being edited does not take the draft with it: the words go to its lane's box, and it is said", () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 1, cards: three }, PARTICIPANT));
  noteWith(ui.root, "two").fire("keydown", { key: "e" });
  editorOf(ui.root).type("two, with a lot more thought");
  ui.push(session({ stage: 1, cards: [three[0], three[2]] }, PARTICIPANT));
  absent(editorOf(ui.root));
  const box = composer(ui.root, "Went well");
  assert.equal(box.value, "two, with a lot more thought");
  assert.equal(visible(box), true, "the box is open, though the room is past Write");
  same(ui.document.activeElement, box);
  assert.equal(toastOf(ui.root).textContent, "That note was deleted while you were editing it. Your words are in the box above, ready to add as a new note.");
  // Nothing typed, nothing to rescue: it only says the note is gone.
  noteWith(ui.root, "one").fire("keydown", { key: "e" });
  ui.push(session({ stage: 1, cards: [three[2]] }, PARTICIPANT));
  assert.equal(toastOf(ui.root).textContent, "That note is no longer on the board.");
  assert.equal(box.value, "two, with a lot more thought");
  // And an edit made by its author is announced to the others without a name.
  ui.push(session({ stage: 1, cards: [{ ...three[2], text: "three, reworded", edited: true }] }, PARTICIPANT));
  assert.equal(liveOf(ui.root), "A note in Went well was edited.");
});

// ---- thumbs up and down

// A note's score tag as it reads, or null where there is none.
const tallyOf = (root, text) => one(noteWith(root, text), "tally");
const tagOf = (root, text) => (tallyOf(root, text).hidden ? null : one(tallyOf(root, text), "score").textContent);
const tagClass = (root, text) => one(tallyOf(root, text), "score").className;
// "unknown" where the thumb says nothing about being pressed.
const pressedOf = (ui, text = "one") => ["up", "down"].map((way) => thumb(ui.root, text, way).getAttribute("aria-pressed") ?? "unknown").join(" ");
// Long enough after a press that the next one is a press of its own.
const later = (ui) => (ui.clock.t += 1000);

test("a vote is set, not flipped: up, a switch to down in one press, and the held thumb pressed again takes it back", async () => {
  const ui = load({ host: "new" });
  const cards = (up, down) => [card("c1", "went-well", "one", { up, down })];
  ui.push(session({ stage: 2, cards: cards(0, 0) }, PARTICIPANT));
  const up = thumb(ui.root, "one", "up");
  const down = thumb(ui.root, "one", "down");
  assert.equal(up.getAttribute("aria-label"), "Vote up: one. No votes yet.");
  assert.equal(down.getAttribute("aria-label"), "Vote down: one. No votes yet.");
  assert.equal(up.getAttribute("title"), "Vote up (U)");
  assert.equal(down.getAttribute("title"), "Vote down (D)");
  assert.equal(pressedOf(ui), "unknown unknown", "nothing is claimed before the server has been heard");
  assert.equal(up.textContent + down.textContent, "", "the thumbs carry no counts");

  up.click();
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "up" } });
  assert.equal(pressedOf(ui), "true false", "pressed at once, while it is on its way");
  down.click();
  assert.equal(ui.sent().length, 1, "one at a time: a second press waits for the first");
  ui.acts[0].answer({ ok: true });
  await settled();
  ui.push(session({ stage: 2, cards: cards(1, 0) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "true false");
  assert.equal(up.getAttribute("aria-label"), "Vote up: one. Score +1: 1 up, 0 down. Your vote. Press to take it back.");
  assert.equal(up.getAttribute("title"), "Your vote. Press to take it back (U)");
  assert.equal(tagOf(ui.root, "one"), "+1");
  assert.equal(liveOf(ui.root), "", "the push that shows it says nothing more");

  down.click();
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "down" } }, "one press switches");
  ui.acts[1].answer({ ok: true });
  await settled();
  assert.equal(liveOf(ui.root), "Voted down.");
  ui.push(session({ stage: 2, cards: cards(0, 1) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "false true");

  later(ui);
  down.click();
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "none" } }, "the held thumb, pressed again, takes the vote back");
  assert.equal(pressedOf(ui), "false false");
  ui.acts[2].answer({ ok: true });
  await settled();
  assert.equal(liveOf(ui.root), "Vote taken back.");
  ui.push(session({ stage: 2, cards: cards(0, 0) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "false false");
  // Known to have none: the next press sets again.
  later(ui);
  up.click();
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "up" } });
});

test("after a reload a press on the thumb somebody already holds sets it again and never removes it", async () => {
  // This viewer voted up before reloading. The board shows one up vote and cannot say whose.
  const ui = load({ host: "new" });
  const cards = [card("c1", "went-well", "one", { up: 1, down: 0 })];
  ui.push(session({ stage: 2, cards }, PARTICIPANT));
  assert.equal(pressedOf(ui), "unknown unknown", "not known to be theirs, and not said to be nobody's");
  assert.equal(thumb(ui.root, "one", "up").getAttribute("aria-pressed"), null);
  thumb(ui.root, "one", "up").click();
  assert.deepEqual(ui.sent(), [{ action: "vote", payload: { cardId: "c1", value: "up" } }], "it asks for up, which they already have: never for none");
  // The server takes it and nothing changes: no push comes. The yes is all there is.
  ui.acts[0].answer({ ok: true });
  await settled();
  assert.equal(pressedOf(ui), "true false", "now known to be theirs");
  assert.equal(liveOf(ui.root), "Voted up.");
  ui.runTimers(WAIT);
  assert.equal(toastOf(ui.root).hidden, true, "and a yes with nothing to show for it is not called unconfirmed");
  assert.equal(pressedOf(ui), "true false");
  // Only now does the same thumb take it back.
  later(ui);
  thumb(ui.root, "one", "up").click();
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "none" } });

  // A host that answers nothing: the board stays not knowing, says so once, and still never sends none.
  const old = load();
  old.push(session({ stage: 2, cards }));
  thumb(old.root, "one", "up").click();
  old.runTimers(WAIT);
  assert.match(toastOf(old.root).textContent, /No change to show\. Your vote may already have been counted that way\./);
  assert.equal(pressedOf(old), "unknown unknown");
  later(old);
  thumb(old.root, "one", "up").click();
  assert.deepEqual(old.sent().map((a) => a.payload.value), ["up", "up"]);
});

test("a refused vote is put back and says why; the state arriving before the answer does not lose it", async () => {
  const ui = load({ host: "new" });
  const cards = (up) => [card("c1", "went-well", "one", { up })];
  ui.push(session({ stage: 2, cards: cards(0) }, PARTICIPANT));
  thumb(ui.root, "one", "up").click();
  ui.acts[0].answer({ ok: false, reason: "conflict" });
  await settled();
  assert.equal(pressedOf(ui), "unknown unknown");
  // Said on the note, and with no Try again: asking again would get the same answer.
  const oops = one(noteWith(ui.root, "one"), "oops");
  assert.equal(oops.textContent, "That vote was not counted. The board has all the votes it can hold.");
  absent(button(oops, "Try again"));
  assert.equal(ui.sent().length, 1, "and it is not sent again");
  labeled(oops, "Dismiss").click();
  assert.equal(byClass(ui.root, "oops").length, 0);
  // The push first, the yes after.
  later(ui);
  thumb(ui.root, "one", "up").click();
  ui.push(session({ stage: 2, cards: cards(1) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "true false", "still shown as on its way");
  ui.acts[1].answer({ ok: true });
  await settled();
  assert.equal(pressedOf(ui), "true false");
  assert.match(thumb(ui.root, "one", "up").getAttribute("aria-label"), /Your vote\. Press to take it back\.$/);
  // U and D on the note do what the thumbs do.
  noteWith(ui.root, "one").fire("keydown", { key: "d" });
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "down" } });
  ui.acts[2].answer({ ok: true });
  await settled();
  later(ui);
  noteWith(ui.root, "one").fire("keydown", { key: "D" });
  assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "none" } });
  noteWith(ui.root, "one").fire("keydown", { key: "u", ctrlKey: true });
  assert.equal(ui.sent().length, 4, "a chord is not a vote");
});

test("the thumbs are buttons on every note in every stage, with no counts in them; a note with votes has no row for them", () => {
  const { root, push } = load();
  const cards = [card("c1", "went-well", "bare"), card("c2", "went-well", "liked", { up: 2 }), card("c3", "went-well", "disliked", { down: 1 })];
  for (const stage of [0, 1, 2, 3]) {
    push(session({ stage, cards }));
    for (const text of ["bare", "liked", "disliked"]) {
      assert.deepEqual(["up", "down"].map((w) => visible(thumb(root, text, w))), [true, true], text + ", stage " + stage);
      assert.equal(one(noteWith(root, text), "chips").hidden, stage !== 3, "no row under the words for votes: " + text + ", stage " + stage);
    }
  }
  assert.equal(thumb(root, "liked", "up").getAttribute("aria-label"), "Vote up: liked. Score +2: 2 up, 0 down.");
  // The thumb is one outline, drawn as a line in a box set on its own bounds, and turned over for down.
  const glyph = thumb(root, "liked", "up").children[0];
  assert.equal(glyph.getAttribute("viewBox"), "6.1 5.84 29 29");
  assert.equal(glyph.children.length, 1);
  assert.equal(glyph.children[0].getAttribute("stroke"), "currentColor");
  assert.match(src, /\.rate\.down svg\{transform:scaleY\(-1\)\}/);
  // Shown: pointed at or focused, in the Vote stage, or with the viewer's own vote known. Hidden is faint, not gone.
  assert.match(src, /\.rb\{[^}]*opacity:0;/);
  assert.match(src, /\.note:hover \.rb,\.note:focus-within \.rb,\.stage-2 \.rate,\.rate\.known,\.add-st\[aria-expanded="true"\]\{opacity:1\}/);
  assert.doesNotMatch(src, /\.rb\{[^}]*display:none/);
  // Pressed is a filled thumb and a ring, not a color alone.
  assert.match(src, /\.rate\[aria-pressed="true"\]\{border-color:var\(--color-accent\);background:var\(--color-accent-soft\);box-shadow:0 0 0 1px var\(--color-accent\);color:var\(--color-accent\)\}/);
  assert.match(src, /\.rate\[aria-pressed="true"\] path\{fill:currentColor\}/);
});

test("Top rated ranks by ups less downs, then by more ups, and a group says its score and its ups and downs", () => {
  const { root, push } = load();
  const cards = [
    card("c1", "went-well", "one", { up: 1 }),
    card("c2", "went-well", "two", { up: 4, down: 3 }),
    card("c3", "went-well", "three", { down: 2 }),
    card("c4", "went-well", "four", { up: 3 }),
    card("c5", "went-well", "five"),
  ];
  push(session({ cards }));
  const toggle = button(lane(root, "Went well"), "Top rated");
  assert.equal(toggle.getAttribute("aria-label"), "Top rated first in Went well, only for you");
  toggle.click();
  // four is 3; two and one are both 1, two with more ups; five is 0; three is -2.
  assert.equal(noteOrder(root, "Went well"), "four two one five three");

  // A lane with only down votes can be sorted too.
  const down = load();
  down.push(session({ cards: [card("c1", "puzzles", "a", { down: 1 }), card("c2", "puzzles", "b")] }));
  button(lane(down.root, "Puzzles"), "Top rated").click();
  assert.equal(noteOrder(down.root, "Puzzles"), "b a");

  const grouped = load();
  const g = [{ id: "g1", columnId: "went-well", title: "Pair" }];
  grouped.push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1", up: 6 }), card("c2", "went-well", "two", { groupId: "g1", up: 0, down: 1 })], groups: g }));
  assert.equal(one(grouped.root, "group-meta").textContent, "2 notes · +5 (6 up · 1 down)", "six up and one down is five, not seven");
  grouped.push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1" }), card("c2", "went-well", "two", { groupId: "g1" })], groups: g }));
  assert.equal(one(grouped.root, "group-meta").textContent, "2 notes", "nothing to say, nothing said");
  // A server from before there were two directions sends one count, which is all ups.
  grouped.push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1", voteCount: 3 }), card("c2", "went-well", "two", { groupId: "g1" })], groups: g }));
  assert.equal(one(grouped.root, "group-meta").textContent, "2 notes · +3", "no downs, no split");
  grouped.push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1", up: 2, down: 2 }), card("c2", "went-well", "two", { groupId: "g1", up: 3, down: 3 })], groups: g }));
  assert.equal(one(grouped.root, "group-meta").textContent, "2 notes · \u00b10 (5 up · 5 down)");
  grouped.push(session({ cards: [card("c1", "went-well", "one", { groupId: "g1", down: 2 }), card("c2", "went-well", "two", { groupId: "g1" })], groups: g }));
  assert.equal(one(grouped.root, "group-meta").textContent, "2 notes · \u22122 (2 down)");
});

test("the viewer's own vote gets a small press and a teammate's only moves the number; nothing moves on first load or where less motion is asked for", async () => {
  const ui = load({ host: "new", motion: true });
  ui.push(session({ stage: 2, cards: [card("c1", "went-well", "one", { up: 2 }), card("c2", "went-well", "two")] }, PARTICIPANT));
  const on = (name) => ui.document.animations.filter((a) => a.target.className.split(" ").includes(name) || a.target.tagName === name);
  assert.equal(on("score").length + on("B").length + on("SVG").length, 0, "nothing moves on the first load");
  ui.push(session({ stage: 2, cards: [card("c1", "went-well", "one", { up: 3 }), card("c2", "went-well", "two", { up: 1 })] }, PARTICIPANT));
  assert.equal(on("SVG").length, 0, "a teammate's vote does not press a thumb");
  assert.equal(on("B").length, 1, "the number that changed ticks");
  same(on("B")[0].target, one(tallyOf(ui.root, "one"), "score").children[0]);
  assert.equal(on("score").length, 1, "and a note's first tag pops in");
  same(on("score")[0].target, one(tallyOf(ui.root, "two"), "score"));
  ui.document.animations.length = 0;
  thumb(ui.root, "one", "down").click();
  ui.acts[0].answer({ ok: true });
  await settled();
  assert.equal(on("SVG").length, 1, "the viewer's own presses the thumb");
  same(on("SVG")[0].target, thumb(ui.root, "one", "down").children[0]);
  assert.equal(on("score").length, 1, "and the tag takes the hit");

  const still = load({ host: "new" });
  still.push(session({ stage: 2, cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  thumb(still.root, "one", "up").click();
  still.acts[0].answer({ ok: true });
  await settled();
  still.push(session({ stage: 2, cards: [card("c1", "went-well", "one", { up: 1 })] }, PARTICIPANT));
  assert.equal(still.document.animations.length, 0);
});

test("the tag is ups less downs with its sign: six up and one down is +5, never a count of votes", () => {
  const { root, push } = load();
  // up, down -> the tag, its classes, its name, the split beside it, the share of the rule that is up.
  const table = [
    [6, 1, "+5", "score pos mixed", "Score +5: 6 up, 1 down", "6 up \u00b7 1 down", "86%"],
    [5, 5, "\u00b10", "score mixed", "Score 0: 5 up, 5 down", "5 up \u00b7 5 down", "50%"],
    [0, 2, "\u22122", "score neg", "Score \u22122: 0 up, 2 down", "0 up \u00b7 2 down", "0%"],
    [3, 0, "+3", "score pos", "Score +3: 3 up, 0 down", "3 up \u00b7 0 down", "100%"],
    [1, 2, "\u22121", "score neg mixed", "Score \u22121: 1 up, 2 down", "1 up \u00b7 2 down", "33%"],
    [4, 1, "+3", "score pos mixed", "Score +3: 4 up, 1 down", "4 up \u00b7 1 down", "80%"],
  ];
  for (const [up, down, tag, cls, name, split, share] of table) {
    push(session({ cards: [card("c1", "went-well", "one", { up, down })] }));
    const what = up + " up, " + down + " down";
    assert.equal(tagOf(root, "one"), tag, what);
    assert.equal(tagClass(root, "one"), cls, what);
    assert.equal(tallyOf(root, "one").getAttribute("aria-label"), name, what);
    assert.equal(one(tallyOf(root, "one"), "brk").textContent, split, what);
    assert.equal(one(tallyOf(root, "one"), "score").style["--u"], share, what);
    assert.equal(thumb(root, "one", "down").getAttribute("aria-label"), "Vote down: one. " + name + ".", what);
  }
  // No votes: no tag at all, and the thumbs say so.
  push(session({ cards: [card("c1", "went-well", "one", { up: 0, down: 0 })] }));
  assert.equal(tagOf(root, "one"), null);
  assert.equal(thumb(root, "one", "up").getAttribute("aria-label"), "Vote up: one. No votes yet.");
  // It is a picture with a name, not a control, and a press on its corner goes through it.
  assert.equal(tallyOf(root, "one").getAttribute("role"), "img");
  assert.equal(all(tallyOf(root, "one"), (n) => n.tagName === "BUTTON").length, 0);
  assert.match(src, /\.tally\{[^}]*pointer-events:none\}/);
  // A down count the server sends below nothing is nothing, not a negative number to add.
  push(session({ cards: [card("c1", "went-well", "one", { up: 6, down: -1 })] }));
  assert.equal(tagOf(root, "one"), "+6");
  assert.equal(one(tallyOf(root, "one"), "brk").textContent, "6 up \u00b7 0 down");
});

test("Top rated sorts on the same score the tags show, ties by more ups, then as they stood", () => {
  const { root, push } = load();
  const cards = [
    card("c1", "went-well", "aa", { up: 6, down: 1 }),
    card("c2", "went-well", "bb", { up: 7, down: 0 }),
    card("c3", "went-well", "cc", { up: 5, down: 0 }),
    card("c4", "went-well", "dd", { up: 5, down: 5 }),
    card("c5", "went-well", "ee"),
    card("c6", "went-well", "ff", { down: 2 }),
  ];
  push(session({ cards }));
  assert.deepEqual(["aa", "bb", "cc", "dd", "ee", "ff"].map((t) => tagOf(root, t)), ["+5", "+7", "+5", "\u00b10", null, "\u22122"]);
  button(lane(root, "Went well"), "Top rated").click();
  // bb is 7; aa and cc are both 5, aa with more ups; dd and ee are both 0, dd with more ups; ff is -2.
  assert.equal(noteOrder(root, "Went well"), "bb aa cc dd ee ff");
});

test("the thumbs stay in sight once the viewer's own vote is known, and not before", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 0, cards: [card("c1", "went-well", "one", { up: 1 })] }, PARTICIPANT));
  const known = () => ["up", "down"].map((w) => thumb(ui.root, "one", w).className.split(" ").includes("known")).join(" ");
  assert.equal(known(), "false false", "after a reload whose vote that is is not known");
  thumb(ui.root, "one", "up").click();
  assert.equal(known(), "true true", "shown while it is on its way");
  ui.acts[0].answer({ ok: true });
  await settled();
  assert.equal(known(), "true true", "and once it is theirs: both, so a switch is one press");
  later(ui);
  thumb(ui.root, "one", "up").click();
  ui.acts[1].answer({ ok: true });
  await settled();
  assert.equal(known(), "false false", "taken back, there is no vote of theirs to keep in sight");
  assert.equal(pressedOf(ui), "false false");
});

test("a vote that does not go through is sent once more, quietly; if that fails too, the note says so and offers to try again", async () => {
  for (const reason of ["busy", "failed", "unreachable", "rate-limited"]) {
    const ui = load({ host: "new" });
    ui.push(session({ stage: 2, cards: [card("c1", "went-well", "one", { up: 4, down: 1 })] }, PARTICIPANT));
    const up = thumb(ui.root, "one", "up");
    up.click();
    ui.acts[0].answer({ ok: false, reason });
    await settled();
    assert.equal(ui.sent().length, 1, reason + ": not at once");
    assert.equal(pressedOf(ui), "true false", reason + ": still shown as on its way");
    assert.equal(toastOf(ui.root).hidden, true, reason + ": and nothing is said yet");
    assert.equal(byClass(ui.root, "oops").length, 0);
    up.click();
    assert.equal(ui.sent().length, 1, "a press while it waits sends nothing");
    ui.runTimers(600);
    assert.deepEqual(ui.sent(), [{ action: "vote", payload: { cardId: "c1", value: "up" } }, { action: "vote", payload: { cardId: "c1", value: "up" } }], reason + ": the same vote, once more");
    ui.acts[1].answer({ ok: false, reason });
    await settled();
    ui.runTimers(600);
    assert.equal(ui.sent().length, 2, reason + ": and not a third time by itself");
    assert.equal(pressedOf(ui), "unknown unknown", reason + ": the thumb is back as it was");
    assert.equal(tagOf(ui.root, "one"), "+3", reason + ": the tag never moved");
    const oops = one(noteWith(ui.root, "one"), "oops");
    assert.equal(oops.getAttribute("role"), "group");
    assert.equal(oops.getAttribute("aria-label"), "Vote not counted");
    assert.equal(oops.textContent, "Your vote did not go through.Try again", reason + ": the board's words, never the server's");
    assert.equal(toastOf(ui.root).hidden, true, "said on the note, not in a toast a screen away");
    same(ui.document.activeElement, button(oops, "Try again"));
    assert.equal(liveOf(ui.root), "Your vote on this note did not go through. Try again is available.");
    assert.ok(up.className.split(" ").includes("failed"));

    button(oops, "Try again").click();
    assert.equal(byClass(ui.root, "oops").length, 0);
    assert.ok(!up.className.split(" ").includes("failed"));
    same(ui.document.activeElement, up);
    assert.deepEqual(ui.sent().at(-1), { action: "vote", payload: { cardId: "c1", value: "up" } });
    ui.acts[2].answer({ ok: true });
    await settled();
    assert.equal(pressedOf(ui), "true false");
    assert.equal(liveOf(ui.root), "Voted up.");
  }
});

test("a quiet second try that lands leaves no trace, and a known vote stays shown when a switch fails", async () => {
  const ui = load({ host: "new" });
  const cards = (up, down) => [card("c1", "went-well", "one", { up, down })];
  ui.push(session({ stage: 2, cards: cards(0, 0) }, PARTICIPANT));
  thumb(ui.root, "one", "up").click();
  ui.acts[0].answer({ ok: false, reason: "busy" });
  await settled();
  ui.runTimers(600);
  ui.acts[1].answer({ ok: true });
  await settled();
  ui.push(session({ stage: 2, cards: cards(1, 0) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "true false");
  assert.equal(byClass(ui.root, "oops").length, 0);
  assert.equal(toastOf(ui.root).hidden, true);
  assert.equal(tagOf(ui.root, "one"), "+1");

  // Now a switch to down that fails twice: the up vote is still theirs, and still shown.
  later(ui);
  thumb(ui.root, "one", "down").click();
  assert.equal(pressedOf(ui), "false true");
  assert.equal(tagOf(ui.root, "one"), "+1", "the tag waits for the vote to land");
  ui.acts[2].answer({ ok: false, reason: "failed" });
  await settled();
  ui.runTimers(600);
  ui.acts[3].answer({ ok: false, reason: "failed" });
  await settled();
  assert.equal(pressedOf(ui), "true false", "the previous vote stays shown");
  assert.equal(tagOf(ui.root, "one"), "+1");
  // Dismissed, it is gone, and focus is on the thumb that was pressed.
  labeled(one(ui.root, "oops"), "Dismiss").click();
  assert.equal(byClass(ui.root, "oops").length, 0);
  same(ui.document.activeElement, thumb(ui.root, "one", "down"));
});

test("a vote the bridge cannot carry is tried again the same way", () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 2, cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  ui.bridge.fail = "throw";
  thumb(ui.root, "one", "up").click();
  assert.equal(byClass(ui.root, "oops").length, 0);
  ui.runTimers(600);
  assert.equal(ui.sent().length, 2);
  assert.equal(one(ui.root, "oops").textContent, "Your vote did not go through.Try again");
  assert.equal(pressedOf(ui), "unknown unknown");
});

test("a sticker's default spot keeps off the buttons on the note's lower edge", () => {
  const ui = load();
  ui.push(session({ cards: [card("c1", "went-well", "one")] }));
  const note = noteWith(ui.root, "one");
  note.box = { left: 0, top: 0, width: 240, height: 44 };
  // The three buttons stand from 116 to 200 across, 32 to 56 down. A sticker
  // on the bottom edge is 27 to 69 down, so it must end 6 short of 116:
  // its center at 89 or less. 14, 44 and 74 are; 104 is not; of the row
  // between, 29, 59 and 89 are.
  one(note, "rx").box = { left: 116, top: 32, width: 84, height: 24 };
  const picks = ["Blocker, vinyl", "Blocker, pixel", "Thank you, vinyl", "Me too, vinyl"].map((name) => {
    openBook(ui.root, "one");
    labeled(bookOf(ui.root), name).click();
    return ui.sent().at(-1).payload.x;
  });
  assert.deepEqual(picks.slice(0, 3), [0.027, 0.161, 0.295]);
  // The fourth is another viewer's limit of three: nothing more is sent.
  assert.equal(ui.sent().length, 3);
  const more = load();
  more.push(session({ cards: [card("c1", "went-well", "one")], stamps: [0.027, 0.161, 0.295].map((x, i) => st("t" + i, "laugh", x, 1)) }));
  noteWith(more.root, "one").box = { left: 0, top: 0, width: 240, height: 44 };
  one(noteWith(more.root, "one"), "rx").box = { left: 116, top: 32, width: 84, height: 24 };
  openBook(more.root, "one");
  labeled(bookOf(more.root), "Great idea, vinyl").click();
  assert.equal(more.sent()[0].payload.x, 0.094, "then 29: between the first two, not 104 under the buttons");
});

// ---- review round: keys, double presses, leaving the editor

test("a note's letters are shortcuts only from the note or its words: not from a button, not from a box being typed in, not while it is edited", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 2, cards: three }, PARTICIPANT));
  const note = noteWith(ui.root, "two");
  const words = one(note, "note-text");
  assert.equal(words.getAttribute("tabindex"), "0", "the words can take focus, to be the place the keys are pressed");
  const quiet = () => ui.sent().length === 0 && byClass(ui.root, "pop").length === 0 && !editorOf(ui.root);
  const type = (target, text) => [...text].forEach((key) => note.fire("keydown", { key, target }));
  // From each of the note's own buttons.
  for (const name of ["grip", "more", "rate"]) type(one(note, name), "duesDUES");
  note.fire("keydown", { key: "F2", target: one(note, "more") });
  assert.ok(quiet(), "letters pressed on a button do nothing");
  // Typed into a box: the lane's composer, and a box inside the note.
  const box = composer(ui.root, "Went well");
  box.type("due used 123 svp");
  type(box, "due used 123 svp");
  type({ tagName: "TEXTAREA" }, "due used 123 svp");
  type({ tagName: "INPUT" }, "due used 123 svp");
  assert.ok(quiet(), "typing is typing");
  // From the words: E edits.
  note.fire("keydown", { key: "e", target: words });
  const area = editorOf(ui.root);
  assert.ok(area);
  // With the editor open: nothing from the textarea, Save, Cancel, the words or the note itself.
  for (const target of [area, button(note, "Save"), button(note, "Cancel"), words, note]) type(target, "due used 123 svp");
  note.fire("keydown", { key: "F2", target: button(note, "Save") });
  assert.deepEqual(ui.sent(), [], "no vote was cast and nothing was sent");
  assert.equal(byClass(ui.root, "pop").length, 0, "no sticker book opened");
  same(editorOf(ui.root), area, "and the editor is the one that was open");
  assert.equal(area.value, "two", "untouched");
  area.fire("keydown", { key: "Escape" });
  // And from the words again, with nothing open, they are shortcuts.
  note.fire("keydown", { key: "u", target: words });
  assert.deepEqual(ui.sent(), [{ action: "vote", payload: { cardId: "c2", value: "up" } }]);
  note.fire("keydown", { key: "s", target: note });
  assert.equal(byClass(ui.root, "book-pop").length, 1);
});

test("two presses of a thumb in quick succession are one vote; a press after that is a press of its own", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 2, cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  const up = thumb(ui.root, "one", "up");
  up.click();
  ui.acts[0].answer({ ok: true });
  await settled();
  // The host has answered, and 150ms after the first press comes the second click of a double click.
  ui.clock.t += 150;
  up.click();
  assert.deepEqual(ui.sent().map((a) => a.payload.value), ["up"], "one up, and no none");
  assert.equal(pressedOf(ui), "true false");
  ui.clock.t += 100;
  up.click();
  assert.equal(ui.sent().length, 1, "still inside the window");
  // The other thumb is another matter: a quick switch is allowed.
  thumb(ui.root, "one", "down").click();
  assert.deepEqual(ui.sent().map((a) => a.payload.value), ["up", "down"]);
  ui.acts[1].answer({ ok: true });
  await settled();
  ui.clock.t += 401;
  thumb(ui.root, "one", "down").click();
  assert.deepEqual(ui.sent().map((a) => a.payload.value), ["up", "down", "none"], "a deliberate second press takes it back");
});

test("leaving the editor with changed words is asked about once; with a save out, nothing leaves", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const open = () => {
    noteWith(ui.root, "two").fire("keydown", { key: "e" });
    return editorOf(ui.root);
  };
  const note = noteWith(ui.root, "two");
  const said = () => one(note, "edit-said").textContent;
  // Nothing changed: Escape just closes.
  open().fire("keydown", { key: "Escape" });
  absent(editorOf(ui.root));

  let area = open();
  area.type("two, with a thought worth keeping");
  area.fire("keydown", { key: "Escape" });
  same(editorOf(ui.root), area, "the first Escape does not drop the words");
  assert.equal(said(), "Discard changes?");
  const keep = button(note, "Keep editing");
  const discard = button(note, "Discard");
  assert.ok(keep && discard);
  same(ui.document.activeElement, keep, "staying is the way out that has focus");
  keep.click();
  assert.equal(area.value, "two, with a thought worth keeping");
  same(ui.document.activeElement, area);
  assert.ok(button(note, "Save") && button(note, "Cancel"), "and the buttons are Save and Cancel again");
  // Cancel asks the same question; Discard answers it.
  button(note, "Cancel").click();
  assert.equal(said(), "Discard changes?");
  button(note, "Discard").click();
  absent(editorOf(ui.root));
  assert.deepEqual(ui.sent(), []);
  // A second Escape answers it too, from the box or from the row.
  area = open();
  area.type("changed again");
  area.fire("keydown", { key: "Escape" });
  one(note, "edit-row").fire("keydown", { key: "Escape" });
  absent(editorOf(ui.root));
  // Typing after being asked is an answer: keep editing.
  area = open();
  area.type("changed");
  area.fire("keydown", { key: "Escape" });
  area.type("changed, and more");
  assert.ok(button(note, "Save"));
  assert.notEqual(said(), "Discard changes?");

  // A save is out: Cancel is off, Escape does nothing, and the answer is still heard.
  area.fire("keydown", ENTER);
  assert.equal(ui.sent().length, 1);
  assert.equal(button(note, "Cancel").disabled, true);
  area.fire("keydown", { key: "Escape" });
  one(note, "edit-row").fire("keydown", { key: "Escape" });
  button(note, "Cancel").click();
  same(editorOf(ui.root), area, "the editor stays until the save is answered");
  ui.acts[0].answer({ ok: false, reason: "forbidden" });
  await settled();
  assert.equal(toastOf(ui.root).textContent, NOT_YOURS, "the refusal is heard, by somebody");
  assert.equal(area.value, "changed, and more");
  assert.equal(button(note, "Cancel").disabled, false);
});

test("an Enter that ends an input method's composition does not save", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  noteWith(ui.root, "two").fire("keydown", { key: "e" });
  const area = editorOf(ui.root);
  area.type("こんにちは");
  area.fire("keydown", { key: "Enter", isComposing: true });
  area.fire("keydown", { key: "Enter", keyCode: 229 });
  area.fire("keydown", { key: "Process", keyCode: 229 });
  assert.deepEqual(ui.sent(), [], "neither the flag nor Safari's 229 saves");
  area.fire("keydown", { key: "Enter", keyCode: 13 });
  assert.deepEqual(ui.sent(), [{ action: "edit-card", payload: { cardId: "c2", text: "こんにちは" } }]);
});

test("a rescued draft goes after what is already in the lane's box, and is cut, and said to be, only if the two do not fit", () => {
  const rescue = (already, draft) => {
    const ui = load({ host: "new" });
    ui.push(session({ cards: three }, PARTICIPANT));
    const box = composer(ui.root, "Went well");
    if (already) box.type(already);
    noteWith(ui.root, "two").fire("keydown", { key: "e" });
    editorOf(ui.root).type(draft);
    ui.push(session({ cards: [three[0], three[2]] }, PARTICIPANT));
    return { value: box.value, toast: toastOf(ui.root).textContent };
  };
  const both = rescue("half a thought", "two, reworded");
  assert.equal(both.value, "half a thought\ntwo, reworded", "appended on a line of its own; nothing written over");
  assert.equal(both.toast, "That note was deleted while you were editing it. Your words are in the box above, ready to add as a new note.");
  // 300 already there, a line break, and 250 more: 551 in all, 51 too many.
  const long = rescue("a".repeat(300), "b".repeat(250));
  assert.equal(long.value.length, 500);
  assert.equal(long.value, "a".repeat(300) + "\n" + "b".repeat(199));
  assert.equal(long.toast, "That note was deleted while you were editing it. Your words are in the box above, ready to add as a new note. They did not all fit with what was already there: the end was cut at 500 characters.");
});

// ---- the options menu, redrawn

// What a menu holds, top to bottom: an item by its words, a strip as the
// names of its buttons, a rule as "--", and its title in brackets.
const menuRows = (root) =>
  one(root, "menu").children.map((n) => {
    if (n.className.includes("menu-title")) return "[" + n.textContent + "]";
    if (n.className === "sep") return "--";
    if (n.className === "strip") return n.getAttribute("aria-label") + ": " + all(n, (b) => b.tagName === "BUTTON").map((b) => b.getAttribute("aria-label")).join(", ");
    if (n.className === "off-why") return "(" + n.textContent + ")";
    return n.textContent;
  });
const STRIP = "Reorder: Move to top, Move up, Move down, Move to bottom";
const openMenuOf = (root, text) => one(noteWith(root, text), "more").click();

test("a note's menu is a title, four rows, a reorder strip, one Move to step, and Delete alone under a rule: no votes", () => {
  const { root, push } = load();
  push(session({ cards: three }));
  openMenuOf(root, "two");
  assert.deepEqual(menuRows(root), ["[two]", "Edit note…E", "Add a sticker…S", "Start an action…", "Select to group", "--", STRIP, "Move to…", "--", "Delete note…"]);
  assert.equal(all(one(root, "menu"), (n) => /vote/i.test(n.textContent + (n.getAttribute("aria-label") || ""))).length, 0, "voting is on the note, not in its menu");
  assert.equal(one(root, "menu-title").getAttribute("aria-hidden"), "true");
  assert.ok(menuItem(root, "Delete note").className.split(" ").includes("danger"), "Delete is drawn in the stop color");
  assert.equal(menuItem(root, "Move to…").getAttribute("aria-haspopup"), "menu");
  for (const item of byClass(root, "menu-item")) {
    const icons = all(item, (n) => n.tagName === "SVG");
    assert.ok(icons.length >= 1 && icons.every((n) => n.getAttribute("aria-hidden") === "true"), "every row has an icon, and no icon is read out: " + item.textContent);
  }
  assert.equal(one(noteWith(root, "two"), "more").getAttribute("title"), "Options");
});

test("the note's menu follows the stage and the note: no Select where the checkbox shows, and its stickers and actions are counted", () => {
  const { root, push } = load();
  const cards = [card("c1", "went-well", "one"), card("c2", "to-improve", "two")];
  const stamps = [st("s1", "idea", 0.5, 0.5), st("s2", "laugh", 0.6, 0.5)];
  push(session({ stage: 1, cards, stamps, actionItems: [{ id: "a1", text: "x", owner: "", sourceIds: ["c1"] }] }));
  openMenuOf(root, "one");
  assert.deepEqual(menuRows(root), ["[one]", "Edit note…E", "Stickers (2)…", "Actions from this note (1)…", "--", STRIP, "Move to…", "--", "Delete note…"]);
  // The list of stickers is also where one more is added.
  menuItem(root, "Stickers (2)").click();
  button(one(root, "sheet"), "Add a sticker").click();
  assert.equal(bookOf(root).getAttribute("aria-label"), "Add a sticker to: one");
});

test("a group's menu and an action's menu are drawn the same way", () => {
  const ui = load({ host: "new" });
  const actionItems = [{ id: "a1", text: "book the room", owner: "" }, { id: "a2", text: "tell the team", owner: "u-bo" }];
  ui.push(session({ cards: paired, groups: pair, actionItems }, PARTICIPANT));
  labeled(ui.root, "Options for group: Pair").click();
  assert.deepEqual(menuRows(ui.root), ["[Pair]", "Start an action…", "--", "Reorder: Move group to top, Move group up, Move group down, Move group to bottom", "Move to…"]);
  menuItem(ui.root, "Move to…").click();
  assert.deepEqual(menuRows(ui.root), ["Move group to", "Went welllane", "Puzzleslane"]);
  ui.press("Escape");

  labeled(ui.root, "Options for action: book the room").click();
  assert.deepEqual(menuRows(ui.root), ["[book the room]", "Set an owner…", "--", "Delete action…"]);
  assert.ok(menuItem(ui.root, "Delete action").className.split(" ").includes("danger"));
  ui.press("Escape");
  labeled(ui.root, "Options for action: tell the team").click();
  assert.deepEqual(menuRows(ui.root), ["[tell the team]", "Change owner…", "--", "Delete action…"]);
});

test("the reorder strip is a named group of four buttons that keep the menu open, and each sends what Alt and an arrow sends", () => {
  const byStrip = load();
  byStrip.push(session({ cards: three }));
  openMenuOf(byStrip.root, "three");
  const strip = one(byStrip.root, "strip");
  assert.equal(strip.getAttribute("role"), "group");
  assert.equal(strip.getAttribute("aria-label"), "Reorder");
  assert.match(strip.textContent, /^ReorderAlt\+arrows$/);
  const up = menuItem(byStrip.root, "Move up");
  assert.equal(up.getAttribute("title"), "Move up (Alt+Up)");
  up.focus();
  up.click();
  assert.equal(liveOf(byStrip.root), "Moved up. Position 2 of 3 in Went well.");
  same(one(byStrip.root, "menu"), strip.parentNode, "the menu is still open");
  same(byStrip.document.activeElement, up, "and focus is still on the button, for the next press");
  up.click();
  assert.equal(liveOf(byStrip.root), "Moved up. Position 1 of 3 in Went well.");
  menuItem(byStrip.root, "Move to bottom").click();
  menuItem(byStrip.root, "Move to top").click();
  menuItem(byStrip.root, "Move down").click();

  const byKeys = load();
  byKeys.push(session({ cards: three }));
  const note = noteWith(byKeys.root, "three");
  for (const [key, shiftKey] of [["ArrowUp", false], ["ArrowUp", false], ["ArrowDown", true], ["ArrowUp", true], ["ArrowDown", false]]) note.fire("keydown", { key, altKey: true, shiftKey });
  assert.deepEqual(byStrip.sent(), [
    { action: "move-card", payload: { cardId: "c3", beforeId: "c2" } },
    { action: "move-card", payload: { cardId: "c3", beforeId: "c1" } },
    { action: "move-card", payload: { cardId: "c3" } },
    { action: "move-card", payload: { cardId: "c3", beforeId: "c1" } },
    { action: "move-card", payload: { cardId: "c3", beforeId: "c2" } },
  ]);
  assert.deepEqual(byKeys.sent(), byStrip.sent(), "the strip and the keys ask for the same thing");
});

test("on a lane sorted by rating the strip is off, says why under itself, and a press sends nothing", () => {
  const { root, push, sent } = load();
  push(session({ cards: voted }));
  button(lane(root, "Went well"), "Top rated").click();
  openMenuOf(root, "one");
  assert.deepEqual(menuRows(root).slice(6, 9), [STRIP, "(Sorted by rating. Show shared order to move notes here.)", "Move to…"]);
  const why = one(root, "off-why");
  for (const name of ["Move to top", "Move up", "Move down", "Move to bottom"]) {
    assert.equal(menuItem(root, name).getAttribute("aria-disabled"), "true", name);
    assert.equal(menuItem(root, name).getAttribute("aria-describedby"), why.getAttribute("id"), name + " is described by the reason");
  }
  menuItem(root, "Move down").click();
  assert.deepEqual(sent(), []);
  assert.equal(toastOf(root).textContent, "Sorted by rating. Show shared order to move notes here.");
  assert.equal(byClass(root, "menu").length, 1);
});

test("Move to is one step in: out of the group, the other lanes, the other groups, under a Back row", () => {
  const ui = load({ host: "new" });
  const groups = [...pair, { id: "g2", columnId: "went-well", title: "Wins" }];
  ui.push(session({ cards: [...paired, card("c6", "went-well", "six", { groupId: "g2" })], groups }, PARTICIPANT));
  const more = one(noteWith(ui.root, "four"), "more");
  more.click();
  const menu = one(ui.root, "menu");
  menuItem(ui.root, "Move to…").focus();
  menu.fire("keydown", { key: "ArrowRight" });
  assert.deepEqual(menuRows(ui.root), ["Move to", "Out of “Pair”", "--", "Went welllane", "Puzzleslane", "--", "Winsgroup in Went well"]);
  assert.equal(menuItem(ui.root, "Back").textContent, "Move to");
  same(ui.document.activeElement, menuItem(ui.root, "Out of"), "focus is on the first place, not on Back");

  // Escape, or Left, goes back one level, to the row that was stepped into.
  let stopped = 0;
  menu.fire("keydown", { key: "Escape", stopPropagation: () => stopped++ });
  assert.equal(stopped, 1, "this Escape is not also heard as closing the menu");
  assert.equal(menuRows(ui.root)[0], "[four]");
  same(ui.document.activeElement, menuItem(ui.root, "Move to…"));
  menuItem(ui.root, "Move to…").click();
  menu.fire("keydown", { key: "ArrowLeft" });
  same(ui.document.activeElement, menuItem(ui.root, "Move to…"));
  menuItem(ui.root, "Move to…").click();
  menuItem(ui.root, "Back").click();
  assert.equal(menuRows(ui.root)[0], "[four]");

  // The second Escape closes the menu and hands focus back.
  ui.press("Escape");
  assert.equal(byClass(ui.root, "menu").length, 0);
  same(ui.document.activeElement, more);

  more.click();
  menuItem(ui.root, "Move to…").click();
  menuItem(ui.root, "Wins").click();
  assert.deepEqual(ui.sent(), [{ action: "move-card", payload: { cardId: "c4", groupId: "g2" } }]);
  assert.equal(byClass(ui.root, "menu").length, 0, "a place chosen closes the menu");
  same(ui.document.activeElement, more);
});

test("in a menu Left and Right walk the strip, Up and Down take a strip as one row, and Tab closes it", () => {
  const { root, document, push } = load();
  push(session({ cards: three }));
  const more = one(noteWith(root, "two"), "more");
  more.click();
  const menu = one(root, "menu");
  menuItem(root, "Select to group").focus();
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Move to top"), "down into the strip: its first button");
  menu.fire("keydown", { key: "ArrowRight" });
  same(document.activeElement, menuItem(root, "Move up"));
  menu.fire("keydown", { key: "ArrowLeft" });
  menu.fire("keydown", { key: "ArrowLeft" });
  same(document.activeElement, menuItem(root, "Move to bottom"), "and round");
  menu.fire("keydown", { key: "ArrowDown" });
  same(document.activeElement, menuItem(root, "Move to…"), "down leaves the strip");
  menu.fire("keydown", { key: "ArrowUp" });
  same(document.activeElement, menuItem(root, "Move to top"));
  menu.fire("keydown", { key: " " });
  same(document.activeElement, menuItem(root, "Move to top"), "Space is a press, not a letter to look for");
  menu.fire("keydown", { key: "Tab" });
  assert.equal(byClass(root, "menu").length, 0);
  same(document.activeElement, more);
});

test("a row that cannot be used says why under itself, without saying whose the note is", () => {
  const ui = load({ host: "new" });
  ui.push(session({ revealed: true, cards: [card("c1", "went-well", "one", { authorId: "u-cy" })] }, PARTICIPANT));
  openMenuOf(ui.root, "one");
  assert.deepEqual(menuRows(ui.root).slice(1, 3), ["Edit note…E", "(Only the person who wrote a note can edit it.)"]);
  assert.deepEqual(menuRows(ui.root).slice(-2), ["Delete note…", "(Only the person who wrote a note, or the facilitator, can delete it.)"]);
  const edit = menuItem(ui.root, "Edit note");
  assert.equal(edit.getAttribute("aria-disabled"), "true");
  assert.equal(edit.getAttribute("aria-describedby"), byClass(ui.root, "off-why")[0].getAttribute("id"));
  edit.click();
  assert.equal(toastOf(ui.root).textContent, "Only the person who wrote a note can edit it.");
  assert.equal(byClass(ui.root, "note-edit").length, 0);
  assert.deepEqual(ui.sent(), []);
});

test("an open menu keeps up with the board: its rows change, focus stays on its row, and it closes when its note goes", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  openMenuOf(ui.root, "two");
  const menu = one(ui.root, "menu");
  menuItem(ui.root, "Delete note").focus();
  // A teammate's change that is not about this note redraws nothing.
  const before = menuItem(ui.root, "Delete note");
  ui.push(session({ cards: [...three, card("c9", "puzzles", "nine")] }, PARTICIPANT));
  same(menuItem(ui.root, "Delete note"), before, "the same rows: nothing was drawn again");
  // A sticker lands on the note, a group appears, and the stage changes.
  ui.push(session({ stage: 1, cards: [three[0], three[1], card("c3", "went-well", "three", { groupId: "g1" })], groups: [{ id: "g1", columnId: "went-well", title: "Solo" }], stamps: [st("s1", "idea", 0.5, 0.5, "c2")] }, PARTICIPANT));
  same(one(ui.root, "menu"), menu, "the menu is still open");
  assert.deepEqual(menuRows(ui.root), ["[two]", "Edit note…E", "Stickers (1)…", "Start an action…", "--", STRIP, "Move to…", "--", "Delete note…"]);
  same(ui.document.activeElement, menuItem(ui.root, "Delete note"), "focus is on the row it was on");
  // One step in, the places keep up too.
  menuItem(ui.root, "Move to…").click();
  assert.deepEqual(menuRows(ui.root), ["Move to", "To improvelane", "Puzzleslane", "--", "Sologroup"]);
  ui.push(session({ stage: 1, cards: three }, PARTICIPANT));
  assert.deepEqual(menuRows(ui.root), ["Move to", "To improvelane", "Puzzleslane"]);

  ui.push(session({ stage: 1, cards: [three[0], three[2]] }, PARTICIPANT));
  assert.equal(byClass(ui.root, "menu").length, 0);
  assert.equal(toastOf(ui.root).textContent, "That was removed from the board while you had it open.");
  same(ui.document.activeElement, pick(ui.root, "three"), "focus goes to the note now in its place");
});

test("on a phone the menu is a sheet over a scrim, with Done in sight, and Tab stays inside it", () => {
  const ui = load({ host: "new", phone: true });
  ui.push(session({ cards: three }, PARTICIPANT));
  const more = one(noteWith(ui.root, "two"), "more");
  more.click();
  const menu = one(ui.root, "menu");
  assert.equal(menuRows(ui.root).at(-1), "Done");
  assert.equal(byClass(ui.root, "scrim").length, 1);
  const done = menuItem(ui.root, "Done");
  menuItem(ui.root, "Delete note").focus();
  menu.fire("keydown", { key: "Tab" });
  same(ui.document.activeElement, done, "Tab goes on to Done");
  assert.equal(byClass(ui.root, "menu").length, 1, "and does not close the sheet");
  menu.fire("keydown", { key: "Tab" });
  same(ui.document.activeElement, menuItem(ui.root, "Edit note"), "and round to the first row");
  menu.fire("keydown", { key: "Tab", shiftKey: true });
  same(ui.document.activeElement, done, "Shift+Tab goes back round");
  // Done is there one step in as well.
  menuItem(ui.root, "Move to…").click();
  assert.deepEqual(menuRows(ui.root), ["Move to", "To improvelane", "Puzzleslane", "Done"]);
  menuItem(ui.root, "Done").click();
  assert.equal(byClass(ui.root, "menu").length, 0);
  assert.equal(byClass(ui.root, "scrim").length, 0);
  same(ui.document.activeElement, more);
  assert.deepEqual(ui.sent(), []);

  const desk = load();
  desk.push(session({ cards: three }));
  openMenuOf(desk.root, "two");
  absent(menuItem(desk.root, "Done"), "a menu on a desk has no Done");
});

test("a menu hangs from the right edge of its button, goes above it when there is no room below, and never leaves the frame", () => {
  const { root, push, fireWindow, window } = load();
  push(session({ cards: three }));
  const more = one(noteWith(root, "two"), "more");
  more.click();
  const menu = one(root, "menu");
  menu.offsetWidth = 240;
  menu.offsetHeight = 300;
  const at = (box) => {
    more.box = box;
    fireWindow("resize");
    return [menu.style.left, menu.style.top, menu.style.transformOrigin];
  };
  // The frame is 1280 by 800. Room below: 6 under the button, its right edge on the button's.
  assert.deepEqual(at({ left: 500, top: 100, width: 32, height: 32 }), ["292px", "138px", "100% 0"]);
  // The last note of a tall lane: 700 + 32 + 6 + 300 is past 792, so above: 700 - 6 - 300.
  assert.deepEqual(at({ left: 500, top: 700, width: 32, height: 32 }), ["292px", "394px", "100% 100%"]);
  // A lane at the left edge: held 8 in.
  assert.deepEqual(at({ left: 40, top: 100, width: 32, height: 32 }), ["8px", "138px", "100% 0"]);
  // A frame too short for it either way: as low as it can be and still whole.
  window.innerHeight = 400;
  assert.deepEqual(at({ left: 500, top: 200, width: 32, height: 32 }), ["292px", "92px", "100% 0"]);
  // And one shorter than the menu: at the top, where its own scrolling takes over.
  window.innerHeight = 250;
  assert.deepEqual(at({ left: 500, top: 100, width: 32, height: 32 }), ["292px", "8px", "100% 0"]);
});

// ---- the final audit's findings

test("a stage changed with a key leaves focus on the button that was pressed, and a second press while it is out sends nothing", () => {
  const ui = load({ host: "new" });
  const cards = [card("c1", "went-well", "one")];
  ui.push(session({ stage: 1, cards }, FACILITATOR));
  const next = button(ui.root, "Move to Vote");
  next.focus();
  next.click();
  same(ui.document.activeElement, next, "focus is not dropped while the change is on its way");
  assert.equal(next.getAttribute("aria-disabled"), "true");
  next.click();
  assert.deepEqual(ui.sent(), [{ action: "set-stage", payload: { stage: 2 } }]);
  ui.push(session({ stage: 2, cards }, FACILITATOR));
  same(ui.document.activeElement, next, "nor when it lands");
  assert.equal(next.textContent, "Move to Decide");
  assert.equal(next.getAttribute("aria-disabled"), null);
  assert.match(liveOf(ui.root), /Vote/, "and the new stage is said");

  const back = button(ui.root, "Back");
  back.focus();
  back.click();
  same(ui.document.activeElement, back);
  ui.push(session({ stage: 1, cards }, FACILITATOR));
  same(ui.document.activeElement, back);
  assert.equal(back.getAttribute("aria-label"), "Back to Write");
});

test("after a drop, focus is on the handle of the note that was carried", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const grip = one(noteWith(ui.root, "three"), "grip");
  // Carried with the mouse, focus is nowhere by the time it is let go.
  same(ui.document.activeElement, ui.document.body);
  carry(ui, "three", 110);
  ui.fireWindow("pointerup", { clientX: 10, clientY: 110 });
  assert.equal(noteOrder(ui.root, "Went well"), "three one two");
  same(ui.document.activeElement, grip);
});

test("a note whose editor is open is not moved by Alt and an arrow, from any control inside it", () => {
  const ui = load({ host: "new" });
  ui.push(session({ cards: three }, PARTICIPANT));
  const note = noteWith(ui.root, "two");
  note.fire("keydown", { key: "e", target: one(note, "note-text") });
  for (const target of [button(note, "Save"), button(note, "Cancel"), one(note, "note-edit"), one(note, "grip")]) {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) note.fire("keydown", { key, altKey: true, target });
  }
  assert.deepEqual(ui.sent(), []);
  assert.equal(noteOrder(ui.root, "Went well"), "one two three");
  // The question about dropping changes has a line of its own.
  one(note, "note-edit").type("two, changed");
  button(note, "Cancel").click();
  assert.ok(one(note, "edit-row").className.split(" ").includes("asking"));
  button(note, "Keep editing").click();
  assert.ok(!one(note, "edit-row").className.split(" ").includes("asking"));
});

test("a sticker's default spot is clear of the handle, the checkbox and the menu button, and of where the checkbox will be", () => {
  const laid = (stage, narrow) => {
    const ui = load();
    ui.push(session({ stage, cards: [card("c1", "went-well", "one")] }));
    const note = noteWith(ui.root, "one");
    note.box = { left: 0, top: 0, width: 240, height: 44 };
    one(note, "more").box = { left: 200, top: 5, width: 32, height: 32 };
    if (narrow) ui.resize(lane(ui.root, "Went well"), 300);
    return ui;
  };
  const pickOn = (ui, name) => {
    openBook(ui.root, "one");
    labeled(bookOf(ui.root), name).click();
    return [ui.sent().at(-1).payload.x, ui.sent().at(-1).payload.y];
  };
  const leadOf = (ui) => one(noteWith(ui.root, "one"), "lead");
  const gripOf = (ui) => one(noteWith(ui.root, "one"), "grip");

  // Write stage, a wide lane: the handle is 4 to 32 across, and the checkbox
  // will stand beside it, to 60. A sticker is 21 to its rim and keeps 6
  // clear, so its center is 87 or more across: of 14, 44, 74, 104 it is 104,
  // which is 96 of the 224 a center travels.
  const write = laid(0, false);
  leadOf(write).box = gripOf(write).box = { left: 4, top: 5, width: 28, height: 32 };
  assert.deepEqual(pickOn(write, "Blocker, vinyl"), [0.429, 1]);
  // The next is 134. 164 is the last: 194 would be within 6 of the menu button at 200.
  assert.deepEqual(pickOn(write, "Idea, vinyl".replace("Idea", "Great idea")), [0.563, 1]);
  assert.deepEqual(pickOn(write, "Me too, vinyl"), [0.696, 1]);

  // Group stage: the checkbox is showing and the two are measured together.
  const group = laid(1, false);
  leadOf(group).box = { left: 4, top: 5, width: 56, height: 32 };
  gripOf(group).box = { left: 4, top: 5, width: 28, height: 32 };
  assert.deepEqual(pickOn(group, "Blocker, vinyl"), [0.429, 1]);

  // A narrow lane stacks them: the handle is 24 high and the checkbox will
  // be under it, down to 53. On the bottom edge of a 44px note a sticker
  // reaches up to 21, so it has to be past 32 + 27 = 59 across: 74.
  const narrow = laid(0, true);
  leadOf(narrow).box = gripOf(narrow).box = { left: 4, top: 5, width: 28, height: 24 };
  assert.deepEqual(pickOn(narrow, "Blocker, vinyl"), [0.295, 1]);
});

test("the sticker book hands focus back to where it was opened from: the note's words for S, the menu button for the menu", () => {
  const { root, document, push, press } = load();
  push(session({ cards: [card("c1", "went-well", "one")] }));
  const note = noteWith(root, "one");
  const words = one(note, "note-text");
  words.focus();
  note.fire("keydown", { key: "s", target: words });
  assert.equal(byClass(root, "book-pop").length, 1);
  press("Escape");
  assert.equal(byClass(root, "book-pop").length, 0);
  same(document.activeElement, words, "S was pressed on the words");

  one(note, "more").click();
  menuItem(root, "Add a sticker").click();
  press("Escape");
  same(document.activeElement, one(note, "more"), "opened from the menu, it goes back to the menu's button");
});

// ---- fix round: stickers apart, the split label, the failure panel's focus, a take-back, the menu's side

test("with every usual place taken, the next sticker goes where it is farthest from the others, never onto one and never onto a control", () => {
  const ui = load();
  const cards = [card("c1", "went-well", "one")];
  // The buttons take 116 to 200 of the bottom edge, so the usual places are 14, 44, 74 and 29, 59, 89: all six taken.
  const taken = [0.027, 0.161, 0.295, 0.094, 0.228, 0.362].map((x, i) => st("t" + i, "laugh", x, 1));
  ui.push(session({ cards, stamps: taken }));
  const note = noteWith(ui.root, "one");
  note.box = { left: 0, top: 0, width: 240, height: 44 };
  one(note, "rx").box = { left: 116, top: 32, width: 84, height: 24 };
  const centers = taken.map((t) => [8 + t.x * 224, 48]);
  for (const name of ["Blocker, vinyl", "Great idea, vinyl", "Thank you, vinyl"]) {
    openBook(ui.root, "one");
    labeled(bookOf(ui.root), name).click();
    const { x, y } = ui.sent().at(-1).payload;
    const c = [8 + x * 224, y * 52 - 4];
    const least = Math.min(...centers.map((o) => Math.hypot(o[0] - c[0], o[1] - c[1])));
    assert.ok(least >= 12, name + " is " + least.toFixed(1) + "px from the nearest sticker");
    // 21 to its rim and 6 clear: not within 89 to 227 across while it is within 5 to 83 down.
    assert.ok(!(c[0] > 89 && c[0] < 227 && c[1] > 5), name + " is off the buttons: " + c);
    centers.push(c);
  }
});

test("the split beside the tag shows for the pointer and for keyboard focus, not for focus a mouse press left behind", () => {
  assert.match(src, /\.note:hover \.brk,\.note:has\(:focus-visible\) \.brk\{opacity:1\}/);
  assert.doesNotMatch(src, /focus-within \.brk/);
});

test("a vote failing while somebody types elsewhere does not take their focus; from the thumbs it goes to Try again", async () => {
  const ui = load({ host: "new" });
  ui.push(session({ stage: 0, cards: [card("c1", "went-well", "one")] }, PARTICIPANT));
  const fail = async () => {
    for (const i of [0, 1]) {
      ui.acts.at(-1).answer({ ok: false, reason: "busy" });
      await settled();
      if (i === 0) ui.runTimers(600);
    }
  };
  thumb(ui.root, "one", "up").click();
  const box = composer(ui.root, "Puzzles");
  box.focus();
  await fail();
  assert.equal(one(ui.root, "oops").textContent, "Your vote did not go through.Try again");
  same(ui.document.activeElement, box, "focus stays in the box being typed in");
  assert.equal(liveOf(ui.root), "Your vote on this note did not go through. Try again is available.");

  later(ui);
  const up = thumb(ui.root, "one", "up");
  up.focus();
  up.click();
  await fail();
  same(ui.document.activeElement, button(one(ui.root, "oops"), "Try again"), "from the note's own buttons, focus goes to the way to try again");
});

test("a press on a thumb that shows as the viewer's takes the vote back, even before the host has answered for it", async () => {
  const ui = load({ host: "new" });
  const cards = (up) => [card("c1", "went-well", "one", { up })];
  ui.push(session({ stage: 2, cards: cards(0) }, PARTICIPANT));
  const up = thumb(ui.root, "one", "up");
  up.click();
  // The state shows the vote; the host's answer is still out.
  ui.push(session({ stage: 2, cards: cards(1) }, PARTICIPANT));
  assert.equal(pressedOf(ui), "true false");
  assert.match(up.getAttribute("aria-label"), /Your vote\. Press to take it back\.$/);
  later(ui);
  up.click();
  assert.deepEqual(ui.sent().map((a) => a.payload.value), ["up", "none"], "it does what it says: takes it back");
});

test("a menu stays on the side of its button it opened on when its rows change: stepping into Move to and back", () => {
  const { root, push, fireWindow } = load();
  push(session({ cards: three }));
  const more = one(noteWith(root, "two"), "more");
  // Low in an 800px frame: 300 tall does not fit below 700 + 32, so it opens above, its foot 6 over the button.
  more.box = { left: 500, top: 700, width: 32, height: 32 };
  more.click();
  const menu = one(root, "menu");
  menu.offsetWidth = 240;
  menu.offsetHeight = 300;
  fireWindow("resize");
  assert.equal(menu.style.top, "394px");
  // The step is shorter, and would fit below. It stays above, still 6 over the button: 700 - 6 - 120.
  menu.offsetHeight = 120;
  menuItem(root, "Move to…").click();
  assert.deepEqual([menu.style.top, menu.style.transformOrigin], ["574px", "100% 100%"]);
  menu.offsetHeight = 300;
  menuItem(root, "Back").click();
  assert.equal(menu.style.top, "394px");
  // Opened below, a taller panel stays below, held inside the frame.
  more.box = { left: 500, top: 440, width: 32, height: 32 };
  fireWindow("resize");
  assert.equal(menu.style.top, "478px");
  menu.offsetHeight = 330;
  menuItem(root, "Move to…").click();
  assert.deepEqual([menu.style.top, menu.style.transformOrigin], ["462px", "100% 0"]);
});

// ---- the sticker list, and the viewer's own note arriving

test("the list of a note's stickers is one line each: a face, a name, and icon buttons that keep their whole names", () => {
  const { root, push } = load({ host: "new" });
  push(session({ cards: [card("c1", "went-well", "one")], stamps: [st("s1", "p-idea", 0.5, 0.5), st("s2", "laugh", 0.5, 0.5)] }, FACILITATOR));
  one(noteWith(root, "one"), "more").click();
  menuItem(root, "Stickers (2)").click();
  const sheet = one(root, "st-sheet");
  assert.equal(sheet.getAttribute("role"), "dialog");
  const rows = byClass(sheet, "st-list")[0].children;
  assert.deepEqual(rows.map((li) => li.children.map((n) => n.className.split(" ")[0]).join(" ")), ["st w st-do st-do st-do", "st w st-do st-do st-do"]);
  assert.deepEqual(rows[1].children.slice(2).map((b) => [b.getAttribute("title"), b.getAttribute("aria-label"), b.textContent]), [
    ["Move", "Move Made me laugh, vinyl sticker, 2 of 2", ""],
    ["To front", "Bring to front Made me laugh, vinyl sticker, 2 of 2", ""],
    ["Remove", "Remove Made me laugh, vinyl sticker, 2 of 2", ""],
  ]);
  assert.ok(rows[1].children[4].className.split(" ").includes("danger"), "Remove is in the stop color");
  assert.equal(one(sheet, "off-why").textContent, "You can move or remove any sticker. Bottom of the pile first.");
  assert.equal(button(sheet, "Add a sticker").className, "menu-item");
});

test("the viewer's own note drops in once, as its ghost, and the real note takes its place: never two, never from nothing again", () => {
  const add = (ui, text) => {
    const box = composer(ui.root, "Went well");
    box.type(text);
    box.fire("keydown", ENTER);
  };
  const shown = (ui, text) => all(ui.root, (n) => n.className.split(" ").includes("note") && n.textContent.includes(text) && n.isConnected).length;
  // A quick host: the state comes 300ms into the drop.
  const quick = load({ host: "new", motion: true });
  quick.push(session({ cards: [] }, PARTICIPANT));
  add(quick, "mine");
  const ghost = one(quick.root, "ghost");
  assert.ok(ghost.className.split(" ").includes("arriving"), "the drop starts the moment Enter is pressed");
  quick.clock.t += 300;
  quick.push(session({ cards: [card("c1", "went-well", "mine"), card("c2", "went-well", "theirs")] }, PARTICIPANT));
  assert.equal(shown(quick, "mine"), 1, "the ghost leaves in the same patch the note arrives");
  const mine = noteWith(quick.root, "mine");
  assert.ok(mine.className.split(" ").includes("arriving"));
  assert.equal(mine.style.animationDelay, "-300ms", "it carries on the same drop from 300ms in, not from the start");
  assert.ok(noteWith(quick.root, "theirs").className.split(" ").includes("arriving"), "a teammate's note keeps its own entrance");
  assert.equal(noteWith(quick.root, "theirs").style.animationDelay || "", "");

  // A slow host: the drop is over and the ghost waits, saying so; the note then glides from where the ghost stood.
  const slow = load({ host: "new", motion: true });
  slow.push(session({ cards: [card("c0", "went-well", "first")] }, PARTICIPANT));
  add(slow, "mine");
  const g = one(slow.root, "ghost");
  assert.match(g.textContent, /Saving/);
  g.box = { left: 0, top: 160, width: 240, height: 44 };
  slow.clock.t += 1500;
  slow.document.animations.length = 0;
  slow.push(session({ cards: [card("c1", "went-well", "mine"), card("c0", "went-well", "first")] }, PARTICIPANT));
  assert.equal(shown(slow, "mine"), 1);
  const real = noteWith(slow.root, "mine");
  assert.ok(!real.className.split(" ").includes("arriving"), "no second entrance");
  const moves = slow.document.animations.filter((a) => a.target === real);
  assert.equal(moves.length, 1, "it glides from the ghost's place to its own");
  assert.equal(moves[0].frames[0].transform, "translate(0px,160px)");
  assert.ok(moves.every((a) => a.frames.every((f) => f.opacity === undefined || f.opacity === 1)), "and is never faded");

  // Less motion: one note, still, and no blink.
  const still = load({ host: "new" });
  still.push(session({ cards: [] }, PARTICIPANT));
  add(still, "mine");
  still.push(session({ cards: [card("c1", "went-well", "mine")] }, PARTICIPANT));
  assert.equal(shown(still, "mine"), 1);
  assert.equal(still.document.animations.length, 0);
  assert.equal(byClass(still.root, "arriving").length, 0);
});
