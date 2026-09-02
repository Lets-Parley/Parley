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
commit web/src/components/Table.tsx one "chore: table"
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
commit web/src/components/Table.tsx two "feat: table"
printf 'three\n' >"$test_repo/web/src/pages/PokerRoom.tsx"
printf 'two\n' >"$test_repo/web/src/pages/Landing.tsx"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "refactor: rework the room, touch the landing"

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

# A depicted path that no longer exists at HEAD can never be found stale, so it
# reads as fresh forever — exactly how a renamed or deleted component quietly
# stops reporting. It must be named, not counted clean.
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "$head",
      "depicts": ["web/src/pages/NoSuchFile.tsx"]
    }
  ]
}
JSON
out=$(cd "$test_repo" && "$checker")
if printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "a depicts path that does not exist must not read as up to date, got: $out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "poker.png.*NoSuchFile.tsx.*no longer"; then
  echo "expected the missing depicts path to be named, got: $out" >&2
  exit 1
fi

# A missing path alongside a live one must be reported without swallowing the
# staleness count for the path that does still exist. One commit after the stamp
# touches Landing.tsx, so the hand-counted expectation is exactly 1.
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "$head",
      "depicts": ["web/src/pages/NoSuchFile.tsx", "web/src/pages/Landing.tsx"]
    }
  ]
}
JSON
commit web/src/pages/Landing.tsx four "feat: move the landing again"
out=$(cd "$test_repo" && "$checker")
if ! printf '%s' "$out" | grep -q "poker.png.*NoSuchFile.tsx.*no longer"; then
  echo "expected the missing path to still be named beside a live one, got: $out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "poker.png.*1 commit"; then
  echo "expected the surviving path to still be counted, got: $out" >&2
  exit 1
fi

# `depicts` entries are literal paths, not git pathspec globs. A glob-looking
# entry matches nothing, and is reported as the missing path the report already
# displays it as, so the behaviour and the report agree.
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "$head",
      "depicts": ["web/src/pages/*.tsx"]
    }
  ]
}
JSON
commit web/src/pages/Landing.tsx five "feat: land again"
out=$(cd "$test_repo" && "$checker")
if printf '%s' "$out" | grep -q "commit(s) since"; then
  echo "a depicts glob must not silently match as a pathspec, got: $out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "poker.png.*no longer"; then
  echo "expected a glob-looking depicts entry to be reported as missing, got: $out" >&2
  exit 1
fi

# ...and a depicts entry that does exist literally but reads as a glob must match
# only itself. `Odd?.tsx` is a real tracked file; without literal pathspec magic
# git would expand the `?` and count the commit touching `OddX.tsx` instead. One
# commit after the stamp touches OddX.tsx and none touches Odd?.tsx, so the
# hand-counted expectation for this asset is zero — no staleness line at all.
commit "web/src/pages/Odd?.tsx" one "chore: a literal question mark"
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    {
      "files": ["site/src/assets/poker.png"],
      "shot_at": "$head",
      "depicts": ["web/src/pages/Odd?.tsx"]
    }
  ]
}
JSON
commit web/src/pages/OddX.tsx one "chore: the file the glob would have caught"
out=$(cd "$test_repo" && "$checker")
if printf '%s' "$out" | grep -q "commit(s) since"; then
  echo "a depicts entry must match literally, not as a glob, got: $out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "expected a literal match to leave the asset fresh, got: $out" >&2
  exit 1
fi

# The report is assembled in a temp file, and that file has to be both created
# under TMPDIR and removed on the way out. Without the mktemp the checker writes
# somewhere it was never told it could; without the trap it leaves the file
# behind. Pin both halves.
head=$(git -C "$test_repo" rev-parse HEAD)
write_manifest <<JSON
{
  "assets": [
    { "files": ["site/src/assets/poker.png"], "shot_at": "$head", "depicts": ["web/src/pages/Landing.tsx"] }
  ]
}
JSON
tmp_home=$(mktemp -d)
out=$(cd "$test_repo" && TMPDIR="$tmp_home" "$checker")
if ! printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "expected a clean report under a private TMPDIR, got: $out" >&2
  exit 1
fi
if [ -n "$(ls -A "$tmp_home")" ]; then
  echo "the checker left its temp file behind in $tmp_home: $(ls -A "$tmp_home")" >&2
  rm -rf "$tmp_home"
  exit 1
fi
# ...and if the temp file cannot be created at all, that is a failure, not a
# report written to a path nobody chose.
if out=$(cd "$test_repo" && TMPDIR="$tmp_home/gone" "$checker" 2>&1); then
  echo "expected a nonzero exit when the temp file cannot be created, got: $out" >&2
  rm -rf "$tmp_home"
  exit 1
fi
if printf '%s' "$out" | grep -q "every screenshot is up to date"; then
  echo "a checker that could not open its report must not claim an all-clear, got: $out" >&2
  rm -rf "$tmp_home"
  exit 1
fi
rm -rf "$tmp_home"

echo "screenshot freshness checker: ok"
