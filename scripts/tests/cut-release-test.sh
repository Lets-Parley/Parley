#!/usr/bin/env bash
# scripts/cut-release.sh exists because v0.13.0 was tagged on a commit whose
# version.mjs still read 0.12.0, and the freshness gate then failed every pull
# request until the bump landed. Prove it refuses that shape, and the other
# ways a tag can be cut wrong, before trusting it to.
#
# Runs against a throwaway bare "origin" and a clone of it, with --dry-run so
# gh is never called and nothing leaves the machine.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cut="$repo_root/scripts/cut-release.sh"

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q --bare -b main "$work/origin.git"
git clone -q "$work/origin.git" "$work/clone" 2>/dev/null
clone="$work/clone"
git -C "$clone" config user.name "Test Contributor"
git -C "$clone" config user.email "contributor@example.com"

# Every pin in the real list, at one version, pushed to origin/main.
push_fixtures() {
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
  git -C "$clone" add -A
  git -C "$clone" commit -q -m "pin $version"
  git -C "$clone" push -q origin HEAD:main
}

expect_refusal() {
  local name=$1 needle=$2
  shift 2
  if (cd "$clone" && "$cut" "$@") >"$work/out.log" 2>&1; then
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

push_fixtures "1.2.3"

# Malformed versions never reach git.
expect_refusal "a malformed version" "not a version" --dry-run 1.2
expect_refusal "a v-prefixed version" "not a version" --dry-run v1.2.4

# version.mjs at origin/main behind the requested tag: the v0.13.0 shape.
expect_refusal "a tag ahead of version.mjs" "bump-release-pins.sh 1.2.4" --dry-run 1.2.4

# A pin that disagrees with version.mjs at origin/main.
sed -i 's/1\.2\.3/1.2.2/' "$clone/README.md"
git -C "$clone" commit -q -am "stale readme"
git -C "$clone" push -q origin HEAD:main
expect_refusal "a stale pin" "README.md" --dry-run 1.2.3
git -C "$clone" revert --no-edit HEAD >/dev/null
git -C "$clone" push -q origin HEAD:main

# Equal: prints the gh command, pinned to origin/main's exact sha. The local
# checkout is moved off main first to prove the sha comes from origin/main.
sha=$(git -C "$clone" rev-parse HEAD)
git -C "$clone" commit -q --allow-empty -m "local only"
if ! (cd "$clone" && "$cut" --dry-run 1.2.3) >"$work/ok.log" 2>&1; then
  echo "FAIL: a matching version.mjs was refused" >&2
  cat "$work/ok.log" >&2
  exit 1
fi
if ! grep -qF "gh release create v1.2.3 --target $sha --generate-notes" "$work/ok.log"; then
  echo "FAIL: dry run did not print the gh command against origin/main ($sha)" >&2
  cat "$work/ok.log" >&2
  exit 1
fi

# The tag already exists on origin.
git -C "$clone" tag v1.2.3 "$sha"
git -C "$clone" push -q origin v1.2.3
git -C "$clone" tag -d v1.2.3 >/dev/null
expect_refusal "an existing tag" "v1.2.3 already exists" --dry-run 1.2.3

echo "cut-release checks passed"
