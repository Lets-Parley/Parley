/**
 * The whole invite, as one link.
 *
 * The passcode rides in the fragment, so one click seats them with nothing to
 * read off a second line and retype. A fragment never reaches the server or a
 * Referer header, so it stays out of access logs — see takeInviteCode in
 * SpacePage for the other end of that trip. An open space has no code, so the
 * link is the whole invite already.
 */
export function inviteLink(slug: string, passcode: string): string {
  const link = `${window.location.origin}/s/${slug}`;
  return passcode ? `${link}#c=${encodeURIComponent(passcode)}` : link;
}
