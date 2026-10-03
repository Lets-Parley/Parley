import { GLYPH } from "../assets/glyphs.js";
import { MINUTE, PRESETS, STEPS } from "../constants/board.js";
import { el, icon, setText } from "../utils/dom.js";
import { board } from "../bridge/state.js";
import { viewerRole } from "./people.js";
import { animate, clockNow, motionOn, POP, tick } from "../utils/motion.js";
import { live, notify } from "./notices.js";
import { closePop, openPop, toggles } from "./popover.js";
import { propose } from "../bridge/actions.js";
import { onlyFacilitator } from "./stage-bar.js";

// ------------------------------------------------------------------ timer

// The server sends the time remaining, stamped as it builds each state. The
// frame counts down from there on its own clock, and takes a new reading
// only when the timer itself changes (its `rev`), so a teammate's vote that
// arrives a little late cannot nudge the countdown.
const RING = 2 * Math.PI * 8;
const timerArc = ringPart("arc");
// A paused timer shows two bars where the ring was and says so in a word;
// on a phone there is room for the bars only.
const timerPaused = el("span", { class: "timer-paused" });
const timerDigits = el("span");
const timerText = el("span", { class: "mono timer-text" }, [timerPaused, timerDigits]);
const timerRing = ringSvg([ringPart("track"), timerArc]);
const timerBars = icon(GLYPH.pause);
const timerFace = el("span", { class: "timer-face", role: "timer", "aria-live": "off" }, [timerRing, timerBars, timerText]);
const timerWord = el("span", { text: "Timer" });
const timerButton = el("button", { type: "button", class: "btn btn-quiet btn-small timer-open", "aria-haspopup": "dialog" }, [
  icon(GLYPH.clock),
  timerWord,
]);
export const timerSlot = el("div", { class: "timer-slot" }, [timerFace, timerButton]);
let timerRev = null;
let timerEnd = 0;
let timerLoop = 0;
let timerSecond = null;
let timerSaid = {};

function ringPart(name) {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const attrs = { class: name, cx: 10, cy: 10, r: 8, fill: "none", "stroke-width": 2.5, "stroke-dasharray": RING, transform: "rotate(-90 10 10)" };
  for (const key in attrs) circle.setAttribute(key, attrs[key]);
  return circle;
}

function ringSvg(parts) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attrs = { width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": "true" };
  for (const key in attrs) svg.setAttribute(key, attrs[key]);
  parts.forEach(function (part) {
    svg.appendChild(part);
  });
  return svg;
}

export function clockFace(ms) {
  const seconds = Math.ceil(ms / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function timeLeft() {
  const t = board.timer;
  return t.running ? Math.max(0, timerEnd - clockNow()) : t.remaining;
}

export function patchTimer() {
  const t = board.timer;
  timerButton.hidden = viewerRole() === "participant";
  timerWord.hidden = !!t;
  timerButton.setAttribute("aria-label", t ? "Timer controls" : "Set a timer");
  timerFace.hidden = !t;
  clearTimeout(timerLoop);
  if (!t) {
    timerRev = null;
    return;
  }
  if (t.rev !== timerRev) {
    timerRev = t.rev;
    timerEnd = clockNow() + t.remaining;
    timerSecond = null;
    // What had already gone by when this viewer first saw the timer is
    // not announced: a late joiner is not told "time's up" on arrival.
    timerSaid = { 60000: t.remaining <= 60000, 10000: t.remaining <= 10000, 0: t.remaining <= 0 };
  }
  tickTimer();
}

// Runs four times a second while a timer is running, and not at all
// otherwise. Screen readers hear three moments, never the ticking.
function tickTimer() {
  const t = board.timer;
  const left = timeLeft();
  const second = Math.ceil(left / 1000);
  const paused = !t.running && left > 0;
  setText(timerPaused, paused ? "Paused " : "");
  setText(timerDigits, left <= 0 ? "Time's up" : clockFace(left));
  timerRing.setAttribute("style", paused ? "display:none" : "");
  timerBars.setAttribute("style", paused ? "" : "display:none");
  timerFace.classList.toggle("ending", left <= 10000);
  timerArc.setAttribute("stroke-dashoffset", (RING * (1 - Math.min(1, left / t.duration))).toFixed(2));
  if (second !== timerSecond) {
    if (timerSecond !== null && t.running && left > 0 && left <= 10000) tick(timerText);
    timerSecond = second;
  }
  [
    [60000, t.duration >= 3 * MINUTE && "One minute left."],
    [10000, "10 seconds left."],
    [0, "Time's up."],
  ].forEach(function (moment) {
    if (left > moment[0] || timerSaid[moment[0]]) return;
    timerSaid[moment[0]] = true;
    if (moment[1]) setText(live, moment[1]);
    if (moment[0] === 0 && motionOn()) animate(timerFace, { transform: "scale(1.14)" }, POP);
  });
  if (t.running && left > 0) timerLoop = setTimeout(tickTimer, 250);
}

function sendTimer(body) {
  const key = function (b) {
    return b.timer ? b.timer.rev : "none";
  };
  const was = key(board);
  closePop(true);
  propose("timer", body, {
    // The timer changed, and to what was asked for: somebody else's change
    // to it is not this one landing.
    landed: function (b) {
      const t = b.timer;
      if (key(b) === was) return false;
      if (body.op === "clear") return !t;
      if (body.op === "pause") return !!t && !t.running;
      return !!t && (body.op === "add" || t.running);
    },
    refused: { forbidden: onlyFacilitator("set the timer"), conflict: "No timer is set." },
    unsure: "Could not confirm the timer change. " + onlyFacilitator("set the timer"),
  });
}

function timerControl(label, body, kind) {
  const control = el("button", { type: "button", class: "btn btn-small " + (kind || "btn-quiet"), text: label });
  control.addEventListener("click", function () {
    sendTimer(body);
  });
  return control;
}

function openTimer() {
  const t = board.timer;
  const panel = el("div", { class: "pop sheet", role: "dialog", "aria-label": "Timer" });
  if (t) {
    const first = !t.running ? timerControl("Resume", { op: "resume" }, "btn-primary") : timeLeft() > 0 ? timerControl("Pause", { op: "pause" }) : null;
    const controls = [timerControl("+1 min", { op: "add" }), timerControl("Clear", { op: "clear" })];
    panel.appendChild(el("div", { class: "row" }, first ? [first].concat(controls) : controls));
  } else {
    const minutes = el("input", { id: "timer-minutes", class: "field", inputmode: "numeric", maxlength: 3, placeholder: "1 to 180" });
    const start = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Start" });
    const custom = function () {
      const n = Number(minutes.value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 180) notify("A timer runs from 1 to 180 minutes.");
      else sendTimer({ op: "start", durationMs: n * MINUTE });
    };
    start.addEventListener("click", custom);
    minutes.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") custom();
    });
    panel.appendChild(el("p", { class: "label", text: "Start a timer for " + STEPS[board.stage] }));
    panel.appendChild(
      el(
        "div",
        { class: "row" },
        PRESETS.map(function (m) {
          return timerControl(m + " min", { op: "start", durationMs: m * MINUTE });
        }),
      ),
    );
    panel.appendChild(el("div", { class: "row" }, [el("label", { class: "label", for: "timer-minutes", text: "Minutes" }), minutes, start]));
  }
  openPop(timerButton, panel);
  panel.children[t ? 0 : 1].children[0].focus();
}

toggles(timerButton, openTimer);

