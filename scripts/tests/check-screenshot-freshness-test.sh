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
# A checker that printed the all-clear unconditionally would pass the line above,
# so the clean and stale reports have to be mutually exclusive in both directions.
if printf '%s' "$out" | grep -q "depict UI that has changed"; then
  echo "a clean report must not also claim something is stale, got: $out" >&2
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
if printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "a stale report must not also claim everything is up to date, got: $out" >&2
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

# From here on each case installs its own manifest, so start from a known-good
# one and a clean tree.
write_manifest() {
  cat >"$test_repo/site/src/assets/screenshots.json"
  git -C "$test_repo" add -A
  git -C "$test_repo" commit -q -m "chore: rewrite the manifest"
}

# A manifest the checker cannot parse is a broken manifest. The one thing it
# must never do is answer "everything is fine".
for broken in '{ this is not json' '{"notassets":[]}' '{"assets":{"nope":true}}'; do
  printf '%s\n' "$broken" | write_manifest
  if out=$(cd "$test_repo" && "$checker" 2>&1); then
    echo "expected a nonzero exit for an unreadable manifest ($broken), got: $out" >&2
    exit 1
  fi
  if printf '%s' "$out" | grep -q "every screenshot is up to date"; then
    echo "an unreadable manifest ($broken) must not report an all-clear, got: $out" >&2
    exit 1
  fi
done

# An asset that depicts nothing can never be found stale, so it is a hole in the
# manifest rather than a fresh asset, and must be called out as one.
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    { "files": ["site/src/assets/poker.png"], "shot_at": "$head", "depicts": [] }
  ]
}
JSON
out=$(cd "$test_repo" && "$checker")
if printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "an asset depicting nothing must not read as up to date, got: $out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "poker.png.*depicts nothing"; then
  echo "expected the empty depicts list to be named, got: $out" >&2
  exit 1
fi

# A depicted path containing a space must still be matched. One commit after the
# stamp touches it, so the hand-counted expectation is exactly 1.
mkdir -p "$test_repo/web/src/story queue"
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "$head",
      "depicts": ["web/src/story queue/Panel.tsx"]
    }
  ]
}
JSON
printf 'one\n' >"$test_repo/web/src/story queue/Panel.tsx"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "feat: a path with a space in it"
out=$(cd "$test_repo" && "$checker")
if ! printf '%s' "$out" | grep -q "poker.png.*1 commit"; then
  echo "expected a spaced path to be matched once, got: $out" >&2
  exit 1
fi

# ...and must not word-split into a pathspec that matches everything. Two more
# commits touch unrelated files; the count must stay at 1.
commit web/src/pages/Landing.tsx three "chore: unrelated one"
commit web/src/components/Table.tsx three "chore: unrelated two"
out=$(cd "$test_repo" && "$checker")
if ! printf '%s' "$out" | grep -q "poker.png.*1 commit"; then
  echo "expected unrelated commits not to count against a spaced path, got: $out" >&2
  exit 1
fi

echo "screenshot freshness checker: ok"
