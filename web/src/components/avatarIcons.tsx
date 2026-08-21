/**
 * The portrait sheet: thirty pre-rendered voxel-art faces a person can wear
 * instead of their initials.
 *
 * The art is DiceBear "voxel-art" (CC0 1.0), generated once with the
 * `dicebear` CLI's library — see `../assets/avatars/README.md` for the tool,
 * version and seeds — and committed as SVG. Nothing here talks to
 * api.dicebear.com at runtime: a self-hosted room must not leak one request
 * per person to a third party.
 *
 * A portrait carries its own colours, so it sits on the identity-hue disc
 * rather than borrowing `currentColor` from it the way the retired
 * silhouettes did. The disc still supplies the hue around and behind it.
 *
 * The ids are the wire format. The server validates their shape and nothing
 * else, so this map is the only place that knows what an id means; an id it
 * does not hold is not an error, it just falls back to initials. The twelve
 * ids this sheet replaced — parrot, kraken, anchor, lighthouse, wheel, gull,
 * buoy, crate, rubber-duck, coffee, terminal, pager — are retired, and are
 * never to be reused for a portrait.
 */
import ada from "../assets/avatars/ada.svg";
import bo from "../assets/avatars/bo.svg";
import cleo from "../assets/avatars/cleo.svg";
import noor from "../assets/avatars/noor.svg";
import eli from "../assets/avatars/eli.svg";
import fern from "../assets/avatars/fern.svg";
import gil from "../assets/avatars/gil.svg";
import hana from "../assets/avatars/hana.svg";
import ines from "../assets/avatars/ines.svg";
import jai from "../assets/avatars/jai.svg";
import kit from "../assets/avatars/kit.svg";
import lior from "../assets/avatars/lior.svg";
import mira from "../assets/avatars/mira.svg";
import nils from "../assets/avatars/nils.svg";
import otto from "../assets/avatars/otto.svg";
import pia from "../assets/avatars/pia.svg";
import quinn from "../assets/avatars/quinn.svg";
import rafa from "../assets/avatars/rafa.svg";
import sana from "../assets/avatars/sana.svg";
import tam from "../assets/avatars/tam.svg";
import uma from "../assets/avatars/uma.svg";
import vik from "../assets/avatars/vik.svg";
import wren from "../assets/avatars/wren.svg";
import xiu from "../assets/avatars/xiu.svg";
import yara from "../assets/avatars/yara.svg";
import zeke from "../assets/avatars/zeke.svg";
import ari from "../assets/avatars/ari.svg";
import bex from "../assets/avatars/bex.svg";
import cai from "../assets/avatars/cai.svg";
import dot from "../assets/avatars/dot.svg";

/** Bundler-resolved URLs, one per id. <Avatar> supplies the sizing. */
const portraits: Record<string, string> = {
  ada,
  bo,
  cleo,
  noor,
  eli,
  fern,
  gil,
  hana,
  ines,
  jai,
  kit,
  lior,
  mira,
  nils,
  otto,
  pia,
  quinn,
  rafa,
  sana,
  tam,
  uma,
  vik,
  wren,
  xiu,
  yara,
  zeke,
  ari,
  bex,
  cai,
  dot,
};

export const avatarIconIds = Object.keys(portraits);

export const avatarIconLabels: Record<string, string> = {
  ada: "Ada",
  bo: "Bo",
  cleo: "Cleo",
  noor: "Noor",
  eli: "Eli",
  fern: "Fern",
  gil: "Gil",
  hana: "Hana",
  ines: "Ines",
  jai: "Jai",
  kit: "Kit",
  lior: "Lior",
  mira: "Mira",
  nils: "Nils",
  otto: "Otto",
  pia: "Pia",
  quinn: "Quinn",
  rafa: "Rafa",
  sana: "Sana",
  tam: "Tam",
  uma: "Uma",
  vik: "Vik",
  wren: "Wren",
  xiu: "Xiu",
  yara: "Yara",
  zeke: "Zeke",
  ari: "Ari",
  bex: "Bex",
  cai: "Cai",
  dot: "Dot",
};

/**
 * The portrait URL for an id, or null for an id this build does not know —
 * which is the same code path as an unset avatar, so an id from a newer
 * client degrades to initials rather than to a blank chip.
 */
export function avatarIcon(id: string | undefined): string | null {
  if (!id) return null;
  // `hasOwn` before the index, or an id like `constructor` or `__proto__` —
  // all of which pass the server's shape check — resolves to an inherited
  // prototype value and lands in the tree as an invalid React child.
  return Object.hasOwn(portraits, id) ? portraits[id] : null;
}
