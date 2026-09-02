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
# A manifest this cannot read is the one thing it does exit nonzero for. The
# point of the report is to be believed when it says the set is fresh, so it
# must never say that because it failed to look.
#
# After a re-shoot, move `shot_at` to the commit the new frames land in.
set -eu

manifest=${1:-site/src/assets/screenshots.json}

if [ ! -f "$manifest" ]; then
  echo "no screenshot manifest at $manifest"
  exit 0
fi

if ! count_assets=$(jq -e '
  if (.assets | type) == "array" then (.assets | length)
  else error("`.assets` is missing or is not an array")
  end' "$manifest" 2>&1); then
  echo "cannot read the screenshot manifest at $manifest:"
  echo "$count_assets"
  exit 1
fi

report=$(mktemp)
trap 'rm -f "$report"' EXIT HUP INT TERM

i=0
while [ "$i" -lt "$count_assets" ]; do
  # tab-separated: files, shot_at, how many paths this asset depicts, and those
  # paths for display — one line per asset, so a light/dark pair shot together
  # is reported once rather than twice.
  IFS="$(printf '\t')" read -r files shot_at depicts_count depicts <<JQ
$(jq -r --argjson i "$i" '.assets[$i] |
  [(.files | join(", ")), .shot_at, (.depicts | length | tostring), (.depicts | join(" "))]
  | @tsv' "$manifest")
JQ
  idx=$i
  i=$((i + 1))

  # An asset that depicts nothing can never be found stale, so it is a hole in
  # the manifest rather than a fresh asset.
  if [ "$depicts_count" -eq 0 ]; then
    echo "- $files: depicts nothing, so nothing can ever mark it stale — fill in its \`depicts\`"
    continue
  fi
  if ! git cat-file -e "${shot_at}^{commit}" 2>/dev/null; then
    echo "- $files: unknown commit $shot_at in the manifest"
    continue
  fi
  # One path per line, split on newlines only and with globbing off, so a
  # depicted path containing a space stays a single entry rather than
  # word-splitting into several that match far too much.
  set -f
  IFS='
'
  # shellcheck disable=SC2046 # deliberate: split the depicts list on newlines
  set -- $(jq -r --argjson i "$idx" '.assets[$i].depicts[]' "$manifest")
  unset IFS
  set +f

  # A path that no longer exists at HEAD matches no commit, so it reads as fresh
  # forever — which is precisely how a renamed or deleted component quietly
  # stops reporting. Name it instead of counting it clean.
  #
  # Each surviving path becomes a `:(literal)` pathspec, so it means the path
  # the report prints and nothing else. Without the magic, git would expand
  # `*` and `?` itself — `set -f` only stops the shell — and an entry like
  # `web/src/pages/*.tsx` would quietly match a whole directory while the
  # report displayed it as one file.
  missing=''
  remaining=$#
  while [ "$remaining" -gt 0 ]; do
    path=$1
    shift
    remaining=$((remaining - 1))
    if git cat-file -e "HEAD:$path" 2>/dev/null; then
      set -- "$@" ":(literal)$path"
    else
      missing="${missing:+$missing }$path"
    fi
  done

  if [ -n "$missing" ]; then
    echo "- $files: depicts $missing, which no longer exists at HEAD — update its \`depicts\`"
  fi
  if [ "$#" -eq 0 ]; then
    continue
  fi
  count=$(git log --format=%H "$shot_at..HEAD" -- "$@" | grep -c . || true)
  if [ "$count" -gt 0 ]; then
    echo "- $files: shot at $(printf %.7s "$shot_at"), $count commit(s) since have touched $depicts"
  fi
done >"$report"

if [ -s "$report" ]; then
  echo "These screenshots depict UI that has changed since they were shot:"
  echo
  cat "$report"
  echo
  echo "This is advisory. Re-shoot the affected assets if the change is visible."
else
  echo "every screenshot is up to date against the code it depicts"
fi
