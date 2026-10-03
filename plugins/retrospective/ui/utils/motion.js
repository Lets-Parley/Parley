import { root } from "../bridge/host.js";
import { bag } from "./bag.js";
import { board, drawn, view } from "../bridge/state.js";

// ----------------------------------------------------------------- motion

// A damped spring on a unit mass, integrated until it comes to rest, as a
// CSS linear() easing plus the time it took. Nothing is cut short and no two
// springs share a duration.
export function spring(stiffness, damping) {
  const dt = 1 / 240;
  const points = [];
  let x = 0;
  let v = 0;
  let step = 0;
  let hit = 0;
  while (step < 480 && (Math.abs(1 - x) > 0.001 || Math.abs(v) > 0.01)) {
    v += (stiffness * (1 - x) - damping * v) * dt;
    x += v * dt;
    if (!hit && x >= 1) hit = step;
    if (step % 4 === 0 && points.length < 200) points.push(x.toFixed(3));
    step += 1;
  }
  points.push(1);
  const linear = !!window.CSS && window.CSS.supports("animation-timing-function", "linear(0,1)");
  return {
    duration: Math.round(step * dt * 1000),
    // When it first reaches where it is going: the moment of impact.
    hit: Math.round((hit || step) * dt * 1000),
    easing: linear ? "linear(" + points.join(",") + ")" : "cubic-bezier(0.22,1,0.36,1)",
    fill: "backwards",
  };
}
export const POP = spring(380, 22);
export const NUDGE = spring(700, 26);
export const GLIDE = spring(260, 30);
const TICK = spring(900, 44);
export const SLAP = spring(520, 15);
export const FLICK = spring(900, 14);

// The frame's own clock, used only to count a timer down from the time
// remaining the server sent. It is never compared with the server's.
export function clockNow() {
  return window.performance ? window.performance.now() : Date.now();
}

export function rectOf(node) {
  return node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
}

// Nothing moves on the first paint, and nothing moves for someone who has
// asked for less motion.
export function motionOn() {
  if (!drawn || typeof root.animate !== "function") return false;
  return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function animate(node, from, timing, delay) {
  node.animate([from, { transform: "none", opacity: 1 }], Object.assign({}, timing, { delay: delay || 0 }));
}

export function tick(node) {
  if (motionOn()) animate(node, { transform: "translateY(60%)", opacity: 0 }, TICK);
}

export function arrive(node) {
  node.classList.add("arriving");
  node.addEventListener("animationend", function () {
    node.classList.remove("arriving");
    node.style.animationDelay = "";
  });
}

export function measure() {
  const boxes = bag();
  for (const id in view.notes) boxes[id] = rectOf(view.notes[id].el);
  return boxes;
}

// Notes that changed place glide there from where they were.
export function glideFrom(before) {
  for (const id in before) {
    const note = view.notes[id];
    if (!note || note.el.classList.contains("arriving")) continue;
    const now = rectOf(note.el);
    const dx = before[id].left - now.left;
    const dy = before[id].top - now.top;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      animate(note.el, { transform: "translate(" + dx + "px," + dy + "px)" }, GLIDE);
    }
  }
}

// The reveal is the one beat that is staged: names are uncovered across the
// board in reading order, each sooner after the last, and then it is over.
export function revealWave() {
  const named = board.cards
    .map(function (c) {
      return view.notes[c.id];
    })
    .filter(function (note) {
      return note && !note.author.el.hidden;
    });
  named.forEach(function (note, i) {
    const delay = 1000 * Math.pow(i / named.length, 0.7);
    note.author.el.animate(
      [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
      { duration: 320, delay: delay, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "backwards" },
    );
    animate(note.author.disc, { transform: "scale(.6)" }, POP, delay);
  });
}

// Hiding them again is the same wave run backwards and quicker: it is a
// return to the usual state, not an occasion.
export function concealWave(named) {
  named.forEach(function (note, i) {
    note.author.el.hidden = false;
    const cover = note.author.el.animate(
      [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 100% 0 0)" }],
      { duration: 220, delay: 600 * Math.pow(i / named.length, 0.7), easing: "cubic-bezier(0.22,1,0.36,1)", fill: "forwards" },
    );
    cover.onfinish = function () {
      const boxes = measure();
      note.author.el.hidden = true;
      cover.cancel();
      glideFrom(boxes);
    };
  });
}

