import { bag } from "../utils/bag.js";
import { GLYPH } from "../assets/glyphs.js";
import { LANES, NOTE_LIMIT, OTHER_LANE } from "../constants/board.js";
import { el, icon, setText } from "../utils/dom.js";
import { plural } from "../utils/text.js";
import { board, byVotes, itemsOf } from "../bridge/state.js";
import { glideFrom, measure, motionOn } from "../utils/motion.js";
import { propose } from "../bridge/actions.js";
import { onlyFacilitator } from "./stage-bar.js";
import { addNote } from "../features/compose.js";
import { patchLanes } from "../features/render.js";

// ------------------------------------------------------------------ lanes

export const lanes = el("div", { class: "lanes" });
export const SORTED_OFF = "Sorted by rating. Show shared order to move notes here.";

export function buildLane(col) {
  const meta = LANES[col.id] || OTHER_LANE;
  const headingId = "lane-" + col.id;
  const inputId = "note-" + col.id;
  const lane = {
    id: col.id,
    open: false,
    ghosts: [],
    title: el("h2", { id: headingId, dir: "auto" }),
    // "Top rated" is a lens for one reader: `sorted` holds the ranking as
    // it stood when it was switched on, and nothing is written anywhere.
    sorted: null,
    sortToggle: el("button", { type: "button", class: "sort", "aria-pressed": "false", title: "Top rated" }, [icon(GLYPH.bars), el("span", { class: "sort-word", text: "Top rated" })]),
    resort: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Re-sort" }),
    unsort: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Show shared order" }),
    share: el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Use this order for everyone" }),
    prompt: el("p", { class: "prompt", text: meta.prompt }),
    count: el("span", { class: "count", "aria-hidden": "true" }),
    countWords: el("span", { class: "sr-only" }),
    label: el("label", { class: "sr-only", for: inputId }),
    input: el("textarea", { id: inputId, class: "field", rows: 1, maxlength: NOTE_LIMIT, placeholder: "Add a note", dir: "auto" }),
    add: el("button", { type: "button", class: "btn btn-primary", text: "Add" }),
    reopen: el("button", { type: "button", class: "reopen" }, [icon(GLYPH.plus), el("span", { text: "Add a note" })]),
    left: el("p", { class: "left" }),
    empty: el("p", { class: "empty", text: meta.empty }),
    list: el("ul", { class: "notes" }),
  };
  lane.row = el("div", { class: "composer-row" }, [lane.input, lane.add]);
  lane.sortLine = el("div", { class: "sort-line row" }, [
    el("p", { class: "fine", text: "Top rated first, only for you: ups less downs." }),
    lane.resort,
    lane.unsort,
    lane.share,
  ]);
  lane.el = el("section", { class: "lane panel", "aria-labelledby": headingId, style: "--hue:var(--color-" + meta.hue + ")" }, [
    el("div", { class: "lane-head" }, [
      el("span", { class: "lane-glyph" }, [icon(meta.glyph)]),
      el("div", { class: "lane-title" }, [lane.title, lane.prompt]),
      lane.sortToggle,
      lane.count,
      lane.countWords,
    ]),
    lane.sortLine,
    el("div", { class: "composer" }, [lane.label, lane.row, lane.reopen, lane.left]),
    lane.empty,
    lane.list,
  ]);

  const sortBy = function (rank) {
    reflow(function () {
      lane.sorted = rank;
      patchLanes();
    });
  };
  lane.sortToggle.addEventListener("click", function () {
    sortBy(lane.sorted ? null : rankOf(itemsOf(lane.id)));
  });
  lane.resort.addEventListener("click", function () {
    sortBy(rankOf(itemsOf(lane.id)));
    lane.unsort.focus();
  });
  lane.unsort.addEventListener("click", function () {
    sortBy(null);
    lane.sortToggle.focus();
  });
  lane.share.addEventListener("click", function () {
    propose("order-by-votes", { columnId: lane.id }, {
      // The new order is in whatever state comes next.
      landed: function () {
        return true;
      },
      refused: { forbidden: onlyFacilitator("reorder a lane for everyone") },
      unsure: "Could not confirm the new order. " + onlyFacilitator("reorder a lane for everyone"),
      settle: function (outcome) {
        if (outcome !== "landed" && outcome !== "accepted") return;
        const held = document.activeElement === lane.share;
        sortBy(null);
        if (held) lane.sortToggle.focus();
      },
    });
  });

  lane.input.addEventListener("input", function () {
    patchComposer(lane);
  });
  lane.input.addEventListener("blur", function () {
    lane.open = false;
    patchComposer(lane);
  });
  // The frame is sandboxed without allow-forms, so a form would never
  // submit. Enter is handled here; Shift+Enter still makes a new line.
  lane.input.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    addNote(lane);
  });
  lane.add.addEventListener("click", function () {
    addNote(lane);
  });
  lane.reopen.addEventListener("click", function () {
    lane.open = true;
    patchComposer(lane);
    lane.input.focus();
  });
  return lane;
}

// The ranking of a lane by votes: a group by the votes of its notes
// together, and the notes inside it by their own. Ties keep the shared order.
export function rankOf(items) {
  const rank = bag();
  items.slice().sort(byVotes).forEach(function (item, i) {
    rank[item.id] = i;
    if (!item.group) return;
    item.cards.slice().sort(byVotes).forEach(function (c, j) {
      rank[c.id] = j;
    });
  });
  return rank;
}

// Items in a ranking taken earlier. What has arrived since goes last.
export function ranked(items, rank) {
  const by = function (a, b) {
    return (a.id in rank ? rank[a.id] : 1e9) - (b.id in rank ? rank[b.id] : 1e9);
  };
  return items.slice().sort(by).map(function (item) {
    return item.group ? Object.assign({}, item, { cards: item.cards.slice().sort(by) }) : item;
  });
}

// Make a change that moves notes, and let them glide to where they end up.
// Moving a node drops its focus, so focus is handed back afterwards.
export function reflow(change) {
  const held = document.activeElement;
  const boxes = motionOn() ? measure() : null;
  change();
  if (held && held !== document.activeElement && held.isConnected && document.activeElement === document.body) {
    held.focus({ preventScroll: true });
  }
  if (boxes) glideFrom(boxes);
}

// One row that grows with what is typed. After the Write stage an idle
// composer steps back behind "Add a note"; both are the same height, so
// nothing moves when it does. It never closes: a late note is still a note.
export function patchComposer(lane) {
  const input = lane.input;
  const idle = !input.value && !lane.open && document.activeElement !== input;
  const room = NOTE_LIMIT - input.value.length;
  lane.row.hidden = board.stage !== 0 && idle;
  lane.reopen.hidden = !lane.row.hidden;
  lane.add.disabled = !input.value.trim();
  setText(lane.left, room <= 100 ? plural(room, "character") + " left" : "");
  lane.left.hidden = room > 100;
  input.style.height = "";
  if (input.scrollHeight > 42) input.style.height = input.scrollHeight + 2 + "px";
}

