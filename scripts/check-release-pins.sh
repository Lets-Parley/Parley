#!/usr/bin/env bash
# Fails if any pinned release reference (scripts/lib/release-pins.sh) does not
# read the version in site/src/version.mjs — the case a partial run of
# scripts/bump-release-pins.sh, or a hand-edit of one file but not the rest,
# leaves behind.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

version=$(read_version "$VERSION_FILE")
if [ -z "$version" ]; then
  echo "could not read the current version out of $VERSION_FILE" >&2
  exit 1
fi

status=0

check_pin() {
  local file=$1 template=$2
  if [ ! -f "$file" ]; then
    echo "missing: $file no longer exists but is pinned in scripts/lib/release-pins.sh" >&2
    status=1
    return
  fi
  local found
  found=$(current_pin_version "$file" "$template")
  if [ -z "$found" ]; then
    echo "gone: $file no longer has the pin ${template//@V@/X.Y.Z}" >&2
    status=1
  elif [ "$found" != "$version" ]; then
    echo "stale pin in $file: reads $found, expected $version (${template//@V@/$found})" >&2
    status=1
  fi
}

for i in "${!RELEASE_PIN_FILES[@]}"; do
  check_pin "${RELEASE_PIN_FILES[$i]}" "${RELEASE_PIN_TEMPLATES[$i]}"
done

if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "site/src/version.mjs pins $version but not every location agrees." >&2
  echo "run: scripts/bump-release-pins.sh $version" >&2
  exit 1
fi

echo "every release pin matches $version"
