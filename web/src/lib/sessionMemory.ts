/**
 * Remembers that this browser held an open-mode seat, so a later 401 can
 * surface as "session ended" instead of the first-visit name gate.
 *
 * The HttpOnly session cookie is invisible to script: when the browser drops
 * it at Max-Age, GET /api/me looks identical to a first visit. This name is
 * the only client-side signal that the stranger path would orphan a prior
 * identity. Cleared on an intentional sign-out; refreshed whenever /api/me
 * succeeds for an ordinary (non-link) account.
 */
const LAST_NAME_KEY = "parley:last-name";
const ENDED_KEY = "parley:session-ended";

export function rememberOpenSession(name: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
    localStorage.removeItem(ENDED_KEY);
  } catch {
    // Private mode / quota — the expired-session UX degrades to first visit.
  }
}

/** Server said the cookie was present but no longer resolves. */
export function noteSessionEnded(): void {
  try {
    localStorage.setItem(ENDED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearSessionMemory(): void {
  try {
    localStorage.removeItem(LAST_NAME_KEY);
    localStorage.removeItem(ENDED_KEY);
  } catch {
    /* ignore */
  }
}

export function openSessionLapsed(): { lapsed: boolean; lastName: string } {
  try {
    const lastName = localStorage.getItem(LAST_NAME_KEY) ?? "";
    const ended = localStorage.getItem(ENDED_KEY) === "1";
    return { lapsed: ended || lastName !== "", lastName };
  } catch {
    return { lapsed: false, lastName: "" };
  }
}
