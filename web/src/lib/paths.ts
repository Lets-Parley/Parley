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
