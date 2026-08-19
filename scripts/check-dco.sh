#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BASE HEAD" >&2
  exit 2
fi

base=$1
head=$2
failed=0

# Merge commits are skipped: they introduce no authored code of their own, and
# GitHub's "Update branch" button produces one with no trailer at all, which
# would otherwise fail the check on a branch whose every real commit is signed.
if ! commits=$(git rev-list --reverse --no-merges "$base..$head"); then
  echo "cannot resolve revision range $base..$head" >&2
  exit 2
fi

for commit in $commits; do
  message=$(git log -1 --format=%B "$commit")
  trailers=$(printf '%s\n' "$message" | git interpret-trailers --parse --no-divider)
  if ! printf '%s\n' "$trailers" |
    grep -Eq '^Signed-off-by: .+ <[^<>[:space:]]+@[^<>[:space:]]+>$'; then
    echo "commit $(git rev-parse --short=12 "$commit") is missing a valid Signed-off-by trailer" >&2
    failed=1
  fi
done

exit "$failed"
