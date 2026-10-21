import { parley, root } from "./bridge/host.js";
import { fontFaces, STYLES } from "./styles/sheet.js";
import { contains, el, setText } from "./utils/dom.js";
import { boardOf, cardById, selectedIds, ui, view } from "./bridge/state.js";
import {
  concealWave, glideFrom, measure, motionOn, revealWave,
} from "./utils/motion.js";
import { live, notify, toast } from "./components/notices.js";
import { closePop, layer, placePop } from "./components/popover.js";
import { describeChanges, settleLanded } from "./bridge/actions.js";
import {
  hintRow, patchProgress, placeThumb, stageNav, stepViews, thumb,
} from "./components/stage-bar.js";
import { patchTimer, timerSlot } from "./components/timer.js";
import { arm, authorship, patchAuthorship } from "./components/authorship.js";
import { lanes } from "./components/lane.js";
import { reconcileGhosts, sendNext } from "./features/compose.js";
import { gripHelp, leadOf } from "./components/note.js";
import { patchEditor, rescueDraft } from "./features/editing.js";
import { forgetBoxes, unswallow } from "./features/drag.js";
import { scrollSpot } from "./features/drag-scroll.js";
import { setPixelSize, stampHelp } from "./features/sticker-layout.js";
import { layoutStickers, patchStamps } from "./components/sticker.js";
import { patchLanes, patchNotes } from "./features/render.js";
import {
  clearSelection, patchSelection, reserveForBar, selectBar,
} from "./components/selection-bar.js";
import {
  actionForm, actionReopen, actions, actionText, clearSpot, patchActionForm,
  patchActions,
} from "./components/action-list.js";

// ------------------------------------------------------------------ shell

// No h1: the frame sits under the host page's own, and a screen reader reads
// the two documents as one outline. The lanes and the actions are its h2s.
export const topRow = el("div", { class: "top" }, [
  el("section", { class: "progress", "aria-label": "Stage" }, [
    el("div", { class: "steps-wrap" }, [
      thumb,
      el(
        "ol",
        { class: "steps" },
        stepViews.map(function (v) {
          return v.el;
        }),
      ),
    ]),
    timerSlot,
    hintRow,
    stageNav,
  ]),
  authorship,
]);
export const mainRow = el("div", { class: "main" }, [lanes, actions]);
export const main = el("main", { class: "board", "aria-label": "Retrospective board" }, [
  topRow,
  mainRow,
  el("div", { class: "dock" }, [el("div", { role: "status" }, [toast]), selectBar]),
  layer,
  stampHelp,
  gripHelp,
]);
layer.appendChild(scrollSpot);
if (window.IntersectionObserver) {
  const steps = [];
  for (let i = 0; i <= 400; i++) steps.push(i / 400);
  new window.IntersectionObserver(
    function (entries) {
      const seen = entries[entries.length - 1].intersectionRect;
      ui.inSight = seen.height ? { top: seen.top, bottom: seen.bottom } : null;
    },
    { threshold: steps },
  ).observe(main);
}

// A host that sends the scheme has already set color-scheme on the root. An
// older one sends only colors, and the surface token says which theme it is.
function applyScheme(tokens) {
  let scheme = typeof parley.scheme === "function" ? parley.scheme() : null;
  if (scheme !== "light" && scheme !== "dark") {
    const hex = /^#([0-9a-f]{6})$/i.exec((tokens && tokens.surface) || "");
    if (!hex) return;
    const n = parseInt(hex[1], 16);
    const luminance = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    scheme = luminance < 0.5 ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-scheme", scheme);
}

export function onState(next) {
  // null means the viewer is in a room this plugin does not provide.
  if (!next) return;
  if (ui.drag) {
    ui.heldState = next;
    return;
  }
  const before = ui.board;
  const named = ui.board.revealed
    ? ui.board.cards
        .map(function (c) {
          return view.notes[c.id];
        })
        .filter(function (note) {
          return note && !note.author.el.hidden;
        })
    : [];
  const wasFocused = document.activeElement;
  const boxes = motionOn() ? measure() : null;
  ui.landingBoxes = boxes;
  // The note focus is in, and its place in its lane, in case it is deleted.
  let lost = null;
  ui.board.cards.forEach(function (c) {
    if (!view.notes[c.id] || !contains(view.notes[c.id].el, wasFocused)) return;
    const lane = ui.board.cards.filter(function (o) {
      return o.columnId === c.columnId;
    });
    lost = { id: c.id, columnId: c.columnId, at: lane.indexOf(c) };
  });
  // Focus inside a sheet belongs, for this purpose, to the note or the
  // action the sheet was opened from.
  const inPop = ui.pop && contains(ui.pop.el, wasFocused);
  const fromActions = inPop && contains(actions, ui.pop.anchor);
  if (inPop) {
    ui.board.cards.forEach(function (c) {
      if (!view.notes[c.id] || !contains(view.notes[c.id].el, ui.pop.anchor)) return;
      const lane = ui.board.cards.filter(function (o) {
        return o.columnId === c.columnId;
      });
      lost = { id: c.id, columnId: c.columnId, at: lane.indexOf(c) };
    });
  }

  ui.session = next;
  ui.board = boardOf(next);
  const orphaned = ui.editing && !cardById(ui.editing.id) ? (before.cards.filter(function (c) { return c.id === ui.editing.id; })[0] || {}).columnId : null;
  if (ui.drawn && before.revealed && !ui.board.revealed) ui.hiddenAgain = true;
  patchProgress();
  patchNotes();
  patchStamps();
  patchLanes();
  patchActions();
  patchActionForm();
  patchAuthorship();
  patchSelection();
  patchTimer();
  if (ui.editing && !cardById(ui.editing.id)) rescueDraft(orphaned);
  else if (ui.editing) patchEditor();
  // A teammate can delete the note a menu or a form was opened from. The
  // board under it is inert while it is open, so it cannot be left there.
  if (ui.pop && (!ui.pop.anchor.isConnected || (ui.pop.alive && !ui.pop.alive()))) {
    closePop(ui.pop.anchor.isConnected);
    notify("That was removed from the board while you had it open.");
    if (fromActions && document.activeElement === document.body) (actionForm.hidden ? actionReopen : actionText).focus({ preventScroll: true });
  }
  if (ui.pop && ui.pop.patch) ui.pop.patch();
  // The board is first shown with its content already in it, so nothing
  // jumps into place a moment after it appears.
  if (!ui.drawn) root.appendChild(main);
  placeThumb(before.stage !== ui.board.stage);
  settleLanded();
  reconcileGhosts();
  sendNext();

  // Moving a node drops its focus. Nothing a teammate does may take focus
  // away or scroll the page, so it goes back, quietly, to whatever held it.
  if (wasFocused && wasFocused !== document.activeElement && wasFocused.isConnected && document.activeElement === document.body) {
    wasFocused.focus({ preventScroll: true });
  }
  // Focus on a note that was deleted goes to the note now in its place, or
  // to the lane's composer when the lane is empty.
  if (lost && !view.notes[lost.id] && view.lanes[lost.columnId] && document.activeElement === document.body) {
    const left = ui.board.cards.filter(function (c) {
      return c.columnId === lost.columnId;
    });
    const lane = view.lanes[lost.columnId];
    const heir = left.length ? leadOf(view.notes[left[Math.min(lost.at, left.length - 1)].id]) : lane.row.hidden ? lane.reopen : lane.input;
    heir.focus({ preventScroll: true });
  }
  if (boxes) glideFrom(boxes);
  ui.landingBoxes = null;
  if (motionOn() && ui.board.revealed && !before.revealed) revealWave();
  if (motionOn() && !ui.board.revealed && before.revealed) concealWave(named);
  if (ui.drawn) setText(live, describeChanges(before, ui.board));
  ui.drawn = true;
}

document.addEventListener("keydown", function (ev) {
  clearSpot();
  if (ev.key !== "Escape") return;
  if (ui.gesture) {
    const carrying = ui.gesture.active;
    ui.gesture.end({ type: "pointercancel" });
    if (carrying) return;
  }
  if (ui.pop) closePop(true);
  else if (ui.armed) arm(false);
  else if (selectedIds().length) clearSelection();
});
// A press of the pointer a gesture is still following means its release was
// never heard, as happens when the button is let go outside the frame. The
// old gesture ends here, before the press reaches whatever it is on, so
// nothing it held (the carried copy, the state that waited, the pointer's
// capture) outlives it.
document.addEventListener(
  "pointerdown",
  function (ev) {
    if (ui.gesture) ui.gesture.end({ type: "pointercancel", pointerId: ev.pointerId });
  },
  true,
);
document.addEventListener("pointerdown", function (ev) {
  clearSpot();
  unswallow();
  if (ui.pop && !contains(ui.pop.el, ev.target) && !contains(ui.pop.anchor, ev.target)) closePop(false);
});
// A page that cannot be seen is not dragged on: whatever is carried is put
// back, and nothing goes on scrolling behind a tab.
document.addEventListener("visibilitychange", function () {
  if (document.hidden && ui.gesture) ui.gesture.end({ type: "pointercancel" });
});
window.addEventListener("scroll", forgetBoxes);
window.addEventListener("resize", function () {
  forgetBoxes();
  setPixelSize();
  reserveForBar();
  placeThumb(false);
  // A phone's keyboard resizes the frame when it opens. The form somebody
  // is typing in stays; it is only put back beside its control.
  placePop();
});
// The step pill is measured, and the measure changes when the faces load
// or the steps wrap.
if (window.ResizeObserver) {
  const watcher = new window.ResizeObserver(function () {
    placeThumb(false);
  });
  stepViews.forEach(function (v) {
    watcher.observe(v.el);
  });
}

document.head.appendChild(el("style", { text: fontFaces() + STYLES }));
setPixelSize();
// A live region is only listened to if it was there before its first
// message, so it is mounted now and the board joins it with the first state.
root.appendChild(live);
patchProgress();
patchTimer();
patchAuthorship();
patchActionForm();
patchSelection();
// The faces can arrive after the first layout: the lines of every note then
// move without any note changing size, so the stickers are looked at again.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function () {
    layoutStickers(Object.keys(view.notes));
  });
}
parley.onTokens(applyScheme);
parley.onState(onState);
parley.ready();
