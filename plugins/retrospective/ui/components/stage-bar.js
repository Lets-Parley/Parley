import { GLYPH } from "../assets/glyphs.js";
import { HINTS, STEPS } from "../constants/board.js";
import { el, icon, setText } from "../utils/dom.js";
import { ui } from "../bridge/state.js";
import { facilitator, viewerRole } from "./people.js";
import { animate, GLIDE, motionOn, rectOf } from "../utils/motion.js";
import { propose } from "../bridge/actions.js";
import { main } from "../main.js";

// ------------------------------------------------------------------ stage

// All four hints are laid in the same cell and only the current one shows,
// so the strip is as tall as the longest and a stage change moves nothing.
const hints = HINTS.map(function (text) {
  return el("p", { class: "hint", text: text });
});
export const thumb = el("span", { class: "thumb", "aria-hidden": "true" });
export const stepViews = STEPS.map(function (name, i) {
  const number = el("span", { text: String(i + 1) });
  const check = el("span", {}, [icon(GLYPH.check)]);
  const status = el("span", { class: "sr-only" });
  const item = el("li", { class: "step" }, [
    el("span", { class: "step-mark", "aria-hidden": "true" }, [number, check]),
    el("span", { class: "step-name", text: name }),
    status,
  ]);
  return { el: item, number: number, check: check, status: status };
});
const stageNextWord = el("span");
const stageNext = el("button", { type: "button", class: "btn btn-primary btn-small stage-next" }, [stageNextWord, icon(GLYPH.arrow)]);
const stageBackTo = el("span", { class: "back-to" });
const stageBack = el("button", { type: "button", class: "btn btn-quiet btn-small stage-back" }, [el("span", { text: "Back" }), stageBackTo]);
// On a phone the hint is one line, and this opens the rest of it.
const hintMore = el("button", { type: "button", class: "hint-more", "aria-expanded": "false", "aria-label": "Show the whole hint" }, [icon(GLYPH.chevron)]);
export const hintRow = el("div", { class: "hints" }, hints.concat([hintMore]));
hintRow.addEventListener("click", function () {
  const open = !hintRow.classList.contains("open");
  hintRow.classList.toggle("open", open);
  hintMore.setAttribute("aria-expanded", open ? "true" : "false");
});
export const stageNav = el("div", { class: "row stage-nav" }, [stageBack, stageNext]);
let staging = false;

export function onlyFacilitator(what) {
  const who = facilitator();
  return "Only the facilitator" + (who ? ", " + who.name + "," : "") + " can " + what + ".";
}

// The facilitator gets the two buttons, and so does a viewer the host has
// not identified: the server decides, and says so if the answer is no.
export function patchProgress() {
  const stage = ui.board.stage;
  const held = document.activeElement;
  main.className = "board stage-" + stage;
  stepViews.forEach(function (v, i) {
    const current = i === stage;
    const done = i < stage;
    v.el.className = "step" + (current ? " current" : done ? " reached" : "");
    if (current) v.el.setAttribute("aria-current", "step");
    else v.el.removeAttribute("aria-current");
    v.number.hidden = done;
    v.check.hidden = !done;
    setText(v.status, current ? ", current" : done ? ", done" : "");
  });
  hints.forEach(function (hint, i) {
    hint.classList.toggle("shown", i === stage);
    if (i === stage) hint.removeAttribute("aria-hidden");
    else hint.setAttribute("aria-hidden", "true");
  });
  stageNav.hidden = viewerRole() === "participant";
  stageNext.hidden = stage === STEPS.length - 1;
  stageBack.hidden = stage === 0;
  // Not `disabled`: a button that is disabled while it has focus drops it,
  // and the facilitator who changed the stage with a key would be nowhere.
  [stageNext, stageBack].forEach(function (btn) {
    if (staging) btn.setAttribute("aria-disabled", "true");
    else btn.removeAttribute("aria-disabled");
  });
  if (!stageNext.hidden) setText(stageNextWord, "Move to " + STEPS[stage + 1]);
  if (!stageBack.hidden) {
    setText(stageBackTo, " to " + STEPS[stage - 1]);
    stageBack.setAttribute("aria-label", "Back to " + STEPS[stage - 1]);
  }
  // The button that was pressed may be the one that just went away.
  if (held === stageNext && stageNext.hidden) stageBack.focus();
  if (held === stageBack && stageBack.hidden) stageNext.focus();
}

// One pill sits behind the current step and slides to the next one, the
// same way forward and back: it is one object, moved.
export function placeThumb(glide) {
  const step = stepViews[ui.board.stage].el;
  const from = rectOf(thumb);
  thumb.style.left = (step.offsetLeft || 0) + "px";
  thumb.style.top = (step.offsetTop || 0) + "px";
  thumb.style.width = (step.offsetWidth || 0) + "px";
  thumb.style.height = (step.offsetHeight || 0) + "px";
  if (!glide || !motionOn()) return;
  const to = rectOf(thumb);
  const stretch = to.width ? from.width / to.width : 1;
  animate(thumb, { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scaleX(" + stretch + ")" }, GLIDE);
}

function setStage(stage) {
  if (staging) return;
  staging = true;
  propose("set-stage", { stage: stage }, {
    landed: function (b) {
      return b.stage === stage;
    },
    refused: { forbidden: onlyFacilitator("change the stage") },
    unsure: "Could not confirm the stage change. " + onlyFacilitator("change the stage"),
    settle: function (outcome) {
      if (outcome === "accepted") return;
      staging = false;
      patchProgress();
    },
  });
  patchProgress();
}

stageNext.addEventListener("click", function () {
  setStage(ui.board.stage + 1);
});
stageBack.addEventListener("click", function () {
  setStage(ui.board.stage - 1);
});

