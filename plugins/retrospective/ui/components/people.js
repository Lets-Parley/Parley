import { FORMER } from "../constants/board.js";
import { el, setText } from "../utils/dom.js";
import { rows, session, words } from "../bridge/state.js";

// ----------------------------------------------------------------- people

export function personById(userId) {
  const person = rows(session && session.participants).filter(function (p) {
    return p.userId === userId;
  })[0];
  return person && words(person.name).trim() ? person : null;
}

// An owner is a participant's name, or whatever somebody typed. A board
// from an older version may still hold a participant's id.
export function ownerOf(owner) {
  const typed = owner.trim().toLowerCase();
  const person =
    personById(owner) ||
    rows(session && session.participants).filter(function (p) {
      return typed && words(p.name).trim().toLowerCase() === typed;
    })[0];
  if (person) return person;
  const looksLikeId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(owner);
  return { name: looksLikeId || !owner ? FORMER : owner };
}

export function facilitator() {
  return personById(session && session.facilitatorId);
}

// Who is looking. A host older than `selfId` leaves it out, and a newer one
// may not know: both mean "unknown", never "nobody".
export function viewerRole() {
  const self = session && session.selfId;
  if (typeof self !== "string" || !self) return "unknown";
  return self === session.facilitatorId ? "facilitator" : "participant";
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function buildPerson() {
  const disc = el("span", { class: "disc", "aria-hidden": "true" });
  const name = el("span", { class: "person-name", dir: "auto" });
  return { el: el("span", { class: "person" }, [disc, name]), disc: disc, name: name };
}

// The disc is the host's avatar arc, a step darker: at this size the
// initials are the only thing in it, so they are held to 4.5:1.
export function showPerson(person, who) {
  const name = who ? words(who.name).trim() : FORMER;
  setText(person.name, name);
  setText(person.disc, initials(name));
  if (who && typeof who.avatarHue === "number") {
    const arc = 185 + ((((who.avatarHue % 360) + 360) % 360) / 360) * 105;
    person.disc.style.background = "oklch(0.44 0.09 " + arc + ")";
  }
}

