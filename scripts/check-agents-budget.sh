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

OWNED="$AGENTS $STANDARDS $SHIP $HTTP $PLUGINS"

fail=0
link_errors=$(mktemp)
trap 'rm -f "$link_errors"' EXIT HUP INT TERM

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

for f in $OWNED; do
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

# docs/agents may contain only the three owned regular markdown files.
if [ ! -d docs/agents ]; then
  die "missing docs/agents directory"
else
  extras=$(find docs/agents \( -type f -o -type l -o -type d \) ! -path docs/agents 2>/dev/null | LC_ALL=C sort || true)
  want=$(printf '%s\n' "$SHIP" "$HTTP" "$PLUGINS" | LC_ALL=C sort)
  got=$(printf '%s\n' "$extras" | LC_ALL=C sort)
  # Allow only the three files; any other path (nested dir, symlink, extra md) fails.
  if [ "$got" != "$want" ]; then
    die "docs/agents must contain exactly ship.md, http.md, plugins.md (found: $(printf '%s' "$extras" | tr '\n' ' '))"
  fi
  for child in "$SHIP" "$HTTP" "$PLUGINS"; do
    if [ -L "$child" ]; then
      die "owned child must not be a symlink: $child"
    fi
    if [ ! -f "$child" ]; then
      die "owned child missing: $child"
    fi
  done
fi

# Explicit <a id="..."> or <hN id="..."> attribute values in a file.
list_ids() {
  file=$1
  grep -oE '<(a|h[1-6])[^>]*[[:space:]]id=["'\''][^"'\'']+["'\'']' "$file" 2>/dev/null |
    sed -E 's/.*[[:space:]]id=["'\'']([^"'\'']+)["'\''].*/\1/' || true
}

file_has_id() {
  file=$1
  id=$2
  list_ids "$file" | grep -Fxq "$id"
}

# Duplicate ids within each owned file.
for f in $OWNED; do
  dups=$(list_ids "$f" | LC_ALL=C sort | uniq -d || true)
  if [ -n "$dups" ]; then
    die "duplicate anchor id(s) in $f: $(printf '%s' "$dups" | tr '\n' ' ')"
  fi
done

# Each owned child must be linked from AGENTS.md (path with optional valid fragment).
for child in "$SHIP" "$HTTP" "$PLUGINS"; do
  if ! grep -Eq "\\]\\(${child}(#[a-z0-9_-]+)?\\)" "$AGENTS"; then
    die "AGENTS.md must contain a markdown link to $child"
  fi
done

# Reject path-escape tricks that walk through an owned instruction path
# (e.g. docs/agents/ship.md/../../CODE_STANDARDS.md). Ordinary ../../site/
# links from docs/agents/ are fine.
for f in $OWNED; do
  if grep -Eq '\]\((CODE_STANDARDS\.md|AGENTS\.md|docs/agents/[a-z0-9_-]+\.md)/\.\.' "$f"; then
    die "path-escape markdown link in $f (walks through an owned instruction path)"
  fi
done

# Resolve markdown links among owned instruction files.
# Capture ](target) where target is a relative owned path, optional fragment.
# Fragments must be [a-z0-9_-]+; anything else after # is a failure.
check_file_links() {
  src=$1
  # Extract raw ](...) contents that look like our owned paths (with any fragment).
  grep -oE '\]\((CODE_STANDARDS\.md|AGENTS\.md|docs/agents/[a-z0-9_-]+\.md|\.\./agents/[a-z0-9_-]+\.md|\./[a-z0-9_-]+\.md|[a-z0-9_-]+\.md)(#[^)]*)?\)' "$src" 2>/dev/null |
    sed -E 's/^\]\((.*)\)$/\1/' |
    sort -u |
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      file=${target%%#*}
      frag=
      case "$target" in
        *#*) frag=${target#*#} ;;
      esac

      # Normalize relative links from docs/agents/*.md
      case "$file" in
        ../agents/*) file=docs/agents/${file#../agents/} ;;
        ./*) file=${file#./} ;;
        ship.md|http.md|plugins.md)
          case "$src" in
            docs/agents/*) file=docs/agents/$file ;;
          esac
          ;;
      esac

      case "$file" in
        CODE_STANDARDS.md|AGENTS.md|docs/agents/ship.md|docs/agents/http.md|docs/agents/plugins.md) ;;
        *)
          # Ignore unrelated markdown links.
          continue
          ;;
      esac

      # Reject path tricks.
      case "$target" in
        *../*|*/../*|*//*)
          printf 'unsafe link path from %s: %s\n' "$src" "$target" >>"$link_errors"
          continue
          ;;
      esac

      if [ ! -f "$file" ]; then
        printf 'dangling link from %s: %s (missing %s)\n' "$src" "$target" "$file" >>"$link_errors"
        continue
      fi
      if [ -n "$frag" ]; then
        case "$frag" in
          *[!a-z0-9_-]*|'')
            printf 'invalid fragment from %s: %s\n' "$src" "$target" >>"$link_errors"
            continue
            ;;
        esac
        if ! file_has_id "$file" "$frag"; then
          printf 'dangling fragment from %s: %s (no id "%s" in %s)\n' "$src" "$target" "$frag" "$file" >>"$link_errors"
        fi
      fi
    done
}

for f in $OWNED; do
  check_file_links "$f"
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
