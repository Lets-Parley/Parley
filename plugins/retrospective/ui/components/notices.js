import { TOAST_MS } from "../constants/board.js";
import { el, setText } from "../utils/dom.js";
import { animate, motionOn, POP } from "../utils/motion.js";

// ---------------------------------------------------------------- notices

export const live = el("div", { class: "live sr-only", role: "status" });
export const toast = el("div", { class: "toast" });
toast.hidden = true;
let toastTimer = 0;

export function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
  setText(toast, "");
}

export function notify(message) {
  hideToast();
  setText(toast, message);
  toast.hidden = false;
  if (motionOn()) animate(toast, { transform: "translateY(12px)", opacity: 0 }, POP);
  toastTimer = setTimeout(hideToast, TOAST_MS);
  return message;
}

// Say something that may be what was said last. A live region speaks when
// its text changes, so it is emptied first and filled a moment later; asked
// several times in that moment, it speaks once.
let again = 0;

export function sayAgain(text) {
  setText(live, "");
  clearTimeout(again);
  again = setTimeout(function () {
    if (live.textContent === "") setText(live, text);
  }, 60);
}

// Take a message back, if it is still the one on screen.
export function retract(message) {
  if (message && toast.textContent === message) hideToast();
}

