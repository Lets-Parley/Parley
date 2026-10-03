import { setText, sync } from "../utils/dom.js";
import { idsOf, plural } from "../utils/text.js";
import { itemsOf, ui, view } from "../bridge/state.js";
import { viewerRole } from "../components/people.js";
import { arrive, clockNow, motionOn, rectOf, tick } from "../utils/motion.js";
import {
  buildLane, lanes, patchComposer, ranked, rankOf,
} from "../components/lane.js";
import { idOfNote, loseGhosts, myGhostOf } from "./compose.js";
import { buildNote, patchNote } from "../components/note.js";
import { buildGroup, patchGroup } from "../components/group.js";
import { unwatch, watchSize } from "./sticker-layout.js";

// ----------------------------------------------------------- lanes, drawn

function noteEl(card) {
  return view.notes[card.id].el;
}

export function forgetMissing(views, kept) {
  for (const id in views) if (!kept[id]) delete views[id];
}

export function patchNotes() {
  const fresh = [];
  ui.board.cards.forEach(function (card) {
    if (!view.notes[card.id]) {
      view.notes[card.id] = buildNote(card.id);
      fresh.push(view.notes[card.id]);
    }
    patchNote(view.notes[card.id], card);
  });
  const kept = idsOf(ui.board.cards);
  unwatch(view.notes, kept);
  forgetMissing(view.notes, kept);
  forgetMissing(ui.selected, kept);
  // A handful of new notes each get set down. A flood (a reconnect, a paste
  // storm) simply appears.
  // The viewer's own note was already on screen as its ghost: it settles
  // where it is, and never starts from nothing.
  if (motionOn() && fresh.length <= 6) {
    fresh.forEach(function (note) {
      const ghost = myGhostOf(note);
      if (!ghost) return arrive(note.el);
      // The real note takes the ghost's place. While the ghost is still
      // dropping in, it carries on that same drop from where it had got
      // to; after that, it glides from where the ghost stood, if anywhere else.
      const age = clockNow() - (ghost.born || 0);
      if (ghost.el.classList.contains("arriving") && age < 790) {
        note.el.style.animationDelay = -Math.round(age) + "ms";
        arrive(note.el);
      } else if (ui.landingBoxes) ui.landingBoxes[idOfNote(note)] = rectOf(ghost.el);
    });
  }
}

export function patchLanes() {
  ui.board.columns.forEach(function (col) {
    let lane = view.lanes[col.id];
    if (!lane) {
      lane = view.lanes[col.id] = buildLane(col);
      watchSize(lane.el, "laneId", col.id);
    }
    const shared = itemsOf(col.id);
    const count = shared.reduce(function (sum, item) {
      return sum + item.cards.length;
    }, 0);
    const listed = (lane.sorted ? ranked(shared, lane.sorted) : shared).map(function (item) {
      if (!item.group) return noteEl(item.cards[0]);
      const group = view.groups[item.id] || (view.groups[item.id] = buildGroup(item.id));
      patchGroup(group, item);
      sync(group.list, item.cards.map(noteEl));
      return group.el;
    });
    const ghosts = lane.ghosts.map(function (ghost) {
      return ghost.el;
    });
    sync(lane.list, listed.concat(ghosts));

    setText(lane.title, col.title);
    setText(lane.label, "Add a note to " + col.title);
    lane.add.setAttribute("aria-label", "Add note to " + col.title);
    if (lane.count.textContent !== String(count)) {
      const first = lane.count.textContent === "";
      setText(lane.count, String(count));
      if (!first) tick(lane.count);
    }
    setText(lane.countWords, ", " + plural(count, "note"));
    lane.empty.hidden = count + ghosts.length > 0;
    lane.prompt.hidden = ui.board.stage !== 0;

    // The lens is offered once there is something to rank by.
    const voted = shared.some(function (item) {
      return item.up + item.down > 0;
    });
    lane.sortToggle.hidden = !lane.sorted && (shared.length < 2 || !(voted || ui.board.stage >= 2));
    lane.sortToggle.setAttribute("aria-pressed", lane.sorted ? "true" : "false");
    lane.sortToggle.setAttribute("aria-label", "Top rated first in " + col.title + ", only for you");
    lane.sortToggle.setAttribute("title", "Top rated first, only for you");
    lane.sortLine.hidden = !lane.sorted;
    lane.resort.hidden = !lane.sorted || JSON.stringify(lane.sorted) === JSON.stringify(rankOf(shared));
    lane.share.hidden = viewerRole() === "participant";
    patchComposer(lane);
  });
  const columns = idsOf(ui.board.columns);
  for (const id in view.lanes) if (!columns[id]) loseGhosts(view.lanes[id]);
  unwatch(view.lanes, columns);
  forgetMissing(view.lanes, columns);
  forgetMissing(view.groups, idsOf(ui.board.groups));
  sync(
    lanes,
    ui.board.columns.map(function (col) {
      return view.lanes[col.id].el;
    }),
  );
}

