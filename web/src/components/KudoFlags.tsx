/**
 * Bravo over Zulu: "well done", hoisted once beside a kudo addressed to you.
 * One fixed mark per kudo — never a tally of flags earned. Decorative: the
 * word "you" beside it carries the meaning for a screen reader.
 *
 * Drawn at 12×22 so the two flags read as flags rather than one red smudge:
 * B is a red swallowtail, Z a square of four triangles meeting at the centre
 * (yellow top, black hoist, red bottom, blue fly), both on a thin halyard.
 */
export function KudoFlags() {
  return (
    <svg
      data-testid="kudo-flags"
      aria-hidden="true"
      viewBox="0 0 12 22"
      width="12"
      height="22"
      className="mt-0.5 shrink-0 text-ink-faint"
    >
      <path d="M0.5 0V22" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" />
      <g stroke="var(--color-flag-edge)" strokeWidth="0.5" strokeLinejoin="round">
        <path d="M1 1H12L8.5 5.5L12 10H1Z" fill="var(--color-flag-red)" />
        <path d="M1 12H12L6.5 16.5Z" fill="var(--color-flag-yellow)" />
        <path d="M1 12V21L6.5 16.5Z" fill="var(--color-flag-black)" />
        <path d="M1 21H12L6.5 16.5Z" fill="var(--color-flag-red)" />
        <path d="M12 12V21L6.5 16.5Z" fill="var(--color-flag-blue)" />
      </g>
    </svg>
  );
}
