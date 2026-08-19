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

git -C "$test_repo" commit --allow-empty -q -m "fix: body signoff" \
  -m "Signed-off-by: Test Contributor <contributor@example.com>

ordinary body text"
body_signoff=$(git -C "$test_repo" rev-parse HEAD)
if (cd "$test_repo" && "$checker" "$malformed" "$body_signoff") >"$test_repo/body-signoff.out" 2>&1; then
  echo "signoff outside the final trailer block unexpectedly passed" >&2
  exit 1
fi
grep -q "${body_signoff%????????????????????????????????}" "$test_repo/body-signoff.out"

git -C "$test_repo" commit --allow-empty -q -m "chore(deps): bump something" \
  -m "---
updated-dependencies:
- dependency-name: node
  dependency-type: direct:production
...

Signed-off-by: dependabot[bot] <support@github.com>"
divider=$(git -C "$test_repo" rev-parse HEAD)
(cd "$test_repo" && "$checker" "$body_signoff" "$divider")

# An unsigned merge commit must pass: GitHub's "Update branch" button makes one
# with no trailer, and it carries no authored code to attest to. The commits it
# merges in are still checked on their own.
git -C "$test_repo" checkout -q -b side "$base"
git -C "$test_repo" commit --allow-empty -q -s -m "feat: signed work on a side branch"
side=$(git -C "$test_repo" rev-parse HEAD)
git -C "$test_repo" checkout -q -
git -C "$test_repo" merge -q --no-ff --no-verify -m "Merge branch 'side' into trunk" "$side"
merge=$(git -C "$test_repo" rev-parse HEAD)
if [ "$(git -C "$test_repo" rev-list --count --merges "$divider..$merge")" -ne 1 ]; then
  echo "expected the merge commit to have been created" >&2
  exit 1
fi
(cd "$test_repo" && "$checker" "$divider" "$merge")

if (cd "$test_repo" && "$checker" not-a-revision "$signed") >"$test_repo/revision.out" 2>&1; then
  echo "invalid revision range unexpectedly passed" >&2
  exit 1
fi
grep -q "cannot resolve revision range" "$test_repo/revision.out"

echo "DCO checks passed"
