import { el } from "../utils/dom.js";
import { animate, motionOn, POP, rectOf } from "../utils/motion.js";
import { mainRow, topRow } from "../main.js";

// --------------------------------------------------------------- popovers

// One floating thing at a time: a menu, the sticker book, the action form or
// the timer controls. It hangs from the control that opened it, closes on
// Escape or a press elsewhere, and hands focus back to that control.
export const layer = el("div", { class: "layer" });
export let pop = null;

// `alive` says whether what the popover is about is still on the board.
export function openPop(anchor, node, patch, alive) {
  closePop(false);
  pop = { anchor: anchor, el: node, patch: patch, alive: alive };
  // A menu closes on Tab. A sheet keeps Tab inside itself: the board under
  // it is inert, so the next stop would be the host page.
  if (node.getAttribute("role") !== "menu" && !node.ownTab) {
    node.addEventListener("keydown", function (ev) {
      if (ev.key !== "Tab") return;
      const stops = tabStops(node, []);
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement);
      ev.preventDefault();
      stops[(at + (ev.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    });
  }
  setBehind(true);
  anchor.setAttribute("aria-expanded", "true");
  layer.appendChild(node);
  placePop();
  // The frame cannot see how far the host page is scrolled, so the sheet
  // asks to be brought into sight.
  if (node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
  if (motionOn()) animate(node, { transform: node.rises ? "translateY(40px)" : "translateY(-6px) scale(.97)", opacity: 0 }, POP);
}

export function tabStops(node, found) {
  for (let i = 0; i < node.children.length; i++) {
    const kid = node.children[i];
    if (kid.hidden) continue;
    if (/^(BUTTON|INPUT|TEXTAREA)$/.test(kid.tagName) && !kid.disabled && kid.getAttribute("tabindex") !== "-1") found.push(kid);
    else tabStops(kid, found);
  }
  return found;
}

// Under its control; above it when there is no room below; and, with room
// on neither side, as low as it can go and still be whole. It is never off
// an edge of the frame. A menu hangs from the right edge of its button, so
// it does not lie over the next lane. The layer scrolls with the page, so
// it stays put.
// `keep` is for a popover whose content changed while it is open: it stays
// on the side of its control it opened on, held by the edge nearest it.
export function placePop(keep) {
  if (!pop) return;
  const a = rectOf(pop.anchor);
  const width = pop.el.offsetWidth || 0;
  const height = pop.el.offsetHeight || 0;
  const high = window.innerHeight || 0;
  const menu = pop.el.getAttribute("role") === "menu";
  const kept = keep && pop.side;
  const below = kept ? kept === "below" : a.bottom + 6 + height <= high - 8;
  const above = kept ? kept === "above" : !below && a.top - 6 - height >= 8;
  pop.side = below ? "below" : above ? "above" : "fit";
  const top = below ? (kept ? Math.min(a.bottom + 6, Math.max(8, high - 8 - height)) : a.bottom + 6) : above ? Math.max(8, a.top - 6 - height) : Math.max(8, high - 8 - height);
  const left = Math.max(8, Math.min(menu ? a.right - width : a.left, (window.innerWidth || 0) - width - 8));
  pop.el.style.left = left + (window.scrollX || 0) + "px";
  pop.el.style.top = top + (window.scrollY || 0) + "px";
  pop.el.style.transformOrigin = (menu ? "100% " : "0 ") + (above ? "100%" : "0");
}

export function closePop(refocus) {
  if (!pop) return;
  const was = pop;
  pop = null;
  was.anchor.setAttribute("aria-expanded", "false");
  layer.removeChild(was.el);
  if (was.under) layer.removeChild(was.under);
  setBehind(false);
  // Focus goes back to where it came from, which is not always the control
  // the popover hangs from.
  if (refocus) (was.back && was.back.isConnected ? was.back : was.anchor).focus();
}

// While something floats over the board, the board under it is inert: a
// press outside closes the popover and does nothing else, and a control
// half covered by it is not a target anybody has to aim at.
function setBehind(on) {
  [topRow, mainRow].forEach(function (part) {
    if (on) part.setAttribute("inert", "");
    else part.removeAttribute("inert");
  });
}

// The control that opens a popover also closes it.
export function toggles(anchor, open) {
  anchor.setAttribute("aria-expanded", "false");
  anchor.addEventListener("click", function () {
    if (pop && pop.anchor === anchor) closePop(true);
    else open();
  });
}

