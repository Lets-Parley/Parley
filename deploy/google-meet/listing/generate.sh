#!/usr/bin/env bash
# Rebuilds every PNG in this directory. Needs ImageMagick's `convert` and
# Python 3 with Pillow -- neither is a new project dependency; this script
# is a maintainer convenience, not something setup.sh or the binary runs.
# Re-run after web/public/favicon.svg changes, or after the source
# screenshots in site/src/assets/ are reshot. See README.md for the asset
# requirements this is rendering to.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$SCRIPT_DIR"

command -v convert >/dev/null || { echo "ImageMagick's convert is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# Icons: 32x32 and 128x128 are required by every listing, 48x48 and 96x96
# for a web app -- Parley's add-on is one, so all four are built.
for size in 32 48 96 128; do
  convert -background none "$REPO_ROOT/web/public/favicon.svg" -resize "${size}x${size}" \
    -depth 8 -strip -define png:compression-level=9 "icon-${size}.png"
done

# Card banner: 220x140, rendered from card-banner.svg.
convert -background '#1D4E6E' card-banner.svg -resize 220x140 \
  -depth 8 -strip -define png:compression-level=9 card-banner.png

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
