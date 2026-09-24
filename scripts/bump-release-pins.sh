#!/usr/bin/env bash
# Rewrites every pinned release reference — site/src/version.mjs and the list
# in scripts/lib/release-pins.sh — to the version given.
#
# This exists because the bump after #470 was a one-off, manual chore that
# stopped happening: v0.11.0, v0.11.1 and v0.12.0 all shipped with every pin
# still saying 0.10.0, and SECURITY.md's supported-versions table never
# learned that v0.11.0 and v0.11.1 existed either. One command, run once per
# release, replaces re-editing nine files by hand and hoping none of them, or
# the versions that shipped in between, were missed.
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

# SECURITY.md's supported-versions table is not a simple find/replace: every
# version that moves out of "Yes" moves into the superseded row rather than
# disappearing. That is not only old_version: a release can ship while the
# pins sit stuck at an older one — v0.11.0 and v0.11.1 both shipped while
# this table still said 0.10.0 — and every version tagged in
# [old_version, new_version) belongs in the row, not only the one the "Yes"
# pin happened to name.
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

# Versions from git tags in [old_version, new_version), newest first. Falls
# back to just old_version outside a git checkout (or with no tags fetched)
# rather than silently moving nothing — the same gap this script exists to
# close, just for one version instead of a run of them.
superseded_additions() {
  local old=$1 new=$2
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    printf '%s\n' "$old"
    return 0
  fi
  local tags
  tags=$(git tag --list 'v*' 2>/dev/null | grep -vE -- '-' | sed 's/^v//')
  local -a additions=()
  local v found_old=0
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    if [ "$v" = "$old" ]; then
      found_old=1
    fi
    if version_lt "$v" "$new" && ! version_lt "$v" "$old"; then
      additions+=("$v")
    fi
  done <<<"$tags"
  if [ "$found_old" -eq 0 ]; then
    additions+=("$old")
  fi
  if [ "${#additions[@]}" -gt 0 ]; then
    printf '%s\n' "${additions[@]}" | sort -rV
  fi
}

if [ "$old_version" != "$new_version" ]; then
  existing_row=$(grep 'superseded' SECURITY.md || true)
  to_add=()
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    if ! grep -qF "$v" <<<"$existing_row"; then
      to_add+=("$v")
    fi
  done < <(superseded_additions "$old_version" "$new_version")
  if [ "${#to_add[@]}" -gt 0 ]; then
    prefix=$(printf '%s, ' "${to_add[@]}")
    prefix=${prefix%, }
    sed -i -E "s/^\| ([^|]*) \| No — superseded \|\$/| ${prefix}, \1 | No — superseded |/" SECURITY.md
  fi
fi

echo "bumped release pins: $old_version -> $new_version"
