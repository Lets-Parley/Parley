#!/usr/bin/env bash
# scripts/check-release-pins.sh and scripts/check-release-freshness.sh exist to
# catch exactly what happened after #470: three releases shipped with every
# pin still reading the one before. Prove both fail on that before trusting
# either to fail on it in CI.
#
# Runs from a throwaway git repo built out of the real pin list in
# scripts/lib/release-pins.sh, so it does not depend on this repo's own
# history or tags — and so a pin added to the list is exercised here too,
# with no second copy to keep in sync.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
consistency_checker="$repo_root/scripts/check-release-pins.sh"
freshness_checker="$repo_root/scripts/check-release-freshness.sh"
bump="$repo_root/scripts/bump-release-pins.sh"

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" config user.name "Test Contributor"
git -C "$work" config user.email "contributor@example.com"

write_fixtures() {
  local version=$1
  mkdir -p "$work/$(dirname -- "$VERSION_FILE")"
  {
    echo "// fixture"
    echo "${VERSION_TEMPLATE//@V@/$version}"
  } >"$work/$VERSION_FILE"

  # SECURITY.md needs the exact "No — superseded" row shape the bump script
  # matches on, since one of its pins is that row's own "Yes" line.
  local -A seen=()
  for i in "${!RELEASE_PIN_FILES[@]}"; do
    local file=${RELEASE_PIN_FILES[$i]}
    local template=${RELEASE_PIN_TEMPLATES[$i]}
    mkdir -p "$work/$(dirname -- "$file")"
    if [ -z "${seen[$file]:-}" ]; then
      : >"$work/$file"
      seen[$file]=1
      if [ "$file" = "SECURITY.md" ]; then
        echo "| 0.0.1 | No — superseded |" >>"$work/$file"
      fi
    fi
    echo "${template//@V@/$version}" >>"$work/$file"
  done
  git -C "$work" add -A
  git -C "$work" commit -q -m "fixtures: pin $version" >/dev/null
}

# --- consistency check ---------------------------------------------------

write_fixtures "1.2.3"
if ! (cd "$work" && "$consistency_checker") >"$work/consistent.log" 2>&1; then
  echo "FAIL: every pin at 1.2.3 unexpectedly failed consistency" >&2
  cat "$work/consistent.log" >&2
  exit 1
fi

# A stale pin — one file left behind by a partial bump — must fail, and name
# the file it found stale.
sed -i 's/1\.2\.3/1.2.2/' "$work/README.md"
if (cd "$work" && "$consistency_checker") >"$work/stale.log" 2>&1; then
  echo "FAIL: a stale README.md pin unexpectedly passed" >&2
  exit 1
fi
grep -q "README.md" "$work/stale.log"
git -C "$work" checkout -q -- README.md

# --- bump script fixes the stale pin, and is idempotent -----------------

(cd "$work" && "$bump" 1.2.3) >/dev/null
sed -i 's/1\.2\.3/1.2.2/' "$work/README.md"
(cd "$work" && "$bump" 1.2.3) >/dev/null
if ! (cd "$work" && "$consistency_checker") >"$work/fixed.log" 2>&1; then
  echo "FAIL: bump-release-pins.sh did not fix a stale README.md pin" >&2
  cat "$work/fixed.log" >&2
  exit 1
fi
before=$(cd "$work" && git diff --stat)
(cd "$work" && "$bump" 1.2.3) >/dev/null
after=$(cd "$work" && git diff --stat)
if [ "$before" != "$after" ]; then
  echo "FAIL: re-running bump-release-pins.sh with the same version changed something" >&2
  exit 1
fi
git -C "$work" checkout -q -- .

# --- freshness check ------------------------------------------------------

write_fixtures "1.2.3"
if ! (cd "$work" && "$freshness_checker") >"$work/fresh.log" 2>&1; then
  echo "FAIL: version.mjs at 1.2.3 with no newer tag unexpectedly failed freshness" >&2
  cat "$work/fresh.log" >&2
  exit 1
fi

# A tag newer than version.mjs — the exact shape of a release that shipped
# without the pins being bumped — must fail and name the command to fix it.
git -C "$work" tag v1.2.3
git -C "$work" tag v1.3.0
git -C "$work" tag v2.0.0-rc1 # pre-release: must never look newer than a stable pin
if (cd "$work" && "$freshness_checker") >"$work/stale-tag.log" 2>&1; then
  echo "FAIL: a newer v1.3.0 tag unexpectedly passed freshness" >&2
  exit 1
fi
grep -q "v1.3.0" "$work/stale-tag.log"
grep -q "bump-release-pins.sh 1.3.0" "$work/stale-tag.log"
git -C "$work" tag -d v1.2.3 v1.3.0 v2.0.0-rc1 >/dev/null

# --- SECURITY.md's superseded row picks up releases the pins skipped ------
#
# #670's own finding: v0.11.0 and v0.11.1 both shipped while every pin still
# said v0.10.0, and the first pass at this script only moved the one version
# the "Yes" pin named into "superseded", leaving those two out of the table
# entirely. Reproduce the same shape — two tagged releases with no fixture
# commit of their own — and check the bump picks up both, newest first.
write_fixtures "1.0.0"
git -C "$work" tag v1.0.0
git -C "$work" tag v1.1.0
git -C "$work" tag v1.1.1
(cd "$work" && "$bump" 1.2.0) >/dev/null
superseded_row=$(grep 'superseded' "$work/SECURITY.md")
if [[ "$superseded_row" != *'1.1.1, 1.1.0, 1.0.0,'* ]]; then
  echo "FAIL: bump-release-pins.sh did not fold skipped tags v1.1.0/v1.1.1 into the superseded row" >&2
  echo "  row: $superseded_row" >&2
  exit 1
fi
git -C "$work" tag -d v1.0.0 v1.1.0 v1.1.1 >/dev/null

echo "release pin checks passed"
