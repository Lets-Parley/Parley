import { bag } from "./bag.js";

export function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// A note's words, as a name for it: cut at the end of a word when long.
export function short(text) {
  if (text.length <= 80) return text;
  // Whole characters only: an emoji is never cut in half.
  const parts = graphemes(text);
  let cut = "";
  let i = 0;
  for (; i < parts.length && cut.length + parts[i].length <= 77; i++) cut += parts[i];
  const at = parts[i] === " " ? cut.length : cut.lastIndexOf(" ");
  return (at > 40 ? cut.slice(0, at) : cut) + "\u2026";
}

// Text as the characters a reader sees: a family emoji is one of them.
export function graphemes(text) {
  return typeof Intl !== "undefined" && Intl.Segmenter
    ? Array.from(new Intl.Segmenter().segment(text), function (part) {
        return part.segment;
      })
    : Array.from(text);
}

export function idsOf(rows) {
  const ids = bag();
  rows.forEach(function (row) {
    ids[row.id] = true;
  });
  return ids;
}

