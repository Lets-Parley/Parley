#!/usr/bin/env bash
# Rewrites every pinned release reference — site/src/version.mjs and the list
# in scripts/lib/release-pins.sh — to the version given.
#
# This exists because the bump after #470 was a one-off, manual chore that
# stopped happening: v0.11.0, v0.11.1 and v0.12.0 all shipped with every pin
# still saying 0.10.0. One command, run once per release, replaces re-editing
# nine files by hand and hoping none of them were missed.
#
# Each pin is found by its anchor text, not by a single "old version" read
# once from version.mjs: a pin can be stale at a version version.mjs has
# already moved past (a hand-edit that missed a file, or a previous run of
# this script that was interrupted), and running this script again has to fix
# that file too, not skip it because version.mjs already agrees with the
# target.
set -euo pipefail

usage() {
  echo "usage: $0 X.Y.Z" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
new_version=$1
if [[ ! "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "not a version: '$new_version' (expected X.Y.Z, e.g. 0.12.0)" >&2
  exit 2
fi

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

bump_pin() {
  local file=$1 template=$2
  if [ ! -f "$file" ]; then
    echo "pinned file is missing: $file" >&2
    exit 1
  fi
  local found
  found=$(current_pin_version "$file" "$template")
  if [ -z "$found" ]; then
    echo "expected pin not found in $file: ${template//@V@/X.Y.Z}" >&2
    exit 1
  fi
  sed -i -E $'s\x01'"$(pin_pattern "$template")"$'\x01\\1'"${new_version}"$'\\3\x01' "$file"
}

old_version=$(current_pin_version "$VERSION_FILE" "$VERSION_TEMPLATE")

bump_pin "$VERSION_FILE" "$VERSION_TEMPLATE"

for i in "${!RELEASE_PIN_FILES[@]}"; do
  bump_pin "${RELEASE_PIN_FILES[$i]}" "${RELEASE_PIN_TEMPLATES[$i]}"
done

# SECURITY.md's supported-versions table is not a simple find/replace: the
# version that was current a moment ago moves into the superseded row rather
# than disappearing. old_version is read from the "Yes" pin's own text above,
# before it was rewritten — never assumed to equal whatever version.mjs
# happened to say. Nothing to move on an idempotent re-run (old == new), and
# the superseded row is left alone if that version is already listed there,
# so re-running after a fix already applied by hand does not duplicate it.
if [ "$old_version" != "$new_version" ] && ! grep -qF "$old_version" <(grep 'superseded' SECURITY.md); then
  sed -i -E "s/^\| ([^|]*) \| No — superseded \|\$/| ${old_version}, \1 | No — superseded |/" SECURITY.md
fi

echo "bumped release pins: $old_version -> $new_version"
