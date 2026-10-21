#!/usr/bin/env bash
# Prints the page URLs an IndexNow submission should carry for a push.
#
# usage: indexnow-urls.sh <before-sha> <after-sha> <sitemap-0.xml>
#
# A changed docs page maps to its own URL. Any other change under site/ (the
# config, a component, version.mjs, public/, the lockfile) can alter every
# page, so the whole sitemap is submitted instead — as it is when there is no
# usable base to diff against (a branch's first push, or a force push that
# dropped the old head). Output is capped at IndexNow's 10,000 URLs.
set -euo pipefail

base_url="https://www.letsparley.io"
before="$1" after="$2" sitemap="$3"

all() { grep -o '<loc>[^<]*' "$sitemap" | sed 's/^<loc>//'; }

emit() {
  if [[ "$before" =~ ^0+$ ]] || ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
    all
    return
  fi
  local changed=() f p
  # --no-renames so a moved page submits both its old URL (now gone, which
  # IndexNow also wants to hear about) and its new one.
  mapfile -t changed < <(git diff --no-renames --name-only "$before" "$after" -- site/)
  for f in "${changed[@]}"; do
    case "$f" in
      site/src/content/docs/*.md | site/src/content/docs/*.mdx) ;;
      *) all; return ;;
    esac
  done
  for f in "${changed[@]}"; do
    p="${f#site/src/content/docs/}"
    p="${p%.*}"
    p="${p%index}"
    p="${p%/}"
    if [[ -z "$p" ]]; then echo "$base_url/"; else echo "$base_url/$p/"; fi
  done
}

emit | awk 'NF && !seen[$0]++' | head -n 10000
