#!/usr/bin/env bash
# Fails if site/src/version.mjs is older than the newest published release
# tag — the case a bump script exists but nobody ran it after cutting a tag.
#
# Needs the repository's tags, which a shallow `actions/checkout` does not
# fetch by default even with fetch-depth: 0; the CI job for this script fetches
# them explicitly (see .github/workflows/ci.yml).
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# shellcheck source=scripts/lib/release-pins.sh
source "$repo_root/scripts/lib/release-pins.sh"

version=$(read_version "$VERSION_FILE")
if [ -z "$version" ]; then
  echo "could not read the current version out of $VERSION_FILE" >&2
  exit 1
fi

# Newest first by version order, not by tag-creation order — a backport tag
# cut after a later release must not look newer than it is. A pre-release
# tag (anything with a "-", e.g. v1.0.0-rc1) is excluded: it never belongs in
# version.mjs, which names the current stable release.
latest_tag=$(git tag --list 'v*' --sort=-v:refname | grep -vE -- '-' | head -1 || true)

if [ -z "$latest_tag" ]; then
  echo "no v* release tags found (fetch tags in CI: fetch-depth: 0 and fetch-tags: true) — skipping"
  exit 0
fi

latest_version=${latest_tag#v}

newest=$(printf '%s\n%s\n' "$version" "$latest_version" | sort -V | tail -1)
if [ "$newest" != "$version" ]; then
  echo "site/src/version.mjs pins $version but the newest release is $latest_tag." >&2
  echo "run: scripts/bump-release-pins.sh $latest_version" >&2
  echo "(release order is bump, merge, then scripts/cut-release.sh — never tag first)" >&2
  exit 1
fi

echo "site/src/version.mjs ($version) is not behind the newest release tag ($latest_tag)"
