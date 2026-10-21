import { parley } from "./host.js";
import { bag } from "../utils/bag.js";
import {
  HINTS, LATE_MS, REFUSALS, STEPS, WAIT_MS,
} from "../constants/board.js";
import { idsOf, plural, short } from "../utils/text.js";
import { columnTitle, ui } from "./state.js";
import { facilitator, ownerOf, viewerRole } from "../components/people.js";
import { hideToast, notify, retract } from "../components/notices.js";
import { clockFace } from "../components/timer.js";
import { saidKind, topOf } from "../features/sticker-layout.js";

// ---------------------------------------------------------------- actions

// Every change the board makes goes through propose(). An action has three
// possible ends, and `settle` hears each of them:
//
//   "landed"   the state now shows it
//   "refused"  the host said no, and said why
//   "unsure"   nobody said anything in time
//
// A host that reports results answers through the promise `parley.act`
// returns. An older host returns nothing, and so does a newer one that
// cannot tell ("unknown"); then the only evidence is the state itself, and
// the board waits for it. "unsure" is not the end: if the change turns up
// late, the message is taken back and `settle` hears "landed" after all.
let watching = [];

export function propose(action, payload, how) {
  const item = { landed: how.landed, settle: how.settle || function () {}, unsure: how.unsure, refused: bag(how.refused), yesIsEnough: how.yesIsEnough, says: how.says };
  const unsent = function () {
    refuse(item, "That could not be sent. Try again.");
  };
  hideToast();
  watching.push(item);
  item.asked = false;
  item.timer = setTimeout(function () {
    expire(item);
  }, WAIT_MS);
  // The bridge throws for a message it will not carry, and a promise can
  // reject. Either way the action never left, and the board says so now.
  try {
    const answer = parley.act(action, payload);
    if (answer && typeof answer.then === "function") {
      item.asked = true;
      answer.then(function (result) {
        hear(item, result);
      }, unsent);
    }
  } catch (err) {
    unsent();
  }
  return item;
}

// The host's answer. It is heard for as long as the action is watched, so
// one that comes after the wait still counts: a late yes is a yes, and a
// late no replaces "could not confirm" with the reason.
function hear(item, result) {
  if (!result) return;
  if (watching.indexOf(item) === -1) {
    // The state showed the change before the answer came. The yes still
    // says something the state cannot: that the change was this viewer's.
    if (item.shown && result.ok === true) {
      item.accepted = true;
      item.settle("accepted");
    }
    return;
  }
  if (result.ok === true) {
    if (item.yesIsEnough) retract(item.notice);
    item.accepted = true;
    item.settle("accepted");
    return;
  }
  if (result.reason === "unknown") return;
  item.reason = result.reason;
  refuse(item, item.refused[result.reason] || REFUSALS[result.reason] || REFUSALS.failed);
}

function refuse(item, message) {
  if (watching.indexOf(item) === -1) return;
  forget(item);
  item.settle("refused");
  // An action that says its own refusals where they happened does so;
  // everything else is said in the toast.
  if (item.says) item.says(message, item.reason);
  else notify(message);
}

// The wait is over and the state does not show the change. That is
// "unsure" whatever the host answered: a host that cannot say no answers
// yes to a change the board declined, so a yes is believed only once the
// state agrees. Whatever was drawn ahead of the state is taken back by
// `settle`. The action stays watched for a while longer, and if the change
// does turn up, the message is taken back and it has landed after all.
function expire(item) {
  if (!(item.accepted && item.yesIsEnough)) {
    item.settle("unsure");
    item.notice = notify(item.unsure);
  }
  item.timer = setTimeout(function () {
    forget(item);
  }, LATE_MS);
}

export function forget(item) {
  clearTimeout(item.timer);
  watching = watching.filter(function (other) {
    return other !== item;
  });
}

export function settleLanded() {
  watching.slice().forEach(function (item) {
    if (!item.landed(ui.board)) return;
    item.shown = true;
    forget(item);
    retract(item.notice);
    item.settle("landed");
  });
}

// What changed between two boards, in words, for the live region.
export function describeChanges(before, after) {
  const said = [];
  const had = idsOf(before.cards);
  const fresh = after.cards.filter(function (c) {
    return !had[c.id];
  });
  if (fresh.length === 1) said.push("New note in " + columnTitle(fresh[0].columnId) + ".");
  if (fresh.length > 1) said.push(fresh.length + " new notes.");

  const kept = idsOf(after.cards);
  const gone = before.cards.filter(function (c) {
    return !kept[c.id];
  });
  if (gone.length === 1) said.push("A note was removed from " + columnTitle(gone[0].columnId) + ".");
  if (gone.length > 1) said.push(gone.length + " notes were removed.");

  const reworded = after.cards.filter(function (c) {
    const old = before.cards.filter(function (o) {
      return o.id === c.id;
    })[0];
    return old && old.text !== c.text;
  });
  if (reworded.length === 1) said.push("A note in " + columnTitle(reworded[0].columnId) + " was edited.");
  if (reworded.length > 1) said.push(reworded.length + " notes were edited.");

  const hadGroups = idsOf(before.groups);
  after.groups.forEach(function (g) {
    if (!hadGroups[g.id]) said.push("Notes grouped as " + g.title + " in " + columnTitle(g.columnId) + ".");
  });

  // Votes are not read out as they arrive: in the Vote stage that would be
  // the whole room talking at once. Each thumb carries its counts in its
  // name, and a person hears the outcome of their own vote.

  if (after.revealed && !before.revealed) said.push("Authors are now visible to everyone.");
  if (!after.revealed && before.revealed) said.push("Authors are hidden again.");

  if (after.stage !== before.stage) {
    const who = facilitator();
    const back = after.stage < before.stage;
    const where = (back ? "back to " : "to ") + STEPS[after.stage] + ".";
    if (viewerRole() === "facilitator") said.push("Moved " + where);
    else said.push((who ? who.name : "The facilitator") + " moved the room " + where + (back ? "" : " " + HINTS[after.stage]));
  }

  after.columns.forEach(function (col) {
    const sequence = function (b, other) {
      const shared = idsOf(other.cards);
      return b.cards
        .filter(function (c) {
          return c.columnId === col.id && shared[c.id];
        })
        .map(function (c) {
          return c.id;
        })
        .join(" ");
    };
    if (sequence(before, after) !== sequence(after, before)) said.push("Notes were reordered in " + col.title + ".");
  });

  // A sticker is announced by what it is and how many there are, never by who.
  const was = bag();
  before.stamps.forEach(function (s) {
    was[s.id] = s;
  });
  const hasStamps = idsOf(after.stamps);
  const placed = after.stamps.filter(function (s) {
    return !was[s.id];
  });
  // A sticker that left with its note is not a sticker somebody removed.
  const lifted = before.stamps.filter(function (s) {
    return !hasStamps[s.id] && kept[s.cardId];
  });
  const stickerSaid = function (s, verb) {
    const on = after.cards.filter(function (c) {
      return c.id === s.cardId;
    })[0];
    const count = after.stamps.filter(function (o) {
      return o.cardId === s.cardId;
    }).length;
    // A note that ends its own sentence, or was cut short, is not given a
    // full stop on top of what it ends with.
    const name = short(on ? on.text : "a note").replace(/\.+$/, "");
    return saidKind(s.kind) + " " + verb + ": " + name + (/\u2026$/.test(name) ? " " : ". ") + plural(count, "sticker") + " on that note.";
  };
  const shifted = after.stamps.filter(function (s) {
    return was[s.id] && (was[s.id].x !== s.x || was[s.id].y !== s.y);
  });
  const raised = after.stamps.filter(function (s) {
    return was[s.id] && topOf(after, s.cardId) === s.id && topOf(before, s.cardId) !== s.id;
  });
  if (placed.length === 1 && !lifted.length) said.push(stickerSaid(placed[0], "placed on"));
  else if (lifted.length === 1 && !placed.length) said.push(stickerSaid(lifted[0], "removed from"));
  else if (placed.length + lifted.length || shifted.length > 1) said.push("Stickers changed on the board.");
  else if (shifted.length) said.push(saidKind(shifted[0].kind) + " moved.");
  else if (raised.length) said.push(saidKind(raised[0].kind) + " brought to the front.");

  const a = after.timer;
  const b = before.timer;
  if (a && (!b || a.rev !== b.rev)) {
    if (!b) said.push("Timer started: " + clockFace(a.remaining) + ".");
    else if (a.running !== b.running) said.push(a.running ? "Timer resumed." : "Timer paused at " + clockFace(a.remaining) + ".");
    else if (a.remaining > b.remaining) said.push("Timer now at " + clockFace(a.remaining) + ".");
  }
  if (b && !a && after.stage === before.stage) said.push("Timer cleared.");

  const hadActions = idsOf(before.actionItems);
  after.actionItems.forEach(function (a) {
    if (!hadActions[a.id]) said.push("New action: " + short(a.text) + ".");
  });
  before.actionItems.forEach(function (old) {
    const now = after.actionItems.filter(function (a) {
      return a.id === old.id;
    })[0];
    if (!now) said.push("Action removed: " + short(old.text) + ".");
    else if (now.sourceIds.join() !== old.sourceIds.join()) said.push("The notes behind an action changed: " + short(now.text) + ".");
    if (now && now.owner !== old.owner) said.push((now.owner ? ownerOf(now.owner).name + " now owns: " : "Nobody owns: ") + short(now.text) + ".");
  });
  return said.join(" ");
}

