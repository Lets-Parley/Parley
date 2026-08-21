/**
 * The nautical crew: eight flat silhouettes a person can wear instead of their
 * initials.
 *
 * They are drawn in `currentColor` only — the disc underneath keeps supplying
 * the identity hue, so a glyph never invents a second colour of its own.
 *
 * The ids are the wire format. The server validates their shape and nothing
 * else, so this map is the only place that knows what an id means; an id it
 * does not hold is not an error, it just falls back to initials.
 */
import type { ReactNode } from "react";

/** Path data only — <Avatar> supplies the <svg> wrapper and its sizing. */
const paths: Record<string, ReactNode> = {
  parrot: (
    <path d="M15 2a5 5 0 0 0-4.9 4H6.5a1 1 0 0 0-.6 1.8L9.1 10A5 5 0 0 0 13 12.9V15c0 2.7 1.5 5.1 3.8 6.3l.2.1V22h3v-8.5c0-2-.8-3.9-2.1-5.3A5 5 0 0 0 15 2zm1.4 2.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z" />
  ),
  kraken: (
    <path d="M12 2C8.1 2 5 5.1 5 9c0 1.5.5 2.9 1.3 4-.6 1.3-1.7 2.4-3 3-.5.2-.7.8-.5 1.3s.8.7 1.3.5c1.3-.6 2.4-1.4 3.2-2.5.4.3.9.6 1.4.8-.3 1.6-1.2 3-2.5 4-.4.3-.5 1-.2 1.4s1 .5 1.4.2c1.5-1.2 2.6-2.8 3.1-4.6h.5v3.6a1 1 0 0 0 2 0v-3.6h.5c.5 1.8 1.6 3.4 3.1 4.6.4.3 1.1.2 1.4-.2s.2-1.1-.2-1.4c-1.3-1-2.2-2.4-2.5-4 .5-.2 1-.5 1.4-.8.8 1.1 1.9 1.9 3.2 2.5.5.2 1.1 0 1.3-.5s0-1.1-.5-1.3c-1.3-.6-2.4-1.7-3-3 .8-1.1 1.3-2.5 1.3-4 0-3.9-3.1-7-7-7zm-2.5 6a1.2 1.2 0 1 1 0 2.5 1.2 1.2 0 0 1 0-2.5zm5 0a1.2 1.2 0 1 1 0 2.5 1.2 1.2 0 0 1 0-2.5z" />
  ),
  anchor: (
    <path d="M12 2a3 3 0 0 0-1 5.8V10H8.5a1 1 0 0 0 0 2H11v7.9a8 8 0 0 1-5.8-6.2l1.3.6a1 1 0 0 0 .8-1.8l-3.5-1.6a1 1 0 0 0-1.4 1c0 5.4 4.3 10.1 9.6 10.1s9.6-4.7 9.6-10.1a1 1 0 0 0-1.4-1l-3.5 1.6a1 1 0 0 0 .8 1.8l1.3-.6a8 8 0 0 1-5.8 6.2V12h2.5a1 1 0 0 0 0-2H13V7.8A3 3 0 0 0 12 2zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
  ),
  lighthouse: (
    <path d="M12 2a3 3 0 0 0-3 3v1h6V5a3 3 0 0 0-3-3zM8.6 8l-.4 2h7.6l-.4-2H8.6zm-.8 4-1.6 8.2A1 1 0 0 0 7.2 22h9.6a1 1 0 0 0 1-1.2L16.2 12H7.8zM3.6 4.2a1 1 0 0 0-.9 1.7l2 1.4a1 1 0 0 0 1.2-1.6l-2-1.4a1 1 0 0 0-.3-.1zm16.8 0a1 1 0 0 0-.3.1l-2 1.4a1 1 0 0 0 1.2 1.6l2-1.4a1 1 0 0 0-.9-1.7z" />
  ),
  wheel: (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 2.1v3.2a5 5 0 0 0-1.4.6L7 5.3A8 8 0 0 1 11 4.1zm2 0a8 8 0 0 1 4 1.2l-2.6 2.6a5 5 0 0 0-1.4-.6V4.1zM5.3 7 8 9.6a5 5 0 0 0-.6 1.4H4.1A8 8 0 0 1 5.3 7zm13.4 0a8 8 0 0 1 1.2 4h-3.2a5 5 0 0 0-.6-1.4L18.7 7zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM4.1 13h3.2a5 5 0 0 0 .6 1.4L5.3 17a8 8 0 0 1-1.2-4zm12.6 0h3.2a8 8 0 0 1-1.2 4l-2.6-2.6a5 5 0 0 0 .6-1.4zM9.6 16a5 5 0 0 0 1.4.6v3.2A8 8 0 0 1 7 18.7L9.6 16zm4.8 0 2.6 2.7a8 8 0 0 1-4 1.2v-3.2a5 5 0 0 0 1.4-.6z" />
  ),
  gull: (
    <path d="M2 15c3 0 5-8.5 8-5.5 1 1 1.5 1.5 2 1.5s1-.5 2-1.5c3-3 5 5.5 8 5.5-3-1-4.6-6.6-7-4.2-1 1-2 1.7-3 1.7s-2-.7-3-1.7C6.6 8.4 5 14 2 15z" />
  ),
  buoy: (
    <path d="M12 2a1 1 0 0 0-.9.6L6.4 13.2a1 1 0 0 0 .9 1.4h9.4a1 1 0 0 0 .9-1.4L12.9 2.6A1 1 0 0 0 12 2zm-4 14.6a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2H8zm-1.6 4a1 1 0 0 0 0 2h11.2a1 1 0 0 0 0-2H6.4z" />
  ),
  crate: (
    <path d="M3.6 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16.8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H3.6zm3 3h1.7L17 15.6V19h-1.7L6.6 9.4V6zm4.5 0h1.8v12h-1.8V6zm4.6 0H19v3.4L10.3 19H8.6v-3.4L15.7 6z" />
  ),
};

/**
 * The dev pack: a second sheet for the people who would rather be a rubber
 * duck than a parrot.
 *
 * A separate map rather than more entries in the one above, so the picker can
 * offer the two sheets under their own headings without slicing a flat list at
 * an index. It is a second static map and nothing more — avatar packs as a
 * plugin point are #23's job, not this one's.
 *
 * The set is short on purpose. "Merge conflict" and "500" were drawn and cut:
 * at the 17px the `sm` chip gives a glyph, the first reads as an ambiguous
 * fork and the second as a grey smudge. A muddy silhouette is worse than an
 * absent one.
 */
const devPaths: Record<string, ReactNode> = {
  "rubber-duck": (
    <g>
      <circle cx="9" cy="6.8" r="4.8" />
      <path d="M5.2 4.6.6 6.8l4.6 2.2z" />
      <path d="M12 10.4c4.4 0 8 2.4 8 5.4s-3.6 5.6-8 5.6c-3.7 0-6.9-1.8-7.8-4.2H8c2.1 0 3.6-1.2 4-2.8z" />
    </g>
  ),
  coffee: (
    <g>
      <path d="M4 7h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V7z" />
      <path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17v-2h1.4a.5.5 0 0 0 0-1H17z" />
      <rect x="2" y="19.4" width="17" height="2.2" rx="1.1" />
    </g>
  ),
  // The prompt and the cursor are holes punched in the window, so the whole
  // glyph stays one colour and still reads as a terminal at chip size.
  terminal: (
    <path
      fillRule="evenodd"
      d="M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3.2 4.6L5 9.1l3.2 2.9L5 14.9l1.2 1.5 4.9-4.4-4.9-4.4zM12.8 16.4H18v-2.2h-5.2z"
    />
  ),
  pager: (
    <path
      fillRule="evenodd"
      d="M6.5 2h11a2.5 2.5 0 0 1 2.5 2.5v15a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM7.5 5h9v6h-9zm0 8.5H11v3H7.5zm5.5 0h3.5v3H13z"
    />
  ),
};

export const avatarDevIconIds = Object.keys(devPaths);

export const avatarIconIds = Object.keys(paths);

/** Human wording for the picker and for the chip's accessible name. */
export const avatarIconLabels: Record<string, string> = {
  parrot: "Parrot",
  kraken: "Kraken",
  anchor: "Anchor",
  lighthouse: "Lighthouse",
  wheel: "Ship's wheel",
  gull: "Gull",
  buoy: "Buoy",
  crate: "Cargo crate",
  "rubber-duck": "Rubber duck",
  coffee: "Coffee",
  terminal: "Terminal",
  pager: "Pager",
};

/**
 * The glyph for an id, or null for an id this build does not know — which is
 * the same code path as an unset avatar, so an id from a newer client
 * degrades to initials rather than to a blank chip.
 */
export function avatarIcon(id: string | undefined): ReactNode | null {
  if (!id) return null;
  // `hasOwn` before either index, or an id like `constructor` or `__proto__` —
  // all of which pass the server's shape check — resolves to an inherited
  // prototype value and lands in the tree as an invalid React child.
  if (Object.hasOwn(paths, id)) return paths[id];
  if (Object.hasOwn(devPaths, id)) return devPaths[id];
  return null;
}
