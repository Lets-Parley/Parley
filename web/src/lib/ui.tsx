import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/* ---------------------------------------------------------------- theme --- */

type Theme = "system" | "light" | "dark";
const THEME_KEY = "parley:theme";

function readTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// Three states, and the control cycles through all of them: a two-state toggle
// made "system" a door you could only walk out of once.
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return readTheme();
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private mode: the theme just doesn't persist.
    }
  }, [theme]);

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches);

  return { theme, isDark, cycle: () => setTheme(NEXT[theme]) };
}

/* ----------------------------------------------------------------- media --- */

/**
 * Live answer to a media query. The shell needs this in JS, not only in CSS:
 * a rail that is merely display:none still traps a focus ring, and a <dialog>
 * that is merely display:none still holds the page inert.
 */
export function useMediaQuery(query: string): boolean {
  const mql = useMemo(
    () => (typeof matchMedia === "function" ? matchMedia(query) : null),
    [query],
  );
  return useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        mql?.addEventListener("change", notify);
        return () => mql?.removeEventListener("change", notify);
      },
      [mql],
    ),
    () => mql?.matches ?? false,
    () => false,
  );
}

/* ---------------------------------------------------------------- toast --- */

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const say = useCallback((m: string) => {
    clearTimeout(timer.current);
    setMsg(m);
    timer.current = window.setTimeout(() => setMsg(null), 3400);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const ctx = useMemo(() => say, [say]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      {msg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[70] rounded-full border border-line bg-surface-hi px-6 py-3 text-sm font-bold shadow-lift"
          style={{ transform: "translate(-50%,0)", animation: "toast-up 220ms var(--ease-spring)" }}
        >
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------- countdown -- */

// Ticks a second-resolution countdown locally so the grace period visibly
// drains between WebSocket frames instead of jumping when one lands.
export function useCountdown(from: number | null): number | null {
  const [left, setLeft] = useState(from);
  useEffect(() => setLeft(from), [from]);
  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = window.setTimeout(() => setLeft((n) => (n === null ? null : Math.max(0, n - 1))), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return left;
}
