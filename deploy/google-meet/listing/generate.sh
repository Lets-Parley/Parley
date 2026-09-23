#!/usr/bin/env bash
# Rebuilds every PNG in this directory. See README.md for the asset
# requirements this is rendering to, and for the renderer setup this needs.
#
# Icons and the card banner are rendered from SVG (web/public/favicon.svg
# and card-banner.svg). ImageMagick's built-in SVG delegate is NOT used for
# these: it mis-renders `transform="rotate(angle cx cy)"`, which clipped and
# mispositioned the two playing cards in Parley's mark. rsvg-convert is used
# when it's on PATH (it follows the SVG transform spec correctly); otherwise
# this falls back to headless Chromium via render.mjs, which needs
# PLAYWRIGHT_CORE_DIR and CHROMIUM_PATH set (see README.md).
#
# Screenshots are built from already-rendered PNGs with plain resize/extent,
# which neither renderer's SVG bug touches, so those still go through
# ImageMagick and Python 3 with Pillow -- neither is a new project
# dependency; this script is a maintainer convenience, not something
# setup.sh or the binary runs.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$SCRIPT_DIR"

command -v convert >/dev/null || { echo "ImageMagick's convert is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# Icons: 32x32 and 128x128 are required, 48x48 and 96x96 optional (they
# only matter for a "Web app" integration, which this add-on doesn't use).
# All four are still built. Card banner: 220x140.
if command -v rsvg-convert >/dev/null; then
  for size in 32 48 96 128; do
    rsvg-convert -w "$size" -h "$size" "$REPO_ROOT/web/public/favicon.svg" -o "icon-${size}.png"
  done
  rsvg-convert -w 220 -h 140 card-banner.svg -o card-banner.png
else
  : "${PLAYWRIGHT_CORE_DIR:?no rsvg-convert on PATH; set PLAYWRIGHT_CORE_DIR (see README.md)}"
  : "${CHROMIUM_PATH:?no rsvg-convert on PATH; set CHROMIUM_PATH (see README.md)}"
  node render.mjs "$REPO_ROOT/web/public/favicon.svg" \
    icon-32.png:32x32,icon-48.png:48x48,icon-96.png:96x96,icon-128.png:128x128
  node render.mjs card-banner.svg card-banner.png:220x140
fi
for f in icon-32.png icon-48.png icon-96.png icon-128.png card-banner.png; do
  convert "$f" -depth 8 -strip -define png:compression-level=9 "$f"
done

# Screenshots: scaled to fit 1280x800 and padded with the source
# screenshot's own background color, so an ultra-wide source is never
# cropped and nothing is invented to fill the frame.
bg() { convert "$1" -format "%[pixel:p{5,5}]" info:; }

convert "$REPO_ROOT/site/src/assets/present-light.png" -resize 1280x800 \
  -background "$(bg "$REPO_ROOT/site/src/assets/present-light.png")" -gravity center -extent 1280x800 \
  -depth 8 -strip -define png:compression-level=9 screenshot-mainstage-light.png

convert "$REPO_ROOT/site/src/assets/present-dark.png" -resize 1280x800 \
  -background "$(bg "$REPO_ROOT/site/src/assets/present-dark.png")" -gravity center -extent 1280x800 \
  -depth 8 -strip -define png:compression-level=9 screenshot-mainstage-dark.png

convert "$REPO_ROOT/site/src/assets/poker.png" -resize 1280x800 \
  -background "$(bg "$REPO_ROOT/site/src/assets/poker.png")" -gravity center -extent 1280x800 \
  -depth 8 -strip -define png:compression-level=9 screenshot-poker.png

# Quantize the screenshots and the banner to a 256-color palette -- these
# are flat UI renders, not photos, so this shrinks them a lot with no
# visible loss.
python3 - <<'PY'
from PIL import Image
import glob
for f in glob.glob("screenshot-*.png") + ["card-banner.png"]:
    im = Image.open(f).convert("RGB")
    im.quantize(colors=256, method=Image.MEDIANCUT).save(f, optimize=True)
PY

echo "generate.sh: rebuilt icons, card banner and screenshots in $SCRIPT_DIR"
