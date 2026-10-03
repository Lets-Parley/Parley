import { el, setText } from "../utils/dom.js";
import { board } from "../bridge/state.js";
import { facilitator, viewerRole } from "./people.js";
import { propose } from "../bridge/actions.js";
import { onlyFacilitator } from "./stage-bar.js";

// ------------------------------------------------------------- authorship

const authTitle = el("p", { class: "auth-title" });
const authLine = el("p", { class: "fine" });
const revealButton = el("button", { type: "button", class: "btn btn-quiet btn-small" }, [
  el("span", { class: "brass-dot", "aria-hidden": "true" }),
  el("span", { text: "Reveal authors" }),
]);
const revealConfirm = el("button", { type: "button", class: "btn btn-brass btn-small", text: "Reveal to everyone" });
const revealCancel = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Not yet" });
const revealArmed = el("div", { class: "row" }, [revealConfirm, revealCancel]);
const concealButton = el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Hide authors again" });
export const authorship = el("section", { class: "authorship panel", "aria-label": "Authorship" }, [
  el("div", { class: "auth-text" }, [authTitle, authLine]),
  revealButton,
  revealArmed,
  concealButton,
]);
export let armed = false;
let revealing = false;
let concealing = false;
// Set when this viewer watched the names go away, so the panel can say
// "again" to someone who would otherwise wonder where they went.
export let hiddenAgain = false;

// The server decides who may reveal and who may hide. What is shown follows
// what the frame knows: the facilitator gets the control, everyone else is
// told who holds it, and a host that does not say who is looking gets both.
export function patchAuthorship() {
  const role = viewerRole();
  const who = facilitator();
  const offered = !board.revealed && role !== "participant" && board.cards.length > 0;
  if (!offered) armed = false;
  authorship.classList.toggle("armed", armed);

  revealButton.hidden = !offered || armed;
  revealArmed.hidden = !offered || !armed;
  revealConfirm.disabled = revealing;
  setText(revealConfirm, revealing ? "Revealing…" : "Reveal to everyone");
  concealButton.hidden = !board.revealed || role === "participant";
  concealButton.disabled = concealing;

  const facilitatorName = who ? who.name + ", the facilitator," : "The facilitator";
  if (board.revealed) {
    setText(authTitle, "Authors are visible");
    setText(authLine, "Everyone can see who wrote each note.");
  } else if (armed) {
    setText(authTitle, "Show everyone who wrote each note?");
    setText(authLine, "You can hide them again, but anyone looking now will have seen them.");
  } else {
    setText(authTitle, "Notes are anonymous");
    if (role === "facilitator") setText(authLine, "Only you can reveal who wrote them.");
    else if (role === "unknown") setText(authLine, onlyFacilitator("reveal authors"));
    else if (hiddenAgain) setText(authLine, "Notes are anonymous again. " + facilitatorName + " can reveal them.");
    else setText(authLine, facilitatorName + " reveals authors when the room is ready.");
  }
}

export function arm(on) {
  armed = on;
  patchAuthorship();
  (on ? revealCancel : revealButton).focus();
}

function confirmReveal() {
  if (revealing) return;
  revealing = true;
  propose("reveal", {}, {
    landed: function (b) {
      return b.revealed;
    },
    refused: { forbidden: onlyFacilitator("reveal authors") },
    unsure: "Could not confirm the reveal. " + onlyFacilitator("reveal authors"),
    settle: function (outcome) {
      if (outcome === "accepted") return;
      revealing = false;
      if (outcome !== "landed" && armed) arm(false);
      else patchAuthorship();
      if (outcome === "landed" && !concealButton.hidden) concealButton.focus();
    },
  });
  patchAuthorship();
}

// Hiding is not confirmed: it moves toward privacy, it can be taken back,
// and it deletes nothing.
function conceal() {
  if (concealing) return;
  concealing = true;
  propose("conceal", {}, {
    landed: function (b) {
      return !b.revealed;
    },
    refused: { forbidden: onlyFacilitator("hide authors") },
    unsure: "Could not confirm that authors were hidden. " + onlyFacilitator("hide authors"),
    settle: function (outcome) {
      if (outcome === "accepted") return;
      concealing = false;
      patchAuthorship();
      if (outcome === "landed" && !revealButton.hidden) revealButton.focus();
    },
  });
  patchAuthorship();
}

revealButton.addEventListener("click", function () {
  arm(true);
});
revealCancel.addEventListener("click", function () {
  arm(false);
});
revealConfirm.addEventListener("click", confirmReveal);
concealButton.addEventListener("click", conceal);

