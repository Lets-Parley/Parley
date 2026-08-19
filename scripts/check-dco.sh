#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BASE HEAD" >&2
  exit 2
fi

base=$1
head=$2
failed=0

for commit in $(git rev-list --reverse "$base..$head"); do
  if ! git log -1 --format=%B "$commit" |
    grep -Eq '^Signed-off-by: .+ <[^<>[:space:]]+@[^<>[:space:]]+>$'; then
    echo "commit $(git rev-parse --short=12 "$commit") is missing a valid Signed-off-by trailer" >&2
    failed=1
  fi
done

exit "$failed"
