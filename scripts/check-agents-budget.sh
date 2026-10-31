#!/bin/sh
# Structural checks for AGENTS.md, CODE_STANDARDS.md, and docs/agents/*.md.
# Byte budgets, owned files, markdown links, and unique anchors only.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

TARGET=12288
FAIL_ABOVE=16384

AGENTS=AGENTS.md
STANDARDS=CODE_STANDARDS.md
SHIP=docs/agents/ship.md
HTTP=docs/agents/http.md
PLUGINS=docs/agents/plugins.md

fail=0

die() {
  printf '%s\n' "$*" >&2
  fail=1
}

warnf() {
  printf 'warning: %s\n' "$*" >&2
}

byte_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

require_regular_nonempty() {
  path=$1
  if [ ! -e "$path" ]; then
    die "missing required file: $path"
    return
  fi
  if [ -L "$path" ]; then
    die "required file must not be a symlink: $path"
    return
  fi
  if [ ! -f "$path" ]; then
    die "required path is not a regular file: $path"
    return
  fi
  if [ "$(byte_size "$path")" -eq 0 ]; then
    die "required file is empty: $path"
  fi
}

for f in "$AGENTS" "$STANDARDS" "$SHIP" "$HTTP" "$PLUGINS"; do
  require_regular_nonempty "$f"
done

agents_bytes=$(byte_size "$AGENTS")
if [ "$agents_bytes" -gt "$FAIL_ABOVE" ]; then
  die "AGENTS.md is $agents_bytes bytes (limit $FAIL_ABOVE; target $TARGET)"
elif [ "$agents_bytes" -gt "$TARGET" ]; then
  warnf "AGENTS.md is $agents_bytes bytes (over target $TARGET; hard fail above $FAIL_ABOVE)"
fi

# Only root AGENTS.md among tracked instruction entry points.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  entries=$(git ls-files -- 'AGENTS.md' '**/AGENTS.md' 'CLAUDE.md' '**/CLAUDE.md' 'AGENTS.override.md' '**/AGENTS.override.md' || true)
  for entry in $entries; do
    case "$entry" in
      AGENTS.md) ;;
      *)
        die "unexpected instruction entry point (only root AGENTS.md is allowed): $entry"
        ;;
    esac
  done
fi

# Exactly the three initial children.
child_list=$(find docs/agents -maxdepth 1 -type f -name '*.md' 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')
expected="$SHIP $HTTP $PLUGINS "
# Normalize ordering for compare
got=$(find docs/agents -maxdepth 1 -type f -name '*.md' 2>/dev/null | LC_ALL=C sort)
want=$(printf '%s\n' "$SHIP" "$HTTP" "$PLUGINS" | LC_ALL=C sort)
if [ "$got" != "$want" ]; then
  die "docs/agents must contain exactly ship.md, http.md, plugins.md (found: $child_list)"
fi

file_has_id() {
  file=$1
  id=$2
  grep -Fq "id=\"$id\"" "$file" || grep -Fq "id='$id'" "$file"
}

# Duplicate ids within each owned file.
for f in "$AGENTS" "$STANDARDS" "$SHIP" "$HTTP" "$PLUGINS"; do
  dups=$(grep -oE '<a[[:space:]]+id=["'\''][^"'\'']+["'\'']' "$f" |
    sed -E 's/.*id=["'\'']([^"'\'']+)["'\''].*/\1/' |
    LC_ALL=C sort | uniq -d || true)
  if [ -n "$dups" ]; then
    die "duplicate anchor id(s) in $f: $(printf '%s' "$dups" | tr '\n' ' ')"
  fi
done

# Each owned child must be linked from AGENTS.md.
for child in "$SHIP" "$HTTP" "$PLUGINS"; do
  if ! grep -Eq "\\]\\(${child}(#[^)]*)?\\)" "$AGENTS"; then
    die "AGENTS.md must contain a markdown link to $child"
  fi
done

# Resolve links from AGENTS.md into owned instruction files.
grep -oE '\]\((CODE_STANDARDS\.md|AGENTS\.md|docs/agents/[a-z0-9_-]+\.md)(#[a-z0-9_-]+)?\)' "$AGENTS" |
  sed -E 's/^\]\((.*)\)$/\1/' |
  sort -u |
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    file=${target%%#*}
    frag=
    case "$target" in
      *#*) frag=${target#*#} ;;
    esac
    if [ ! -f "$file" ]; then
      die "dangling link from AGENTS.md: $target (missing $file)"
      continue
    fi
    if [ -n "$frag" ] && ! file_has_id "$file" "$frag"; then
      die "dangling fragment from AGENTS.md: $target (no id \"$frag\" in $file)"
    fi
  done

# Pipeline subshell cannot set fail; re-scan for dangling fragments in this shell.
link_errors=$(mktemp)
trap 'rm -f "$link_errors"' EXIT HUP INT TERM
grep -oE '\]\((CODE_STANDARDS\.md|AGENTS\.md|docs/agents/[a-z0-9_-]+\.md)(#[a-z0-9_-]+)?\)' "$AGENTS" |
  sed -E 's/^\]\((.*)\)$/\1/' |
  sort -u |
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    file=${target%%#*}
    frag=
    case "$target" in
      *#*) frag=${target#*#} ;;
    esac
    if [ ! -f "$file" ]; then
      printf 'dangling link from AGENTS.md: %s (missing %s)\n' "$target" "$file" >>"$link_errors"
      continue
    fi
    if [ -n "$frag" ] && ! file_has_id "$file" "$frag"; then
      printf 'dangling fragment from AGENTS.md: %s (no id "%s" in %s)\n' "$target" "$frag" "$file" >>"$link_errors"
    fi
  done
if [ -s "$link_errors" ]; then
  while IFS= read -r line; do
    die "$line"
  done <"$link_errors"
fi

for f in "$STANDARDS" "$SHIP" "$HTTP" "$PLUGINS"; do
  printf 'info: %s is %s bytes\n' "$f" "$(byte_size "$f")"
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
printf 'ok: AGENTS.md %s bytes (target %s, fail above %s)\n' "$agents_bytes" "$TARGET" "$FAIL_ABOVE"
exit 0
