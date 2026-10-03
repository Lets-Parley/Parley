import { SETTLE, STAMPS, UNKNOWN_KIND } from "../assets/stickers.js";
import { NOT_KNOWN_MINE, ONLY_PRESSER } from "../constants/board.js";
import { contains, el, setText, sync } from "../utils/dom.js";
import { idsOf } from "../utils/text.js";
import { board, cardById, drawn, view } from "../bridge/state.js";
import {
  animate, FLICK, motionOn, NUDGE, rectOf, SLAP,
} from "../utils/motion.js";
import { live, notify } from "./notices.js";
import { closePop, pop, toggles } from "./popover.js";
import { openMenu } from "./menu.js";
import { leadOf } from "./note.js";
import { follow, hold, swallowClick } from "../features/drag.js";
import {
  AT_REST, centerOf, FLY, fractionAt, halfOf, leftFor, mineStamps, moves,
  nameOf, noteBox, notMine, PEEL, pileOf, pixelSize, pressing, putAt, removing,
  roomOn, saidKind, sawArrive, stampAt, stickerArt, stickerClass,
} from "../features/sticker-layout.js";
import {
  drawnPile, frontStamp, isPress, mayMove, nudgeStamp, ownStamp,
  patchStampStops, PILE_KEYS, removeStamp, sendStamp, settleStamp, stampById,
  STEPS_BY_KEY, walkPile,
} from "../features/sticker-actions.js";
import { forgetMissing } from "../features/render.js";

function buildStamp(s) {
  const id = s.id;
  const kind = STAMPS[s.kind];
  const stamp = { cardId: s.cardId, timer: 0, at: 0, art: stickerArt(s.kind) };
  stamp.btn = el("button", { type: "button", class: stickerClass(s.kind), "aria-describedby": "stamp-help", "aria-haspopup": "menu" }, [stamp.art]);
  stamp.el = el("li", {}, [stamp.btn]);

  stamp.btn.addEventListener("keydown", function (ev) {
    const step = STEPS_BY_KEY[ev.key];
    // Alt with an arrow moves the note, and a chord is the browser's.
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (step) nudgeStamp(id, step[0], step[1], ev.shiftKey, ev.repeat === true);
    else if (PILE_KEYS[ev.key]) walkPile(id, ev.key);
    else if (ev.key === "f" || ev.key === "F") frontStamp(id);
    else if (ev.key === "Delete" || ev.key === "Backspace") removeStamp(id);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  stamp.btn.addEventListener("focus", function () {
    const note = view.notes[stamp.cardId];
    if (!note || note.stampStop === id) return;
    note.stampStop = id;
    patchStampStops(stamp.cardId, drawnPile(stamp.cardId));
  });
  stamp.btn.addEventListener("blur", function () {
    settleStamp(id);
  });
  toggles(stamp.btn, function () {
    if (stamp.dragged) return;
    const remove = function () {
      removeStamp(id);
    };
    const label = s.kind === UNKNOWN_KIND ? "Sticker" : nameOf(s.kind) + " sticker";
    if (!ownStamp(id)) {
      // Whose it is cannot be seen. It is not offered as movable, and
      // removing it is the server's to refuse, once.
      openMenu(stamp.btn, label, [{ label: notMine[id] ? "Remove sticker" : "Remove, if you placed it", keys: "Delete", off: notMine[id] ? ONLY_PRESSER : "", run: remove }], nameOf(s.kind), notMine[id] ? ONLY_PRESSER : NOT_KNOWN_MINE);
      return;
    }
    openMenu(
      stamp.btn,
      label,
      [
        {
          label: "Bring to front",
          keys: "F",
          run: function () {
            frontStamp(id);
          },
        },
        {
          label: "Move with the arrow keys",
          keys: "Arrows",
          run: function () {
            stamp.btn.focus();
            setText(live, "The arrow keys move this sticker. Hold Shift for bigger steps.");
          },
        },
        { label: "Remove sticker", keys: "Delete", run: remove },
      ],
      nameOf(s.kind),
    );
  });
  // Dragging puts the sticker anywhere on its note. It follows the pointer
  // directly, held where it was taken hold of, and is sent once, when it
  // is let go. One that is not the viewer's to move does not come along.
  // Pointing at a sticker that lies on the words is pointing at the words.
  stamp.btn.addEventListener("pointerenter", function (ev) {
    const note = view.notes[stamp.cardId];
    if (ev.pointerType === "mouse" && note && stamp.btn.classList.contains("over")) {
      note.el.classList.add("peek");
      note.peekBy = id;
    }
  });
  stamp.btn.addEventListener("pointerleave", function (ev) {
    const note = view.notes[stamp.cardId];
    if (ev.pointerType === "mouse" && note) note.el.classList.remove("peek");
  });
  stamp.btn.addEventListener("pointerdown", function (ev) {
    if (ev.button || !stampById(id)) return;
    const start = { x: ev.clientX, y: ev.clientY };
    if (!ownStamp(id)) {
      // It does not come along, and says why: once, when the pull begins.
      let said = false;
      follow(
        ev.pointerId,
        function (e) {
          if (said || Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
          said = true;
          mayMove(id);
        },
        function () {
          if (said) swallowClick(stamp);
        },
      );
      return;
    }
    ev.stopPropagation();
    let grab = null;
    let box = null;
    const g = follow(
      ev.pointerId,
      function (e) {
        const now = stampById(id);
        if (!now) return;
        if (!grab) {
          if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
          // Measured once: the note does not move while one of its
          // stickers is carried.
          const raw = rectOf(view.notes[now.cardId].el);
          box = { left: raw.left, top: raw.top, width: raw.width || 240, height: raw.height || 44 };
          const c = centerOf(stampAt[id] || now, box);
          grab = [start.x - box.left - c[0], start.y - box.top - c[1]];
          g.active = true;
          closePop(false);
          hold(ev);
          stamp.btn.classList.add("lift");
          clearTimeout(stamp.timer);
          stamp.timer = 0;
        }
        const to = fractionAt(e.clientX - box.left - grab[0], e.clientY - box.top - grab[1], box);
        to.n = ++moves;
        stampAt[id] = to;
        putAt(stamp.btn, to);
      },
      function (e) {
        if (!grab) return;
        swallowClick(stamp);
        stamp.btn.classList.remove("lift");
        // A teammate, or the facilitator, removed it while it was held.
        if (!stampById(id) || !stampAt[id]) {
          notify("That sticker is no longer on the board.");
          return;
        }
        if (e.type !== "pointerup") delete stampAt[id];
        else {
          if (motionOn()) animate(stamp.art, { transform: "scale(1.2)" }, SLAP);
          setText(live, saidKind(s.kind) + " moved.");
          sendStamp(id, false);
        }
        patchStamps();
      },
    );
  });
  return stamp;
}

// The landing: the sticker comes down onto the note from above and to one
// side, its shadow closing as it does, the note gives under it, and the
// print settles in a way of its own. Each part is a spring run to rest; the
// note is hit when the sticker arrives. Both sets land the same way.
function landOwn(stamp, s) {
  const after = function (timing) {
    return Object.assign({}, timing, { delay: FLY.hit, fill: "none" });
  };
  stamp.btn.animate([{ transform: "translate(20px,-58px) rotate(-20deg) scale(1.32)" }, { transform: "none" }], FLY);
  stamp.art.animate([{ filter: "drop-shadow(0 4px 2px rgb(var(--sh)/.2)) drop-shadow(0 22px 14px rgb(var(--sh)/.3))" }, { filter: AT_REST }], FLY);
  view.notes[s.cardId].el.animate([{ transform: "translateY(2.5px)" }, { transform: "none" }], after(NUDGE));
  stamp.art.animate([{ transform: SETTLE[STAMPS[s.kind].meaning] }, { transform: "none" }], after(FLICK));
}

// A pixel sticker kicks up dust where it lands: four cells thrown out from
// under it at the moment of contact, each on its own arc under gravity,
// moving a whole cell at a time, and gone when it comes back down. A cell
// is the sticker's own cell, so the dust is as crisp as the sticker. Only
// the placer's own landing does this; a teammate's arrives without. The
// cells are not stickers: they are not in the pile, take no press and no
// focus, and are never measured. Each is taken away when its arc ends,
// however it ends, and no more than DUST_MAX are ever on the board.
const DUST = [[-150, -190], [-80, -250], [90, -240], [160, -180]];
const DUST_MAX = 24;
let dustLive = 0;

function kickDust(stamp, s) {
  const note = view.notes[s.cardId];
  if (!note || dustLive + DUST.length > DUST_MAX) return;
  const cell = pixelSize() / 14;
  const snap = function (v) {
    return Math.round(v / cell) * cell;
  };
  DUST.forEach(function (vel, i) {
    const bit = el("i", { class: "dust k-" + STAMPS[s.kind].meaning, "aria-hidden": "true" });
    bit.style.cssText = "width:" + cell + "px;height:" + cell + "px;left:" + stamp.btn.style.left + ";top:calc(" + stamp.btn.style.top + " + " + cell * 6 + "px);background:var(" + (i % 3 ? "--k" : "--color-ink-soft") + ")";
    note.el.appendChild(bit);
    dustLive += 1;
    // Up at `vel`, down under 1500px a second squared, until it is level again.
    const time = (-2 * vel[1]) / 1500;
    const frames = [{ transform: "scale(0)", easing: "step-end" }];
    for (let t = 0; t <= time; t += 1 / 60) frames.push({ transform: "translate(" + snap(vel[0] * t) + "px," + snap(vel[1] * t + 750 * t * t) + "px)", easing: "step-end" });
    frames.push({ transform: "translate(" + snap(vel[0] * time) + "px,0)" });
    let over = false;
    const done = function () {
      if (over) return;
      over = true;
      clearTimeout(backstop);
      dustLive -= 1;
      if (bit.parentNode) bit.parentNode.removeChild(bit);
    };
    const backstop = setTimeout(done, FLY.hit + time * 1000 + 250);
    const arc = bit.animate(frames, { duration: time * 1000, delay: FLY.hit, fill: "backwards" });
    arc.onfinish = done;
    arc.oncancel = done;
  });
}

// A teammate's comes down the same way from less high, and the note gives
// a little. It is smaller than the viewer's own on purpose.
function landOther(stamp, s) {
  stamp.btn.animate([{ transform: "translate(4px,-18px) scale(1.15)" }, { transform: "none" }], FLY);
  view.notes[s.cardId].el.animate([{ transform: "translateY(1px)" }, { transform: "none" }], Object.assign({}, NUDGE, { delay: FLY.hit, fill: "none" }));
}

// A sticker that is removed comes off the note: it lifts, turns a little
// and is gone, its shadow falling away under it. A teammate's only lifts.
// It stays in the note's list while it leaves, takes no press and no
// focus, and nothing else moves. With less motion asked for, or on the
// first paint, it is simply gone.
function peelOff(stamp, own) {
  const note = view.notes[stamp.cardId];
  if (!note || !drawn || !motionOn() || !stamp.el.parentNode) return;
  note.leaving.push(stamp.el);
  stamp.btn.classList.add("leaving");
  stamp.btn.setAttribute("tabindex", "-1");
  stamp.btn.setAttribute("aria-hidden", "true");
  const timing = Object.assign({}, PEEL, { fill: "forwards" });
  const going = stamp.btn.animate([{ transform: "none", opacity: 1 }, { transform: own ? "translate(7px,-13px) rotate(9deg) scale(1.16)" : "translate(2px,-6px) scale(1.05)", opacity: 0 }], timing);
  if (own) stamp.art.animate([{ filter: AT_REST }, { filter: "drop-shadow(0 4px 2px rgb(var(--sh)/.2)) drop-shadow(0 18px 12px rgb(var(--sh)/.26))" }], timing);
  // It ends once, however it ends: the animation finishing, or being
  // canceled (the note hidden by a stage change, the tab put away), or,
  // if neither is ever heard, a little after the spring would have rested.
  let over = false;
  const done = function () {
    if (over) return;
    over = true;
    clearTimeout(backstop);
    note.leaving = note.leaving.filter(function (other) {
      return other !== stamp.el;
    });
    if (stamp.el.parentNode) stamp.el.parentNode.removeChild(stamp.el);
    if (note.stamps.children.length === 0) note.stamps.hidden = true;
  };
  const backstop = setTimeout(done, PEEL.duration + 250);
  going.onfinish = done;
  going.oncancel = done;
}

// What needs the note measured: which stickers lie over its words, and
// where the next one would land. Every note is measured before anything is
// written, so the page is laid out once however many notes there are.
export function layoutStickers(ids) {
  const measured = ids
    .filter(function (cardId) {
      return view.notes[cardId] && cardById(cardId);
    })
    .map(function (cardId) {
      const note = view.notes[cardId];
      const raw = rectOf(note.el);
      const text = rectOf(note.text);
      return { cardId: cardId, note: note, box: noteBox(cardId), words: { left: text.left - raw.left, top: text.top - raw.top + 6, width: text.width, height: text.height - 12 } };
    });
  measured.forEach(function (m) {
    const w = m.words;
    pileOf(m.cardId).forEach(function (s) {
      // Four pixels at a sticker's rim are let go.
      const r = halfOf(s.kind) - 4;
      const stamp = view.stamps[s.id];
      if (!stamp) return;
      const c = centerOf(stampAt[s.id] || s, m.box);
      stamp.btn.classList.toggle("over", w.width > 0 && w.height > 0 && c[0] + r > w.left && c[0] - r < w.left + w.width && c[1] + r > w.top && c[1] - r < w.top + w.height);
    });
    // The plus is there while this viewer can add one.
    const full = roomOn(m.cardId) === 0 || leftFor(m.cardId) === 0;
    if (m.note.add.hidden !== full) m.note.add.hidden = full;
  });
}

export function patchStamps() {
  const kept = idsOf(board.stamps);
  const held = document.activeElement;
  const fresh = [];
  const changed = [];
  let orphan = null;
  let claimed = null;
  for (const id in view.stamps) {
    if (kept[id]) continue;
    if (view.stamps[id].btn === held) orphan = view.stamps[id];
    if (pop && pop.anchor === view.stamps[id].btn) closePop(false);
    clearTimeout(view.stamps[id].timer);
    delete stampAt[id];
    // A sticker that goes while it is pointed at never hears the pointer leave.
    const from = view.notes[view.stamps[id].cardId];
    if (from && from.peekBy === id) {
      from.peekBy = null;
      from.el.classList.remove("peek");
    }
    peelOff(view.stamps[id], removing[id]);
    delete removing[id];
  }
  for (const cardId in view.notes) {
    const pile = drawnPile(cardId);
    const note = view.notes[cardId];
    const card = cardById(cardId);
    sync(
      note.stamps,
      pile.map(function (s, i) {
        let stamp = view.stamps[s.id];
        if (!stamp) {
          stamp = view.stamps[s.id] = buildStamp(s);
          fresh.push(s);
          if (drawn) sawArrive[s.id] = true;
          const wait = pressing.filter(function (w) {
            return isPress(s, w);
          })[0];
          if (wait) {
            pressing.splice(pressing.indexOf(wait), 1);
            mineStamps[s.id] = true;
            claimed = stamp;
          }
        }
        stamp.at = i;
        putAt(stamp.btn, stampAt[s.id] || s);
        // The tilt is the vinyl set's. Pixel art is drawn square to the
        // screen, so the stored tilt of a pixel sticker is not used.
        stamp.btn.style.setProperty("--rot", (STAMPS[s.kind].set === "pixel" ? 0 : s.rot) + "deg");
        stamp.btn.classList.toggle("fixed", !ownStamp(s.id));
        stamp.btn.setAttribute("aria-label", (s.kind === UNKNOWN_KIND ? "Sticker, " : nameOf(s.kind) + " sticker, ") + (i + 1) + " of " + pile.length + " on this note, counting from the bottom of the pile");
        return stamp.el;
      }).concat(note.leaving),
    );
    note.stamps.hidden = pile.length + note.leaving.length === 0;
    patchStampStops(cardId, pile);
    // Measured again only when something that could move things has changed.
    const sig = [board.stage, board.revealed, card ? card.text.length : 0, leftFor(cardId), roomOn(cardId), note.chips.hidden, note.linked, note.votes, note.pick.hidden]
      .concat(
        pile.map(function (s) {
          const at = stampAt[s.id] || s;
          return s.id + ":" + at.x + ":" + at.y;
        }),
      )
      .join("|");
    if (note.sig !== sig) {
      note.sig = sig;
      changed.push(cardId);
    }
  }
  forgetMissing(view.stamps, kept);
  layoutStickers(changed);
  // Focus on a sticker that was removed goes to the next one down the pile,
  // then to the place a new one is added, then to the note.
  if (orphan && view.notes[orphan.cardId]) {
    const note = view.notes[orphan.cardId];
    const left = drawnPile(orphan.cardId);
    const next = left[Math.min(Math.max(0, orphan.at - 1), left.length - 1)];
    (next ? view.stamps[next.id].btn : note.add.hidden ? leadOf(note) : note.add).focus();
  }
  // Putting one sticker on top moves the others in the document, and a
  // moved node drops its focus.
  if (held && held !== document.activeElement && held.isConnected && document.activeElement === document.body) held.focus({ preventScroll: true });
  // The sticker this viewer just placed takes focus, so the arrow keys can
  // move it at once; unless they have already gone on to something else.
  if (claimed) {
    const now = document.activeElement;
    if (now === document.body || contains(view.notes[claimed.cardId].el, now)) claimed.btn.focus({ preventScroll: true });
  }
  // Nothing lands on the first paint, in a flood, or for someone who has
  // asked for less motion: there the sticker is simply there, and is
  // announced like any other.
  if (!drawn || fresh.length > 3 || !motionOn()) return;
  fresh.forEach(function (s) {
    const stamp = view.stamps[s.id];
    if (stamp !== claimed) landOther(stamp, s);
    else {
      landOwn(stamp, s);
      if (STAMPS[s.kind].set === "pixel") kickDust(stamp, s);
    }
  });
}

