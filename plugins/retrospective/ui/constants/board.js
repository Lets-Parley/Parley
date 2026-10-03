import { bag } from "../utils/bag.js";
import { GLYPH } from "../assets/glyphs.js";

// A sticker's center may be anywhere from ST_PAD_X inside its note's left
// and right edges to ST_PAD_Y outside its top and bottom ones. It is 42px
// across, so it hangs at most 15px over a side, inside the lane's padding,
// and 27px over the top or the bottom, inside the gap between notes.
export const ST_PAD_X = 8;
export const ST_PAD_Y = 4;
export const ST_STEP = 6;
export const PER_NOTE = 12;
export const PER_PERSON = 3;
export const ONLY_PRESSER = "Only the person who placed a sticker, or the facilitator, can move or remove it.";
export const NOT_KNOWN_MINE = "You can move a sticker you placed in this visit. Open an older one of yours to remove it.";
export const ONLY_AUTHOR_EDITS = "Only the person who wrote a note can edit it.";
export const ONLY_AUTHOR = "Only the person who wrote a note, or the facilitator, can delete it.";
export const NOTE_GONE = "That note is no longer on the board.";
// The board answers "conflict" for a limit reached and for a store that is
// full, and the code does not say which.
export const OR_STORE = " If that is not it, this organization's storage for the plugin is full: delete notes or actions, or ask an admin.";
export const STAMP_CAPS = "That sticker was not placed. A note holds twelve stickers, three per person." + OR_STORE;

// A lane is told apart by its glyph and its title; the hue only agrees.
export const LANES = bag({
  "went-well": { hue: "go", glyph: GLYPH.wentWell, prompt: "What made the sprint better?", empty: "No wins written down yet." },
  "to-improve": { hue: "brass", glyph: GLYPH.toImprove, prompt: "What slowed us down?", empty: "Nothing flagged yet." },
  puzzles: { hue: "settled", glyph: GLYPH.puzzles, prompt: "What are we still unsure about?", empty: "No open questions yet." },
});
export const OTHER_LANE = { hue: "accent", glyph: GLYPH.other, prompt: "What belongs here?", empty: "No notes yet." };

// The stage is the facilitator's to set. It changes what the board puts in
// front of people and refuses nothing: a late note or vote is still taken.
export const STEPS = ["Write", "Group", "Vote", "Decide"];
export const HINTS = [
  "Write what went well, what to improve and what puzzles you. The three dots on a note open its menu: edit it, add a sticker, start an action, move it.",
  "Drag a note onto another to group them, or select several and group them. Drag the important ones to the top.",
  "Vote each note up or down. One vote per person per note; press your thumb again to take it back. The tag on a note's corner is its ups less its downs.",
  "Agree on what to change and who owns it. Start an action from any note.",
];
export const PRESETS = [1, 3, 5, 10];
export const MINUTE = 60000;

// What the answer to a refused action means, in words. The host sends a code
// from this list and nothing else, and the board itself answers with four of
// them (board.js), so each action also brings its own words for those.
export const REFUSALS = bag({
  forbidden: "You are not allowed to do that in this room.",
  invalid: "The server did not accept that as written.",
  "not-found": "That is no longer on the board. If nothing works, reload the page.",
  conflict: "The board could not take that. The room has ended, or this organization's storage for the plugin is full: delete notes or actions, or ask an admin.",
  "rate-limited": "Too many changes at once. Wait a moment, then try again.",
  ungranted: "This plugin is not allowed to change the room. An org admin can check its grants.",
  unreachable: "Could not reach the server. Check your connection, then try again.",
  failed: "The server could not do that. Try again.",
});

export const NOTE_LIMIT = 500;
export const TITLE_LIMIT = 80;
export const OWNER_LIMIT = 64;
export const FORMER = "Former participant";
// A host that reports results answers at once. An older one answers nothing,
// so an action that has not shown up in the state after this long is called
// unconfirmed. A change normally lands in a fifth of a second; three seconds
// is long enough that a slow connection rarely trips it and short enough
// that nobody is left wondering. A late arrival takes the message back.
export const WAIT_MS = 3000;
export const LATE_MS = 60000;
export const TOAST_MS = 6000;

