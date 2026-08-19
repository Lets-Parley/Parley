#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
checker="$repo_root/scripts/check-dco.sh"
test_repo=$(mktemp -d)
trap 'rm -rf "$test_repo"' EXIT HUP INT TERM

git -C "$test_repo" init -q
git -C "$test_repo" config user.name "Test Contributor"
git -C "$test_repo" config user.email "contributor@example.com"
git -C "$test_repo" commit --allow-empty -q -s -m "chore: establish base"
base=$(git -C "$test_repo" rev-parse HEAD)

git -C "$test_repo" commit --allow-empty -q -m "feat: unsigned change"
unsigned=$(git -C "$test_repo" rev-parse HEAD)
if (cd "$test_repo" && "$checker" "$base" "$unsigned") >"$test_repo/unsigned.out" 2>&1; then
  echo "unsigned commit unexpectedly passed" >&2
  exit 1
fi
grep -q "${unsigned%????????????????????????????????}" "$test_repo/unsigned.out"

git -C "$test_repo" commit --amend --allow-empty -q -s -m "feat: signed change"
signed=$(git -C "$test_repo" rev-parse HEAD)
(cd "$test_repo" && "$checker" "$base" "$signed")

git -C "$test_repo" commit --allow-empty -q -m "fix: malformed trailer" \
  -m "Signed-off-by: missing-address"
malformed=$(git -C "$test_repo" rev-parse HEAD)
if (cd "$test_repo" && "$checker" "$signed" "$malformed") >"$test_repo/malformed.out" 2>&1; then
  echo "malformed trailer unexpectedly passed" >&2
  exit 1
fi
grep -q "${malformed%????????????????????????????????}" "$test_repo/malformed.out"

echo "DCO checks passed"
