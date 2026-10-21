import { BASE_STYLES } from "./base.js";
import { HEADER_STYLES } from "./header.js";
import { LANE_STYLES } from "./lanes.js";
import { NOTE_STYLES } from "./notes.js";
import { STICKER_STYLES } from "./stickers.js";
import { ACTION_STYLES } from "./actions.js";
import { POPOVER_STYLES } from "./popovers.js";
import { RESPONSIVE_STYLES } from "./responsive.js";

export const STYLES = [].concat(
  BASE_STYLES, HEADER_STYLES, LANE_STYLES, NOTE_STYLES,
  STICKER_STYLES, ACTION_STYLES, POPOVER_STYLES, RESPONSIVE_STYLES,
).join("\n");

// ui.fonts.js is put in front of this file by the build. Run on its own, as
// the tests do, the board falls back to the system faces.
export function fontFaces() {
  if (typeof RETRO_FONTS === "undefined") return "";
  return RETRO_FONTS.map(function (font) {
    return (
      '@font-face{font-family:"' + font.family + '";font-weight:' + font.weight +
      ";font-style:normal;font-display:swap;src:url(data:font/woff2;base64," + font.data + ') format("woff2")}\n'
    );
  }).join("");
}

