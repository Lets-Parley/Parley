#!/usr/bin/env bash
# scripts/cut-release.sh exists because v0.13.0 was tagged on a commit whose
# version.mjs still read 0.12.0, and the freshness gate then failed every pull
# request until the bump landed. Prove it refuses that shape, and the other
# ways a tag can be cut wrong, before trusting it to.
#
# Runs against a throwaway bare "origin" and a clone of it, with --dry-run so
# gh is never called and nothing leaves the machine. The clone carries its own
# copy of the scripts, because cut-release.sh works from its own checkout.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q --bare -b main "$work/origin.git"
git clone -q "$work/origin.git" "$work/clone" 2>/dev/null
clone="$work/clone"
cut="$clone/scripts/cut-release.sh"
git -C "$clone" config user.name "Test Contributor"
git -C "$clone" config user.email "contributor@example.com"
# origin reads as a GitHub URL (what --repo is derived from) but fetches from
# the local bare repo.
git -C "$clone" config remote.origin.url "https://github.com/Example-Org/Example.git"
git -C "$clone" config "url.$work/origin.git.insteadOf" "https://github.com/Example-Org/Example.git"

mkdir -p "$clone/scripts/lib"
cp "$repo_root/scripts/cut-release.sh" "$repo_root/scripts/check-release-pins.sh" "$clone/scripts/"
cp "$repo_root/scripts/lib/release-pins.sh" "$clone/scripts/lib/"

# Every pin in the real list, at one version, in the working copy.
write_pins() {
  local version=$1
  mkdir -p "$clone/$(dirname -- "$VERSION_FILE")"
  echo "${VERSION_TEMPLATE//@V@/$version}" >"$clone/$VERSION_FILE"
  local -A seen=()
  for i in "${!RELEASE_PIN_FILES[@]}"; do
    local file=${RELEASE_PIN_FILES[$i]}
    mkdir -p "$clone/$(dirname -- "$file")"
    if [ -z "${seen[$file]:-}" ]; then
      : >"$clone/$file"
      seen[$file]=1
    fi
    echo "${RELEASE_PIN_TEMPLATES[$i]//@V@/$version}" >>"$clone/$file"
  done
}

push_pins() {
  write_pins "$1"
  git -C "$clone" add -A
  git -C "$clone" commit -q -m "pin $1"
  git -C "$clone" push -q origin HEAD:main
}

run_cut() {
  (cd "$work" && "$cut" "$@") >"$work/out.log" 2>&1
}

expect_refusal() {
  local name=$1 needle=$2
  shift 2
  if run_cut "$@"; then
    echo "FAIL: $name unexpectedly succeeded" >&2
    cat "$work/out.log" >&2
    exit 1
  fi
  if ! grep -qF -- "$needle" "$work/out.log"; then
    echo "FAIL: $name did not mention '$needle'" >&2
    cat "$work/out.log" >&2
    exit 1
  fi
}

expect_command() {
  local name=$1 sha=$2
  shift 2
  if ! run_cut "$@"; then
    echo "FAIL: $name was refused" >&2
    cat "$work/out.log" >&2
    exit 1
  fi
  if ! grep -qF "gh release create v1.2.3 --repo Example-Org/Example --target $sha --generate-notes" "$work/out.log"; then
    echo "FAIL: $name did not print the gh command against origin/main ($sha)" >&2
    cat "$work/out.log" >&2
    exit 1
  fi
}

push_pins "1.2.3"

# Malformed versions never reach git, including the leading zeros release.yml
# rejects.
expect_refusal "a malformed version" "not a version" --dry-run 1.2
expect_refusal "a v-prefixed version" "not a version" --dry-run v1.2.4
expect_refusal "a leading-zero version" "not a version" --dry-run 01.2.3

# version.mjs at origin/main behind the requested tag: the v0.13.0 shape. The
# working copy already reads 1.2.4, so a cutter that read it would pass.
write_pins "1.2.4"
expect_refusal "a tag ahead of origin/main's version.mjs" "bump-release-pins.sh 1.2.4" --dry-run 1.2.4
git -C "$clone" checkout -q -- .

# A pin that disagrees with version.mjs at origin/main, while the working copy
# is clean.
sed -i 's/1\.2\.3/1.2.2/' "$clone/README.md"
git -C "$clone" commit -q -am "stale readme"
git -C "$clone" push -q origin HEAD:main
git -C "$clone" checkout -q HEAD~1 -- README.md
expect_refusal "a stale pin" "README.md" --dry-run 1.2.3
git -C "$clone" checkout -q HEAD -- README.md
git -C "$clone" revert --no-edit HEAD >/dev/null
git -C "$clone" push -q origin HEAD:main

# Equal at origin/main: prints the gh command, pinned to origin/main's exact
# sha, with the working copy at a different version and one commit ahead.
sha=$(git -C "$clone" rev-parse HEAD)
git -C "$clone" commit -q --allow-empty -m "local only"
write_pins "1.2.2"
expect_command "a matching origin/main under a stale working copy" "$sha" --dry-run 1.2.3
git -C "$clone" checkout -q -- .

# The tag already exists on origin.
git -C "$clone" tag v1.2.3 "$sha"
git -C "$clone" push -q origin v1.2.3
git -C "$clone" tag -d v1.2.3 >/dev/null
expect_refusal "an existing tag" "v1.2.3 already exists" --dry-run 1.2.3

echo "cut-release checks passed"
