// ----------------------------------------------------------------- styles

// Only colors cross the bridge, as --color-<token> on the root element. The
// palettes below are what the board wears until they arrive. Radii, shadows,
// type and spacing are the host's values written out as literals.
export const LIGHT = [
  "--color-felt:#E9E7E1;--color-felt-deep:#DBD8D0;--color-surface:#F7F6F2;--color-surface-hi:#FFFFFF;",
  "--color-ink:#12202F;--color-ink-soft:#46596B;--color-ink-faint:#4F5D6A;--color-line:#C7C4BA;",
  "--color-line-strong:#77746D;--color-accent:#1D4E6E;--color-accent-ink:#F4F8FB;--color-accent-soft:#D6E4EE;",
  "--color-brass:#725411;--color-settled:#5B3A63;--color-go:#266454;--color-stop:#B33326;",
].join("");
export const DARK = [
  "--color-felt:#0E1726;--color-felt-deep:#0A101B;--color-surface:#162032;--color-surface-hi:#1E2B3F;",
  "--color-ink:#E9E7E1;--color-ink-soft:#A3B1C0;--color-ink-faint:#8494A4;--color-line:#2A3648;",
  "--color-line-strong:#6D7A8A;--color-accent:#5FA8D3;--color-accent-ink:#08131F;--color-accent-soft:#1C3247;",
  "--color-brass:#D9AE54;--color-settled:#C89BD1;--color-go:#5FBFA6;--color-stop:#E3695C;",
].join("");
export const LIGHT_DEPTH = [
  "color-scheme:light;--sh:18 32 47;--st-edge:color-mix(in srgb,var(--color-ink) 45%,var(--color-line-strong));",
  "--shadow-rest:0 1px 2px rgb(18 32 47/.1),0 2px 8px rgb(18 32 47/.08);",
  "--shadow-lift:0 2px 4px rgb(18 32 47/.12),0 10px 24px rgb(18 32 47/.16);",
  "--shadow-well:inset 0 2px 6px rgb(18 32 47/.12);",
].join("");
export const DARK_DEPTH = [
  "color-scheme:dark;--sh:0 0 0;--st-edge:var(--color-line-strong);",
  "--shadow-rest:0 1px 2px rgb(0 0 0/.4),0 2px 8px rgb(0 0 0/.3);",
  "--shadow-lift:0 2px 4px rgb(0 0 0/.45),0 12px 28px rgb(0 0 0/.4);",
  "--shadow-well:inset 0 2px 6px rgb(0 0 0/.45);",
].join("");

