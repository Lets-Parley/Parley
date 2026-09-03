/**
 * Every URL that names a space, in one place.
 *
 * A slug is unique inside an org rather than across the instance, so it is no
 * longer an address on its own: both halves have to travel together. These
 * exist so that stays true by construction — eight template literals scattered
 * across pages would drift the moment one of them was missed, and the one that
 * was missed would 404.
 */

/** The SPA route for a space. */
export function spacePath(org: string, slug: string): string {
  return `/o/${org}/s/${slug}`;
}

/** The SPA route for a space's settings. */
export function spaceSettingsPath(org: string, slug: string): string {
  return `${spacePath(org, slug)}/settings`;
}

/** The API base for one space. Sub-resources append to it. */
export function spaceApi(org: string, slug: string): string {
  return `/api/orgs/${org}/spaces/${slug}`;
}

/** The API for a space's saved decks. One deck appends its id. */
export function decksApi(org: string, slug: string): string {
  return `${spaceApi(org, slug)}/decks`;
}

/** The SPA route for an org's directory of spaces. */
export function orgPath(org: string): string {
  return `/o/${org}`;
}

/**
 * The API for the spaces in one org the caller may see.
 *
 * The answer is one page. `after` is the opaque cursor the previous page
 * returned as `next`, and it is passed straight back rather than interpreted —
 * a client that reads it is a client that will break when the server's paging
 * key changes.
 */
export function orgSpacesApi(org: string, after = ""): string {
  const base = `/api/orgs/${org}/spaces`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

/** The API for a space's kudos. Withdrawing one appends its id. */
export function kudosApi(org: string, slug: string): string {
  return `${spaceApi(org, slug)}/kudos`;
}

/** The SPA route for the operator's plugin administration surface. */
export function pluginsPath(org: string): string {
  return `/o/${org}/admin/plugins`;
}

/** The API for plugin administration in one org. Sub-resources append to it. */
export function pluginsApi(org: string): string {
  return `/api/orgs/${org}/admin/plugins`;
}
