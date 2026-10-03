import { bag } from "../utils/bag.js";
import { PIXEL, STAMPS, UNKNOWN_KIND, VINYL } from "../assets/stickers.js";
import {
  LATE_MS, PER_NOTE, PER_PERSON, ST_PAD_X, ST_PAD_Y, WAIT_MS,
} from "../constants/board.js";
import { el } from "../utils/dom.js";
import { cardById, ui, unit, view } from "../bridge/state.js";
import { clockNow, rectOf, spring } from "../utils/motion.js";
import { layoutStickers } from "../components/sticker.js";

// --------------------------------------------------------------- stickers

// A sticker is placed on a note and stays where it was put: it sits over
// the note, may hang a little over its edges, and takes up no room, so
// nothing moves when one arrives or leaves. Stickers pile up in the order
// they land: the state lists them bottom to top, and one that is moved goes
// back down on top. The state says what each sticker is and where, and
// never who placed it. Which ones are this viewer's own is known only from
// what happened in this visit: a sticker that appeared exactly as it was
// sent, and a move the server accepted or refused.
export const stampHelp = el("p", {
  id: "stamp-help",
  class: "sr-only",
  text: "The arrow keys move this sticker, with Shift for bigger steps. Page Up and Page Down go up and down the pile. F brings it to the front. Delete removes it. Enter opens its options.",
});
export const mineStamps = bag();
export const notMine = bag();
// Where a sticker has been put by this viewer, until the state agrees. It
// is drawn there, and on top, in the order these were made.
export const stampAt = bag();
export const FLY = spring(360, 23);
// 271ms to rest: a sticker comes off quicker than it goes on.
export const PEEL = spring(1100, 60);
// Stickers this viewer has asked to have removed: theirs peel off, a
// teammate's only lifts away.
export const removing = bag();
// A lane too narrow for the handle and the checkbox to stand side by side.
export const lanesNarrow = bag();
// One observer for every lane and every note. A lane says whether it is
// narrow; a note that changes size has its stickers looked at again, which
// changes the size of nothing, so it does not feed itself.
const sizes = window.ResizeObserver
  ? new window.ResizeObserver(function (entries) {
      const ids = [];
      entries.forEach(function (entry) {
        const node = entry.target;
        if (node.laneId !== undefined) {
          lanesNarrow[node.laneId] = entry.contentRect.width < 340;
          node.classList.toggle("narrow", lanesNarrow[node.laneId]);
        } else if (view.notes[node.cardId]) ids.push(node.cardId);
      });
      if (ids.length) layoutStickers(ids);
    })
  : null;

export function watchSize(node, key, id) {
  node[key] = id;
  if (sizes) sizes.observe(node);
}

// What has left the board is no longer watched, or it would be kept alive.
export function unwatch(views, kept) {
  for (const id in views) if (!kept[id] && sizes) sizes.unobserve(views[id].el);
}

export function setPixelSize() {
  document.documentElement.style.setProperty("--px", pixelSize() + "px");
}
export const AT_REST = "drop-shadow(0 1px .6px rgb(var(--sh)/.3)) drop-shadow(0 2px 3px rgb(var(--sh)/.2))";

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function svgOf(viewBox, parts) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  parts.forEach(function (part) {
    if (!part[1]) return;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", part[0]);
    path.setAttribute("d", part[1]);
    svg.appendChild(path);
  });
  return svg;
}

// Pixel rows become paths of one-cell-high runs: the art centered in a box
// of fourteen cells, a ring of ink one cell wide around it, and the three
// fills. The ring is also the shape of the paper border and the edge.
function pixelParts(art) {
  const rows = art.split("/");
  const wide = rows.reduce(function (w, r) {
    return Math.max(w, r.length);
  }, 0);
  const ox = (14 - wide) >> 1;
  const oy = (14 - rows.length) >> 1;
  const at = function (x, y) {
    return (rows[y - oy] || "")[x - ox] || ".";
  };
  const on = function (x, y) {
    return at(x, y) !== ".";
  };
  const runs = function (test) {
    let d = "";
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 14; x++) {
        if (!test(x, y)) continue;
        let n = 1;
        while (x + n < 14 && test(x + n, y)) n++;
        d += "M" + x + " " + y + "h" + n + "v1h-" + n + "z";
        x += n;
      }
    }
    return d;
  };
  const ring = runs(function (x, y) {
    return on(x, y) || on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1);
  });
  const fill = function (c) {
    return runs(function (x, y) {
      return at(x, y) === c;
    });
  };
  return [["e", ring], ["w", ring], ["o", ring], ["c", fill("#")], ["f", fill("o")], ["q", fill("+")]];
}

export function stickerArt(kind) {
  const k = STAMPS[kind];
  if (k.set === "pixel") {
    const svg = svgOf("0 0 14 14", pixelParts(PIXEL[k.meaning]));
    svg.setAttribute("shape-rendering", "crispEdges");
    return svg;
  }
  const v = VINYL[k.meaning];
  const parts = [["e", v[0]], ["w", v[0]], ["o", v[0]], ["c", v[0]]];
  for (let i = 1; i < v.length; i += 2) parts.push([v[i], v[i + 1]]);
  return svgOf("3 3 34 34", parts);
}

// Fourteen cells across, each a whole number of device pixels: 42px where
// a pixel is a pixel or two, and the nearest such size at any other zoom.
export function pixelSize() {
  const dpr = window.devicePixelRatio || 1;
  return (14 * Math.max(1, Math.round(3 * dpr))) / dpr;
}

// From a sticker's center to its rim: the pixel set is not always 42 across.
export function halfOf(kind) {
  return (STAMPS[kind] && STAMPS[kind].set === "pixel" && kind !== UNKNOWN_KIND ? pixelSize() : 42) / 2;
}

export function stickerClass(kind) {
  return "st k-" + STAMPS[kind].meaning + (STAMPS[kind].set === "pixel" ? " px" : "");
}

// A sticker to look at, in the book and in the list: not a control.
export function face(kind, more) {
  return el("span", { class: stickerClass(kind) + (more || "") }, [stickerArt(kind)]);
}

// "Thank you, pixel": the meaning first, then the set, which is how a
// colleague looking at it will refer to it.
export function nameOf(kind) {
  return kind === UNKNOWN_KIND ? "Unknown" : STAMPS[kind].label + ", " + STAMPS[kind].set;
}

// What a sticker is called when something is said about it.
export function saidKind(kind) {
  return kind === UNKNOWN_KIND ? "Sticker" : STAMPS[kind].label + " sticker";
}

// The size a note is taken to be when it cannot be measured.
export function noteBox(cardId) {
  const box = rectOf(view.notes[cardId].el);
  const note = view.notes[cardId];
  // The row of chips at the foot of a note is not somewhere a sticker lands.
  const kept = note.chips.hidden ? 0 : rectOf(note.chips).width + 33;
  return { left: box.left, top: box.top, width: box.width || 240, height: box.height || 44, kept: kept, lines: linesOf(note, box) };
}

// Where the note's controls are, from the note's corner: the handle with
// the checkbox, the menu button, and the buttons on the lower edge. With the checkbox hidden, the room it
// takes when it is shown is counted too (under the handle in a narrow lane,
// beside it otherwise), so a sticker placed in one stage is not on a
// checkbox in the next.
function controlsOf(cardId, note, box) {
  const card = cardById(cardId);
  const fine = !(window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
  return [note.grip.parentNode, note.more, note.rx]
    .map(function (node, i) {
      const r = rectOf(node);
      // The strip the three buttons stand on, whichever of them is there:
      // 84 across, or 120 where they are a finger's size.
      if (i === 2) return { left: r.right - box.left - (fine ? 84 : 120), top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top, width: r.width };
      const grow = i === 0 && note.pick.hidden;
      const grip = grow ? rectOf(note.grip) : r;
      const stacked = fine && card && lanesNarrow[card.columnId];
      return { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left + (grow && !stacked ? grip.width : 0), bottom: r.bottom - box.top + (grow && stacked ? grip.height : 0), width: r.width };
    })
    .filter(function (r) {
      return r.width > 0;
    });
}

// Whether a sticker centered on a point would be on, or within 6px of, a
// control: that is the room a small target needs around it.
function onControls(point, half, controls) {
  const r = half + 6;
  return (controls || []).some(function (c) {
    return point[0] + r > c.left && point[0] - r < c.right && point[1] + r > c.top && point[1] - r < c.bottom;
  });
}

// Where the words of a note are, line by line, from the note's corner:
// each box is as wide as the words on that line, not as the paragraph.
function linesOf(note, box) {
  if (!document.createRange) return [];
  const range = document.createRange();
  range.selectNodeContents(note.text);
  const lines = [];
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width > 0) lines.push({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top });
  }
  return lines;
}

// Whether something `r` across, centered on a point, would lie on words.
function onWords(point, r, lines) {
  return lines.some(function (l) {
    return point[0] + r > l.left && point[0] - r < l.right && point[1] + r > l.top && point[1] - r < l.bottom;
  });
}

// A sticker's center on its note, in pixels from the note's corner, and
// the same thing the other way: the fractions a point on the note is.
export function centerOf(at, box) {
  return [ST_PAD_X + at.x * (box.width - 2 * ST_PAD_X), at.y * (box.height + 2 * ST_PAD_Y) - ST_PAD_Y];
}

export function fractionAt(cx, cy, box) {
  return {
    x: round3(unit((cx - ST_PAD_X) / Math.max(1, box.width - 2 * ST_PAD_X))),
    y: round3(unit((cy + ST_PAD_Y) / (box.height + 2 * ST_PAD_Y))),
  };
}

export function putAt(node, at) {
  node.style.left = "calc(" + ST_PAD_X + "px + " + at.x + " * (100% - " + 2 * ST_PAD_X + "px))";
  node.style.top = "calc(" + at.y + " * (100% + " + 2 * ST_PAD_Y + "px) - " + ST_PAD_Y + "px)";
}

// A note's pile, bottom to top, as the state has it.
export function pileOf(cardId) {
  return ui.board.stamps.filter(function (s) {
    return s.cardId === cardId;
  });
}

export function topOf(b, cardId) {
  let top = null;
  b.stamps.forEach(function (s) {
    if (s.cardId === cardId) top = s.id;
  });
  return top;
}

// A press nobody answered is not waited for forever.
function pressingOn(cardId) {
  ui.pressing = ui.pressing.filter(function (old) {
    return clockNow() - old.at < WAIT_MS + LATE_MS;
  });
  return ui.pressing.filter(function (wait) {
    return wait.body.cardId === cardId;
  });
}

// How many more stickers this viewer may place on a note, as far as this
// visit knows. The server counts for certain, and says so when it differs.
export function leftFor(cardId) {
  const mine = pileOf(cardId).filter(function (s) {
    return mineStamps[s.id];
  }).length;
  return Math.max(0, PER_PERSON - mine - pressingOn(cardId).length);
}

// Whose the stickers on a note are is never published, so how many of them
// are this viewer's is known only when every one of them arrived during
// this visit: after a reload, an older one may be the viewer's own.
export const sawArrive = bag();

export function countKnown(cardId) {
  return pileOf(cardId).every(function (s) {
    return sawArrive[s.id];
  });
}

export function roomOn(cardId) {
  return Math.max(0, PER_NOTE - pileOf(cardId).length - pressingOn(cardId).length);
}

// Where a sticker lands when it is picked from the book: clear of the
// words. The corner under the note's handle when the note is tall enough
// to have one, then along the bottom edge, then between those; of these,
// only the places where the sticker would lie on no word.
function slots(width, height, kept) {
  const out = [];
  const coarse = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
  const deep = height >= (coarse ? 76 : 64);
  if (deep) out.push([14, height - 10]);
  // And up the handle's column, as far as the handle: no word is there.
  for (let y = height - 34; deep && y >= (coarse ? 74 : 62); y -= 24) out.push([14, y]);
  [0, 15].forEach(function (shift) {
    for (let x = (deep ? 50 : 14) + shift; x <= width - Math.max(60, kept || 0); x += 30) out.push([x, height + ST_PAD_Y]);
  });
  return out.length ? out : [[14, height + ST_PAD_Y]];
}

function centersOn(cardId, box) {
  return pileOf(cardId)
    .map(function (s) {
      return stampAt[s.id] || s;
    })
    .concat(
      pressingOn(cardId).map(function (wait) {
        return wait.body;
      }),
    )
    .map(function (at) {
      return centerOf(at, box);
    });
}

// The first of those places that is on no word and has no sticker within
// 14px of it; successive stickers are always visibly apart until the note
// is full. A sticker still on its way counts.
export function freeSpot(cardId, box, kind) {
  const there = centersOn(cardId, box);
  const half = halfOf(kind);
  // Never on a control; then, of what is left, clear of the words.
  const controls = controlsOf(cardId, view.notes[cardId], box);
  const every = slots(box.width, box.height, box.kept);
  const safe = every.filter(function (p) {
    return !onControls(p, half, controls);
  });
  const clear = safe.filter(function (p) {
    return !onWords(p, half, box.lines || []);
  });
  // Apart from every sticker already there, one still on its way included.
  const apart = function (p) {
    return there.reduce(function (least, c) {
      return Math.min(least, Math.hypot(c[0] - p[0], c[1] - p[1]));
    }, Infinity);
  };
  const free = function (p) {
    return apart(p) >= 14;
  };
  // A place off the words first; then one of the same places that lies on
  // them, which is still its own place and not on top of another sticker.
  let spot = clear.filter(free)[0] || safe.filter(free)[0];
  if (!spot) {
    // Every one of those is taken. The whole note is looked over, 12px at
    // a time, for the place farthest from the stickers on it: off the
    // words if any such place is 12 clear, and never on a control.
    const grid = [];
    for (let y = box.height + ST_PAD_Y; y >= -ST_PAD_Y; y -= 12) {
      for (let x = 14; x <= box.width - 14; x += 12) {
        if (!onControls([x, y], half, controls)) grid.push([x, y]);
      }
    }
    const far = function (list) {
      return list.reduce(function (best, p) {
        return !best || apart(p) > apart(best) ? p : best;
      }, null);
    };
    const off = far(
      grid.filter(function (p) {
        return !onWords(p, half, box.lines || []);
      }),
    );
    spot = (off && apart(off) >= 12 ? off : far(grid)) || (safe.length ? safe : every)[0];
  }
  return fractionAt(spot[0], spot[1], box);
}

