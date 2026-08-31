/**
 * Neutralize bidi formatting controls in a user-supplied display name.
 *
 * Overrides and embeddings (U+202A–U+202E, U+2066–U+2069) are valid UTF-8 and
 * survive storage, but a name carrying U+202E can visually reverse or mask the
 * text around it in a shared roster. Legitimate RTL script (Arabic, Hebrew) is
 * left alone — only the formatting controls go.
 */
const BIDI_FORMAT =
  /[\u202A-\u202E\u2066-\u2069]/g;

export function safeDisplayName(name: string): string {
  return name.replace(BIDI_FORMAT, "");
}
