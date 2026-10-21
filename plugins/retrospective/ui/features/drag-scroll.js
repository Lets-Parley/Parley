import { NOTE_GONE } from "../constants/board.js";
import { el, setText } from "../utils/dom.js";
import { cardById, groupById, ui, view } from "../bridge/state.js";
import { animate, clockNow, GLIDE, motionOn, rectOf } from "../utils/motion.js";
import { live, notify } from "../components/notices.js";
import { layer } from "../components/popover.js";
import { SORTED_OFF } from "../components/lane.js";
import { placeSaid, sendMove } from "./moves.js";
import { dragTo, EDGE, GONE, mark, ownerOfNode, restless } from "./drag.js";
import { patchLanes } from "./render.js";
import { openGroupName } from "../components/selection-bar.js";
import { main, onState } from "../main.js";

// Held near the top or the bottom of what is in sight, the page keeps
// scrolling for as long as the pointer stays there, moving or not: that is
// how a note gets from one lane to another on a phone, where lanes are
// stacked. The nearer the edge, the faster. The pointer stays where it is
// on the screen while the board moves under it, so its place on the board
// is worked out from how far the board has moved since it was last heard
// from. A pointer held still does not scroll for ever: after SCROLL_MS, or
// once the page has gone as far as the board is tall, it waits for the
// pointer to move again.
const SCROLL_MIN = 120;
const SCROLL_MAX = 900;
const SCROLL_MS = 10000;
const nextFrame = window.requestAnimationFrame
  ? function (fn) {
      return window.requestAnimationFrame(fn);
    }
  : function (fn) {
      return setTimeout(fn, 16);
    };
const dropFrame = window.cancelAnimationFrame
  ? function (id) {
      window.cancelAnimationFrame(id);
    }
  : clearTimeout;

// How fast to scroll with the pointer at `y`, in pixels a second: negative
// is up, and nothing at all away from the edges.
function edgeSpeed(y) {
  const sight = ui.inSight || { top: 0, bottom: window.innerHeight || 0 };
  const past = y < sight.top + EDGE ? y - sight.top - EDGE : y > sight.bottom - EDGE ? y - sight.bottom + EDGE : 0;
  if (!past) return 0;
  const pull = Math.min(1, Math.abs(past) / EDGE);
  return (past < 0 ? -1 : 1) * (SCROLL_MIN + pull * (SCROLL_MAX - SCROLL_MIN));
}

export function keepScrolling(d, moved) {
  const now = clockNow();
  if (moved) {
    d.stillSince = now;
    d.scrolled = 0;
  }
  // One frame at a time: a pointer that moves faster than frames come
  // must not keep putting the next one off.
  if (d.scroll) return;
  if (!edgeSpeed(d.y) || now - d.stillSince > SCROLL_MS || d.scrolled > rectOf(main).height + (window.innerHeight || 0)) return;
  d.scrollAt = now;
  d.scroll = nextFrame(function () {
    d.scroll = 0;
    if (ui.drag !== d) return;
    // What is carried has left the page: there is nothing to scroll for.
    if (!d.node.isConnected) {
      if (ui.gesture) ui.gesture.end({ type: "pointercancel" });
      return;
    }
    const y = d.py + sightTop() - d.seen;
    if (y !== d.y) dragTo(d.x, y);
    const speed = edgeSpeed(d.y);
    const dt = Math.min(50, Math.max(8, clockNow() - d.scrollAt));
    const by = Math.round((speed * dt) / 1000) || (speed < 0 ? -1 : speed > 0 ? 1 : 0);
    if (by) {
      scrollPage(by);
      d.scrolled += Math.abs(by);
    }
    keepScrolling(d, false);
  });
}

// The frame is as tall as the board and does not scroll: the host page
// does, and the frame cannot ask how far. What it can learn is which part of
// the board is in sight, in its own coordinates, and it can ask for a spot
// just outside that part to be brought into sight. The part in sight is
// `ui.inSight`.
export const scrollSpot = el("div", { class: "scroll-spot", "aria-hidden": "true" });

export function sightTop() {
  return ui.inSight ? ui.inSight.top : 0;
}

function scrollPage(by) {
  window.scrollBy(0, by);
  if (!ui.inSight || !scrollSpot.scrollIntoView) return;
  scrollSpot.style.top = (by < 0 ? ui.inSight.top + by : ui.inSight.bottom + by - 1) - rectOf(layer).top + "px";
  scrollSpot.scrollIntoView({ block: "nearest" });
}

// Every way a drag ends comes through here, and every one of them takes the
// copy, the marks and the timers away and lets the held state through.
export function putDown(commit) {
  const d = ui.drag;
  const aim = d.aim;
  const from = rectOf(d.copy);
  const moved = d.node.parentNode !== d.home || d.node.nextElementSibling !== d.next;
  const beforeId = aim.before ? ownerOfNode(aim.before) : null;
  restless();
  dropFrame(d.scroll);
  // Left where it was, the spot would keep the page a little taller.
  scrollSpot.style.top = "0px";
  mark("note", "merge", null);
  mark("group", "dropzone", null);
  mark("lane", "dropzone", null);
  ui.drag = null;
  main.removeChild(d.copy);
  d.node.classList.remove("slot");
  d.node.classList.remove("faded");
  document.documentElement.classList.remove("dragging");
  if (ui.heldState) {
    const waiting = ui.heldState;
    ui.heldState = null;
    onState(waiting);
  }
  const group = d.kind === "group";
  const thing = group ? groupById(d.id) : cardById(d.id);
  if (!thing) {
    // It was deleted while it was being carried.
    patchLanes();
    notify(group ? GONE : NOTE_GONE);
    return;
  }
  // What it was aimed at may have gone the same way.
  const there =
    aim.lane &&
    ui.board.columns.some(function (c) {
      return c.id === aim.lane.id;
    }) &&
    (aim.type !== "into" || groupById(aim.groupId)) &&
    (aim.type !== "onto" || cardById(aim.noteId));
  if (!commit || aim.type === "stay" || !there || (aim.type !== "onto" && !moved)) {
    patchLanes();
    if (commit && aim.type === "stay" && aim.lane) notify(SORTED_OFF);
    else if (commit && !there && aim.lane) notify(GONE);
    else if (!commit) setText(live, "Not moved.");
  } else if (aim.type === "onto") {
    patchLanes();
    openGroupName(aim.noteId, d.id);
    return;
  } else {
    // The same bodies the menu sends: a lane change names the lane, joining
    // a group names the group, and a place names what it is in front of.
    const body = group ? { groupId: d.id } : { cardId: d.id };
    if (aim.lane.id !== thing.columnId && aim.type === "lane") body.columnId = aim.lane.id;
    else if (!group) body.groupId = aim.type === "into" ? aim.groupId : null;
    if (beforeId && (cardById(beforeId) || groupById(beforeId))) body.beforeId = beforeId;
    sendMove(group ? "move-group" : "move-card", body, function () {
      return placeSaid(d.kind, d.id);
    });
  }
  // Moving a node drops its focus. It goes to the handle of what was
  // carried, so the keyboard carries on from there; the page is not scrolled.
  const carried = group ? view.groups[d.id] : view.notes[d.id];
  if (carried && document.activeElement === document.body) carried.grip.focus({ preventScroll: true });
  // It comes to rest from where the copy was let go.
  if (motionOn()) {
    const to = rectOf(d.node);
    animate(d.node, { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) rotate(" + d.tilt.toFixed(2) + "deg)", boxShadow: "var(--shadow-lift)" }, GLIDE);
  }
}

