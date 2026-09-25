/**
 * Bravo over Zulu: "well done", hoisted once beside a kudo addressed to you.
 * One fixed mark per kudo — never a tally of flags earned. Decorative: the
 * word "you" beside it carries the meaning for a screen reader.
 */
export function KudoFlags() {
  return (
    <svg
      data-testid="kudo-flags"
      aria-hidden="true"
      viewBox="0 0 8 13"
      width="8"
      height="13"
      className="mt-0.5 shrink-0"
      stroke="var(--color-flag-edge)"
      strokeWidth="0.5"
      strokeLinejoin="round"
    >
      <path d="M0 0H8L5.5 3L8 6H0Z" fill="var(--color-flag-red)" />
      <path d="M0 7H8L4 10Z" fill="var(--color-flag-yellow)" />
      <path d="M0 7V13L4 10Z" fill="var(--color-flag-black)" />
      <path d="M0 13H8L4 10Z" fill="var(--color-flag-red)" />
      <path d="M8 7V13L4 10Z" fill="var(--color-flag-blue)" />
    </svg>
  );
}
