#!/bin/sh
# Report which marketing screenshots depict UI that has moved since they were
# last shot.
#
# The shipped set once trailed four separate features, because nothing connects
# a change in web/src to the assets that depict it: each of those PRs was green
# and none had any reason to look at site/src/assets. This does not fail — a
# stale screenshot is never a reason to block a code change — it just counts,
# per asset, the commits since its `shot_at` stamp that touched the files it
# depicts. The signal is the count, not the fact of one commit.
#
# After a re-shoot, move `shot_at` to the commit the new frames land in.
set -eu

manifest=${1:-site/src/assets/screenshots.json}

if [ ! -f "$manifest" ]; then
  echo "no screenshot manifest at $manifest"
  exit 0
fi

# tab-separated: files, shot_at, depicts — one line per asset, so a light/dark
# pair shot together is reported once rather than twice.
jq -r '.assets[] | [(.files | join(", ")), .shot_at, (.depicts | join(" "))] | @tsv' "$manifest" |
while IFS="$(printf '\t')" read -r files shot_at depicts; do
  if ! git cat-file -e "${shot_at}^{commit}" 2>/dev/null; then
    echo "- $files: unknown commit $shot_at in the manifest"
    continue
  fi
  # shellcheck disable=SC2086 # depicts is a space-separated pathspec list
  count=$(git log --format=%H "$shot_at..HEAD" -- $depicts | grep -c . || true)
  if [ "$count" -gt 0 ]; then
    echo "- $files: shot at $(printf %.7s "$shot_at"), $count commit(s) since have touched $depicts"
  fi
done >"${TMPDIR:-/tmp}/screenshot-freshness.$$"

if [ -s "${TMPDIR:-/tmp}/screenshot-freshness.$$" ]; then
  echo "These screenshots depict UI that has changed since they were shot:"
  echo
  cat "${TMPDIR:-/tmp}/screenshot-freshness.$$"
  echo
  echo "This is advisory. Re-shoot the affected assets if the change is visible."
else
  echo "every screenshot is up to date against the code it depicts"
fi
rm -f "${TMPDIR:-/tmp}/screenshot-freshness.$$"
