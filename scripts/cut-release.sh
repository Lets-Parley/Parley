#!/usr/bin/env bash
# Publishes release vX.Y.Z from the exact commit at origin/main, and refuses
# unless that commit already carries the bumped pins.
#
# The order is bump first, tag second. v0.13.0 was tagged on a commit whose
# version.mjs still read 0.12.0; scripts/check-release-freshness.sh then
# failed every pull request in the repository until the bump PR merged,
# twelve hours later. Tagging only a commit that already names the version
# leaves main fresh from the moment the tag exists.
#
# usage: scripts/cut-release.sh [--dry-run] X.Y.Z
#   --dry-run  run every check, print the gh command, do not run it
set -euo pipefail

usage() {
  echo "usage: $0 [--dry-run] X.Y.Z" >&2
  exit 2
}

dry_run=0
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=1
  shift
fi
[ "$#" -eq 1 ] || usage
version=$1
# The same shape release.yml's validate job accepts: no leading zeros.
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "not a version: '$version' (expected X.Y.Z, e.g. 0.12.0)" >&2
  exit 2
fi
tag="v$version"

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# gh gets the repository from origin's configured URL, never from whatever
# remote it would pick on its own.
origin_url=$(git config remote.origin.url)
origin_url=${origin_url%.git}
gh_repo=${origin_url#*github.com[:/]}
if [[ ! "$gh_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "origin ($origin_url) is not a github.com repository" >&2
  exit 1
fi

if ! git fetch origin main --tags; then
  echo "git fetch origin main --tags failed (a local tag that differs from origin's?)" >&2
  exit 1
fi
sha=$(git rev-parse origin/main)

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "tag $tag already exists; pick the next version" >&2
  exit 1
fi

# Check origin/main's tree, not the working copy: the tag is cut there.
tree=$(mktemp -d)
trap 'rm -rf "$tree"' EXIT
git archive "$sha" | tar -x -C "$tree"

# The pin list and checker come from the same tree, so they match the commit
# being tagged rather than whatever is checked out.
# shellcheck source=scripts/lib/release-pins.sh
source "$tree/scripts/lib/release-pins.sh"
pinned=$(read_version "$tree/$VERSION_FILE")
if [ "$pinned" != "$version" ]; then
  echo "origin/main ($sha) pins ${pinned:-nothing} in $VERSION_FILE, not $version." >&2
  echo "bump first: open a PR running scripts/bump-release-pins.sh $version, merge it, then re-run this." >&2
  exit 1
fi

if ! (cd "$tree" && ./scripts/check-release-pins.sh) >&2; then
  echo "origin/main ($sha) has release pins that disagree; fix them before tagging." >&2
  exit 1
fi

cmd=(gh release create "$tag" --repo "$gh_repo" --target "$sha" --generate-notes)
if [ "$dry_run" -eq 1 ]; then
  echo "dry run: ${cmd[*]}"
  exit 0
fi
"${cmd[@]}"
