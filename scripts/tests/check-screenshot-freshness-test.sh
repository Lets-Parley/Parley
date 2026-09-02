#!/bin/sh
# The staleness report is only worth reading if the counts are right, so the
# expected numbers below are counted by hand from the commits this script
# creates, never read back out of the checker.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
checker="$repo_root/scripts/check-screenshot-freshness.sh"
test_repo=$(mktemp -d)
trap 'rm -rf "$test_repo"' EXIT HUP INT TERM

git -C "$test_repo" init -q
git -C "$test_repo" config user.name "Test Contributor"
git -C "$test_repo" config user.email "contributor@example.com"
mkdir -p "$test_repo/web/src/pages" "$test_repo/web/src/components" "$test_repo/site/src/assets"

cat >"$test_repo/site/src/assets/screenshots.json" <<'JSON'
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "SHOT_AT",
      "depicts": ["web/src/pages/PokerRoom.tsx", "web/src/components/Table.tsx"]
    },
    {
      "files": ["site/src/assets/landing-light.png", "site/src/assets/landing-dark.png"],
      "shot_at": "SHOT_AT",
      "depicts": ["web/src/pages/Landing.tsx"]
    }
  ]
}
JSON

commit() {
  printf '%s\n' "$2" >"$test_repo/$1"
  git -C "$test_repo" add -A
  git -C "$test_repo" commit -q -m "$3"
}

commit web/src/pages/PokerRoom.tsx one "chore: base"
commit web/src/pages/Landing.tsx one "chore: landing"
shot_at=$(git -C "$test_repo" rev-parse HEAD)
sed -i "s/SHOT_AT/$shot_at/g" "$test_repo/site/src/assets/screenshots.json"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "chore: stamp the manifest"

# Nothing depicted has changed since the stamp, so every asset is fresh.
out=$(cd "$test_repo" && "$checker")
if ! printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "expected a clean report, got: $out" >&2
  exit 1
fi

# Three commits touch PokerRoom.tsx or Table.tsx after the stamp; one of them
# also touches Landing.tsx, but the landing asset does not depict the poker
# files, so its own count is 1 and poker's is 3.
commit web/src/pages/PokerRoom.tsx two "feat: header"
commit web/src/components/Table.tsx one "feat: table"
git -C "$test_repo" rm -q web/src/pages/PokerRoom.tsx
printf 'two\n' >"$test_repo/web/src/pages/Landing.tsx"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "refactor: drop the room, touch the landing"

out=$(cd "$test_repo" && "$checker")
printf '%s\n' "$out"
if ! printf '%s' "$out" | grep -q "site/src/assets/poker.png.*3 commit"; then
  echo "expected poker.png to be 3 commits stale" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "landing-light.png, site/src/assets/landing-dark.png.*1 commit"; then
  echo "expected the landing pair to be 1 commit stale, reported as one asset" >&2
  exit 1
fi

# Advisory means advisory: a stale asset must not fail the build.
(cd "$test_repo" && "$checker" >/dev/null)

# An unknown shot_at is a broken manifest, not a fresh asset, and must say so.
sed -i "s/$shot_at/0000000000000000000000000000000000000000/" "$test_repo/site/src/assets/screenshots.json"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "chore: break the stamp"
out=$(cd "$test_repo" && "$checker")
if ! printf '%s' "$out" | grep -q "unknown commit"; then
  echo "expected an unknown shot_at to be reported, got: $out" >&2
  exit 1
fi

echo "screenshot freshness checker: ok"
