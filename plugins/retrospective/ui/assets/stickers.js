import { bag } from "../utils/bag.js";

// A sticker is told apart by its shape and its name; the color only agrees.
// There are seven meanings, each printed twice: as a vinyl sticker and as
// pixel art. The plain ids are the vinyl set, which is what a board stored
// before the pixel set existed already holds, and `p-` is the pixel set.
// The actions and the state keep the name they shipped with, "stamp".
export const MEANINGS = [
  ["me-too", "Me too"],
  ["thanks", "Thank you"],
  ["idea", "Great idea"],
  ["quick-win", "Quick win"],
  ["chat", "Needs a chat"],
  ["blocker", "Blocker"],
  ["laugh", "Made me laugh"],
];
// Vinyl, in a 40-unit box: the outline, which is drawn four times (edge,
// paper, ink line, color), then pairs of a detail's type and its path.
// s is an ink stroke, f an ink fill, p a paper stroke, q a paper fill.
export const VINYL = bag({
  "me-too": ["M14 12h12a8 8 0 0 1 0 16H14a8 8 0 0 1 0-16z", "q", "M11.5 18.6h3.2v-3.2h2.8v3.2h3.2v2.8h-3.2v3.2h-2.8v-3.2h-3.2zM25.2 14.6h3v10.8h-3v-7.2l-2 1.2-1.4-2.4z"],
  thanks: ["M20 33.5C9 26 6.5 19.8 6.5 15.1C6.5 10.6 9.9 7.5 13.7 7.5C16.4 7.5 18.7 9 20 11.4C21.3 9 23.6 7.5 26.3 7.5C30.1 7.5 33.5 10.6 33.5 15.1C33.5 19.8 31 26 20 33.5Z", "p", "M11.2 15.4a3.4 3.4 0 0 1 2.9-3.6"],
  idea: ["M20 5.5a10.5 10.5 0 0 0-6.2 19c1.2 1 1.7 2 1.7 3.5v3.5a3 3 0 0 0 3 3h3a3 3 0 0 0 3-3V28c0-1.5.5-2.5 1.7-3.5A10.5 10.5 0 0 0 20 5.5z", "f", "M20 9.8l1.5 4.2 4.2 1.5-4.2 1.5-1.5 4.2-1.5-4.2-4.2-1.5 4.2-1.5z", "s", "M16.6 28h6.8M17.2 31.2h5.6"],
  "quick-win": ["M23.5 6L9.5 22.2h8l-3.2 11.8L30 17.8h-8.2z", "p", "M20.6 11.6l-5.4 6.4"],
  chat: ["M10.5 7.5h19a4.5 4.5 0 0 1 4.5 4.5v10.5a4.5 4.5 0 0 1-4.5 4.5H19.5l-7.5 7V27h-1.5a4.5 4.5 0 0 1-4.5-4.5V12a4.5 4.5 0 0 1 4.5-4.5z", "q", "M11.4 17.3a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM18 17.3a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM24.6 17.3a2 2 0 1 0 4 0a2 2 0 1 0-4 0z"],
  blocker: ["M14.2 6h11.6l8.2 8.2v11.6L25.8 34H14.2L6 25.8V14.2z", "q", "M11.5 17.2h17v5.6h-17z"],
  laugh: ["M20 6a14 14 0 1 0 0 28a14 14 0 0 0 0-28z", "s", "M11.8 17.2l3.2-2.8 3.2 2.8M21.8 17.2l3.2-2.8 3.2 2.8", "f", "M12.4 21.2h15.2a7.6 7.6 0 0 1-15.2 0z"],
});
// Pixel: rows of at most eleven cells, top to bottom. # is the sticker's
// color, o ink, + paper, and a dot is empty; dots at the end of a row are
// left off.
export const PIXEL = bag({
  "me-too": ".#########/#######+###/##+###++###/#+++###+###/##+####+###/######+++##/.#########",
  thanks: ".###...###/#####.#####/#++########/#+#########/###########/.#########/..#######/...#####/....###/.....#",
  idea: "..#####/.#######/##++#####/##+######/#########/.#######/..#####/..#####/..ooooo/..#####/...ooo",
  "quick-win": ".....###/....###/...###/..###/.########/########/....###/...###/..###/.###/###",
  chat: ".#########/###########/###########/##++#++#++#/##++#++#++#/###########/.#########/..####/..###/..##/..#",
  blocker: "...#####/..#######/.#########/###########/#+++++++++#/#+++++++++#/#+++++++++#/###########/.#########/..#######/...#####",
  laugh: ".#########/###########/###o###o###/##o#o#o#o##/###########/#ooooooooo#/#o+++++++o#/##ooooooo##/###ooooo###/.#########",
});
// Where the print starts from as it settles after landing, by meaning.
export const SETTLE = bag({
  "me-too": "translateY(-6px) scale(1.12)",
  thanks: "scale(1.24)",
  idea: "scale(1.16) rotate(10deg)",
  "quick-win": "translate(-4px,3px) rotate(-13deg)",
  chat: "scale(.84,1.16)",
  blocker: "scale(1.1,.86)",
  laugh: "rotate(15deg) scale(1.08)",
});
// Each color takes its hue from a host token and fixes how light and how
// strong it is, so a sticker reads the same on a light note and a dark one.
export const INKS = [
  ["me-too", "settled", ".6 .13 h"],
  ["thanks", "stop", ".72 .14 calc(h - 14)"],
  ["idea", "brass", ".87 .15 calc(h + 8)"],
  ["quick-win", "go", ".68 .13 h"],
  ["chat", "accent", ".64 .11 h"],
  ["blocker", "stop", ".57 .19 h"],
  ["laugh", "brass", ".8 .16 calc(h - 22)"],
];
export const STAMPS = bag();
MEANINGS.forEach(function (m) {
  STAMPS[m[0]] = { meaning: m[0], label: m[1], set: "vinyl" };
  STAMPS["p-" + m[0]] = { meaning: m[0], label: m[1], set: "pixel" };
});
export const UNKNOWN_KIND = "?";
STAMPS[UNKNOWN_KIND] = { meaning: "other", label: "Sticker", set: "vinyl" };
VINYL.other = ["M20 7a13 13 0 1 0 0 26a13 13 0 0 0 0-26z"];
