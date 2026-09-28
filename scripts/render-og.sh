#!/usr/bin/env bash
# Renders the Open Graph share cards from their SVG sources:
#   site/src/assets/og/og-site.svg -> site/public/og.png
#   web/og/og-app.svg              -> web/public/og.png
# Needs `npm ci` in site/ and web/ (the SVGs load @fontsource woff2 files from
# node_modules) and a headless Chromium: set CHROME, or it uses Playwright's.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
chrome="${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1)}"
if [[ -z "$chrome" || ! -x "$chrome" ]]; then
  echo "no headless Chromium found; set CHROME=/path/to/chrome" >&2
  exit 1
fi
render() {
  local src="$root/$1" out="$root/$2"
  rm -f "$out"
  "$chrome" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=3000 \
    --screenshot="$out" "file://$src" >/dev/null 2>&1
  # Chrome is noisy on stderr even when it succeeds, so judge by the file.
  [[ -s "$out" ]] || { echo "render failed: $2" >&2; exit 1; }
  echo "wrote $2"
}
render site/src/assets/og/og-site.svg site/public/og.png
render web/og/og-app.svg web/public/og.png
