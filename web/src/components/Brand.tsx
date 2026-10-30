import { useTheme } from "../lib/ui";
import { TOUCH_HIT } from "../lib/breakpoints";
import logoUrl from "../assets/logo.svg";

export function Logo({ size = 14 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className="inline-block shrink-0"
      alt=""
      aria-hidden
    />
  );
}

const NEXT_THEME_WORD = { system: "light", light: "dark", dark: "system" } as const;

/**
 * The theme control, standing on its own so the landing page can mount it too.
 * Three themes are a product commitment, and a visitor who has never opened a
 * space still needs the switch.
 *
 * The palette says its own name. Encoding it in an inset shadow on a 12px dot
 * asked everyone to read a state only its author knew.
 */
export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME_WORD[theme]}.`}
      /* The label is hidden below sm, which left a ~22x30px target — and on
         the landing page this is the only chrome control there is. TOUCH_HIT
         is the repo's own utility for exactly this and this control was the
         lone opt-out. line-strong because a transparent-ish pill's border is
         the only thing identifying it (WCAG 2.2 AA 1.4.11). */
      className={`${TOUCH_HIT} inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-felt-deep px-3 hover:bg-surface-hi`}
    >
      <svg
        aria-hidden
        data-icon={theme}
        viewBox="0 0 16 16"
        className="h-4 w-4 shrink-0 text-ink-soft"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        {theme === "light" ? (
          <>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
          </>
        ) : theme === "dark" ? (
          <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
        ) : (
          <>
            <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" />
            <path d="M5.5 14h5" />
          </>
        )}
      </svg>
      <span className="hidden text-[12px] font-semibold capitalize text-ink-soft sm:inline md:max-lg:hidden">{theme}</span>
    </button>
  );
}
