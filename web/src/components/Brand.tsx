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
  const { theme, isDark, cycle } = useTheme();
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
      <span
        aria-hidden
        className="h-3 w-3 shrink-0 rounded-full bg-ink-soft"
        style={{ boxShadow: isDark ? "inset 3px -2px 0 0 var(--color-surface)" : "none" }}
      />
      <span className="hidden font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint sm:inline">
        {theme}
      </span>
    </button>
  );
}
