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
};

/**
 * The glyph for an id, or null for an id this build does not know — which is
 * the same code path as an unset avatar, so an id from a newer client
 * degrades to initials rather than to a blank chip.
 */
export function avatarIcon(id: string | undefined): ReactNode | null {
  return id && Object.hasOwn(paths, id) ? paths[id] : null;
}
