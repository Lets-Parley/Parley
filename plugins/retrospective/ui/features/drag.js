import { bag } from "../utils/bag.js";
import { contains, setText } from "../utils/dom.js";
import { short } from "../utils/text.js";
import { cardById, columnTitle, groupById, ui, view } from "../bridge/state.js";
import { clockNow, GLIDE, motionOn, rectOf } from "../utils/motion.js";
import { live } from "../components/notices.js";
import { closePop } from "../components/popover.js";
import { reflow, SORTED_OFF } from "../components/lane.js";
import { keepScrolling, putDown, sightTop } from "./drag-scroll.js";
import { lanesNarrow } from "./sticker-layout.js";
import { main } from "../main.js";

// ------------------------------------------------------------------- drag

// Dragging is the pointer's way to do what the menu and the Alt+Arrow keys
// do, and a drop sends the request the menu would. The thing itself stays in
// the list as an empty slot that shows where it would land; a copy follows
// the pointer. State pushes wait until it is put down, so a teammate's
// change cannot shuffle the lane under the hand. The drag is `ui.drag`, and
// the state held back meanwhile `ui.heldState` (bridge/state.js).
// How long the pointer rests on the middle of a note before a drop there
// means "group with this". Shorter, and a quick reorder flickers into it.
const DWELL_MS = 300;
// How near the top or bottom of the frame a drag starts to scroll it.
export const EDGE = 56;
export const GONE = "That is no longer on the board.";

export function ownerOfNode(node) {
  for (const id in view.notes) if (view.notes[id].el === node) return id;
  for (const id in view.groups) if (view.groups[id].el === node || view.groups[id].list === node) return id;
  return null;
}

// Hear a pointer from a press until it is let go, wherever it goes. The
// listeners are on the window because the thing pressed may itself be moved
// in the document while it is dragged, which would drop them.
// One gesture at a time. It ends once, whatever ends it: a release, a
// cancel, Escape, the window losing focus or the capture being taken away.
// Each of those takes the listeners off, so nothing that moves afterwards
// can pick the drag up again. `active` is set once something is being carried.
// The gesture is `ui.gesture`.

export function follow(pointerId, heard, stop) {
  // Another pointer never ends, cancels or replaces a gesture: a second
  // finger set down anywhere, a sticker included, is simply not followed.
  // Only a press of the same pointer means its own release was never heard.
  if (ui.gesture && ui.gesture.pointerId !== undefined && pointerId !== undefined && ui.gesture.pointerId !== pointerId) return null;
  const g = { active: false, pointerId: pointerId };
  // A second finger on the screen is not this drag.
  const other = function (e) {
    return e.pointerId !== undefined && pointerId !== undefined && e.pointerId !== pointerId;
  };
  const move = function (e) {
    if (!other(e)) heard(e);
  };
  const cancel = function () {
    g.end({ type: "pointercancel" });
  };
  const lost = function (e) {
    // The event bubbles: only main losing the capture ends the drag.
    if (e.target === main) cancel();
  };
  g.end = function (e) {
    if (ui.gesture !== g || other(e)) return;
    ui.gesture = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", g.end);
    window.removeEventListener("pointercancel", g.end);
    window.removeEventListener("blur", cancel);
    main.removeEventListener("lostpointercapture", lost);
    // However the gesture ended, the board gives the pointer back: a
    // capture left on it would send every later press to the board itself
    // instead of to the button under the pointer.
    if (main.hasPointerCapture && main.hasPointerCapture(pointerId)) main.releasePointerCapture(pointerId);
    stop(e);
  };
  if (ui.gesture) ui.gesture.end({ type: "pointercancel" });
  ui.gesture = g;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", g.end);
  window.addEventListener("pointercancel", g.end);
  window.addEventListener("blur", cancel);
  main.addEventListener("lostpointercapture", lost);
  return g;
}

// Keep hearing the pointer if it leaves the frame mid-drag.
export function hold(ev) {
  if (main.setPointerCapture) main.setPointerCapture(ev.pointerId);
}

// A drag ends with a release, and a release on a button is a click. That
// one click is not a press of the button. The mark is taken off on the next
// turn, and by the next press anywhere, whichever comes first.
let swallowed = [];

export function swallowClick(owner) {
  owner.dragged = true;
  swallowed.push(owner);
  setTimeout(unswallow, 0);
}

export function unswallow() {
  swallowed.forEach(function (owner) {
    owner.dragged = false;
  });
  swallowed = [];
}

// A note is dragged by its handle, with anything; a group by the handle in
// its heading. With a mouse the rest of the note or the heading drags too,
// but never from a control: a finger there is scrolling, and a press on a
// button is a press.
export function drags(handle, kind, id) {
  handle.addEventListener("pointerdown", function (ev) {
    const owner = (kind === "group" ? view.groups : view.notes)[id];
    if (ev.button || ui.drag || !owner) return;
    // A note whose words are being typed is not carried about.
    if (kind === "note" && ui.editing && ui.editing.id === id) return;
    if (handle !== owner.grip) {
      if (ev.pointerType !== "mouse") return;
      for (let n = ev.target; n && n !== handle; n = n.parentNode) {
        if (/^(BUTTON|INPUT|LABEL|TEXTAREA)$/.test(n.tagName)) return;
      }
    }
    const start = { x: ev.clientX, y: ev.clientY };
    const g = follow(
      ev.pointerId,
      function (e) {
        if (!ui.drag) {
          if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
          lift(kind, id, start);
          g.active = true;
          hold(ev);
        }
        e.preventDefault();
        ui.drag.py = e.clientY;
        ui.drag.seen = sightTop();
        dragTo(e.clientX, e.clientY);
        keepScrolling(ui.drag, true);
      },
      function (e) {
        if (!ui.drag) return;
        // The press that ends a drag is not a click on the handle.
        swallowClick(owner);
        // The release says where the pointer really is: the page may have
        // been scrolling under it since it last moved.
        if (e.type === "pointerup" && typeof e.clientY === "number") dragTo(e.clientX, e.clientY);
        putDown(e.type === "pointerup");
      },
    );
  });
}

function lift(kind, id, start) {
  const node = (kind === "group" ? view.groups : view.notes)[id].el;
  const from = (kind === "group" ? groupById(id) : cardById(id)).columnId;
  closePop(false);
  const box = rectOf(node);
  const copy = node.cloneNode(true);
  copy.className = kind + " drag";
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  copy.style.width = box.width + "px";
  // Outside its lane the copy would not hear the lane's width: it is told.
  if (node.classList.contains("note") && lanesNarrow[from]) copy.classList.add("narrow");
  main.appendChild(copy);
  node.classList.add("slot");
  document.documentElement.classList.add("dragging");
  ui.drag = {
    kind: kind,
    id: id,
    node: node,
    copy: copy,
    from: from,
    lane: view.lanes[from],
    dx: start.x - box.left,
    dy: start.y - box.top,
    x: start.x,
    y: start.y,
    lastX: start.x,
    tilt: 0,
    home: node.parentNode,
    next: node.nextElementSibling,
    aim: { type: "stay", lane: view.lanes[from] },
    marks: bag(),
    said: "",
    dwell: null,
    ripe: false,
    timer: 0,
    scroll: 0,
    scrolled: 0,
    stillSince: clockNow(),
    rects: new Map(),
    settled: 0,
  };
}

// Where a lane, a group or a note is, for as long as that can be trusted.
// A drag asks on every move of the pointer, and at the caps there are more
// than a hundred and sixty boxes to ask about, so each is measured once and
// kept until something moves them: the slot changing place, the window
// changing size or scrolling. While notes are still gliding to their new
// places a box is measured afresh, since it is on its way somewhere.
function boxOf(node) {
  const d = ui.drag;
  if (clockNow() < d.settled) return rectOf(node);
  let box = d.rects.get(node);
  if (!box) {
    box = rectOf(node);
    d.rects.set(node, box);
  }
  return box;
}

export function forgetBoxes() {
  if (!ui.drag) return;
  ui.drag.rects.clear();
  ui.drag.settled = motionOn() ? clockNow() + GLIDE.duration : 0;
}

// Which part of a note the pointer is over. Its middle half means "group
// with this", once the pointer has rested there; the quarter above and the
// quarter below mean "set down before or after it". Once the middle is held
// it is kept until the pointer is nearly off the note, so a hand resting on
// the line between two parts does not flicker between two answers.
function zoneOf(y, top, height, held) {
  const at = height ? (y - top) / height : 0;
  const edge = held ? 0.1 : 0.25;
  if (at >= edge && at <= 1 - edge) return "onto";
  return at < 0.5 ? "before" : "after";
}

// What a drop at this point would do. One of:
//   onto  the note is grouped with the loose note under the pointer
//   into  it joins the group under the pointer, in front of `before`
//   lane  it is set down in the lane, in front of `before` or at its end
//   stay  nothing: a lane sorted by votes takes no positions
function aimAt(x, y) {
  const d = ui.drag;
  for (const id in view.lanes) {
    const box = boxOf(view.lanes[id].el);
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) d.lane = view.lanes[id];
  }
  const lane = d.lane;
  // The slot goes in front of the first thing the pointer is above.
  const firstBelow = function (list) {
    for (let i = 0; i < list.children.length; i++) {
      const child = list.children[i];
      if (child === d.node) continue;
      const box = boxOf(child);
      if (child.classList.contains("ghost") || y < box.top + box.height / 2) return child;
    }
    return null;
  };
  let onto = null;
  if (d.kind === "note") {
    for (const gid in view.groups) {
      const group = view.groups[gid];
      const box = boxOf(group.el);
      if (contains(lane.list, group.el) && y >= box.top && y <= box.bottom) {
        restless();
        // In a sorted lane a group can be joined, at its end, but a note
        // already in it has nowhere new to go.
        if (lane.sorted && cardById(d.id).groupId === gid) return { type: "stay", lane: lane };
        return { type: "into", lane: lane, groupId: gid, list: group.list, before: lane.sorted ? null : firstBelow(group.list) };
      }
    }
    // Two notes are grouped inside one lane, so only a loose note in the
    // dragged note's own lane can be dropped on.
    for (let i = 0; i < lane.list.children.length && lane.id === d.from; i++) {
      const child = lane.list.children[i];
      const id = child !== d.node && ownerOfNode(child);
      const box = boxOf(child);
      if (id && view.notes[id] && y >= box.top && y <= box.bottom && zoneOf(y, box.top, box.height, d.dwell === id) === "onto") onto = id;
    }
  }
  if (!onto) restless();
  else if (d.dwell !== onto) {
    restless();
    d.dwell = onto;
    d.timer = setTimeout(function () {
      if (ui.drag !== d) return;
      d.ripe = true;
      dragTo(d.x, d.y);
    }, DWELL_MS);
  }
  if (onto && d.ripe) return { type: "onto", lane: lane, noteId: onto };
  // Resting on the middle of a note but not yet for long enough: the slot
  // stays where it last was, so passing over a note does not shuffle the lane.
  if (onto && d.aim.type !== "onto") return d.aim;
  if (lane.sorted) return lane.id === d.from ? { type: "stay", lane: lane } : { type: "lane", lane: lane, list: lane.list, before: null };
  return { type: "lane", lane: lane, list: lane.list, before: firstBelow(lane.list) };
}

// The pointer is not resting on the middle of a note.
export function restless() {
  clearTimeout(ui.drag.timer);
  ui.drag.dwell = null;
  ui.drag.ripe = false;
}

function aimSaid(aim) {
  if (aim.type === "onto") return "Drop to group with: " + short(cardById(aim.noteId).text);
  if (aim.type === "into") return "Drop into " + groupById(aim.groupId).title;
  if (aim.type === "stay") return SORTED_OFF;
  const title = columnTitle(aim.lane.id);
  if (aim.lane.sorted) return "Drop to add to " + title + ". That lane is sorted by rating for you, so no place in it can be picked.";
  const id = aim.before && ownerOfNode(aim.before);
  if (!id) return "Drop at the end of " + title;
  return view.notes[id] ? "Drop to move before: " + short(cardById(id).text) : "Drop to move before the group " + groupById(id).title;
}

// One lane, one group and one note at most wear the mark of a drop target.
export function mark(key, name, node) {
  const marks = ui.drag.marks;
  if (marks[key] === node) return;
  if (marks[key]) marks[key].classList.remove(name);
  if (node) node.classList.add(name);
  marks[key] = node;
}

export function dragTo(x, y) {
  const d = ui.drag;
  d.x = x;
  d.y = y;
  // The copy leans into the direction it is being carried.
  d.tilt += (Math.max(-4, Math.min(4, (x - d.lastX) * 0.6)) - d.tilt) * 0.25;
  d.lastX = x;
  d.copy.style.left = x - d.dx + "px";
  d.copy.style.top = y - d.dy + "px";
  d.copy.style.transform = motionOn() ? "rotate(" + d.tilt.toFixed(2) + "deg) scale(1.025)" : "";

  const aim = (d.aim = aimAt(x, y));
  // Over a note it would be grouped with, the slot stays where it is and
  // steps back: taking it out would move the note under the pointer.
  if (aim.type !== "onto") {
    const list = aim.list || d.home;
    const before = aim.list ? aim.before : d.next;
    if (d.node.parentNode !== list || d.node.nextElementSibling !== before) {
      reflow(function () {
        list.insertBefore(d.node, before);
      });
      forgetBoxes();
    }
  }
  d.node.classList.toggle("faded", aim.type === "onto");
  mark("note", "merge", aim.type === "onto" ? view.notes[aim.noteId].el : null);
  mark("group", "dropzone", aim.type === "into" ? view.groups[aim.groupId].el : null);
  mark("lane", "dropzone", aim.lane.id !== d.from ? aim.lane.el : null);
  const said = aimSaid(aim);
  if (said !== d.said) setText(live, (d.said = said));
}

