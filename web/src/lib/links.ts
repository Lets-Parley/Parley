import type { Me } from "./api";

/**
 * Signed links: a capability to take part in ONE room, held by whoever holds
 * the URL. Everything here is written around that fact.
 *
 * The token rides in the URL fragment, never the query. A fragment is never
 * sent to the server and never reaches a Referer header, so the credential
 * stays out of access logs and out of whatever the next site's analytics see.
 */

/** One live link on a room, as the list route reports it. Never a token. */
export type SessionLink = {
  id: string;
  sessionId: string;
  createdBy: string;
  expiresAt: string;
  revokedAt: string | null;
  redemptions: number;
  createdAt: string;
};

/** The mint response — the only time the plain token is ever readable. */
export type MintedLink = { id: string; token: string; expiresAt: string };

/** What redeeming a token buys: an identity bound to one room, until expiry. */
export type Redemption = { sessionId: string; expiresAt: string; me: Me };

/** How many times one link may be redeemed. A server constant, mirrored for display. */
export const LINK_REDEMPTION_CAP = 25;

/**
 * True for an ordinary signed-in account; false for a link guest or nobody.
 *
 * `GET /api/me` now succeeds for a link guest too, so a truthy response alone
 * no longer means "full account" — `linkSessionId` is what tells them apart.
 * Anything scoped to an account across spaces (the space list, creating a
 * space) needs this, not a bare `!!me.data` check.
 */
export function isFullAccount(me: Me | null | undefined): boolean {
  return !!me && !me.linkSessionId;
}

/** The shareable URL for a freshly minted token. */
export function linkUrl(token: string): string {
  return `${window.location.origin}/link#t=${encodeURIComponent(token)}`;
}

/** The token from the current fragment, or "" when the URL carries none. */
export function readLinkToken(): string {
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "";
}

/**
 * Wipe the fragment, leaving the rest of the address bar alone. The token must
 * not survive into a bookmark, the back button or a screenshot, so this runs on
 * arrival rather than after the redemption: the prompt can sit on screen for a
 * minute, and the credential should not sit in the address bar while it does.
 */
export function clearLinkToken() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * The link identity, kept so a reload of the room does not strand the guest.
 *
 * The cookie is the credential; this is only the name and hue to render with,
 * saved so the room paints without waiting on a round trip. It is a cache, not
 * the source of truth: when it is missing, GET /api/me re-derives the same
 * identity from the cookie. It is bound to one session id and expires with the
 * link.
 */
export type LinkGuest = { sessionId: string; me: Me; expiresAt: string };

const GUEST_KEY = "parley.link-guest";

export function rememberLinkGuest(guest: LinkGuest) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    // Private mode, or storage full. The room still works for this navigation;
    // only a reload is lost, and that is not worth failing the redemption over.
  }
}

/** The stored identity, but only if it belongs to this room and still lives. */
export function linkGuestFor(sessionId: string): LinkGuest | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(GUEST_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let guest: LinkGuest;
  try {
    guest = JSON.parse(raw) as LinkGuest;
  } catch {
    return null;
  }
  if (guest?.sessionId !== sessionId || !guest.me?.id) return null;
  if (Date.parse(guest.expiresAt) <= Date.now()) return null;
  return guest;
}
