#!/bin/sh
set -eu

# A ceremony delivered as a plugin proves the extension points only if the host
# did not have to move to accommodate it. That claim is worth nothing written in
# a pull request description, so it is checked here: any pull request that
# touches a plugin under plugins/ must touch nothing the host is made of.
#
# The rule is deliberately one-directional. Core work on its own is ordinary and
# untouched by this; it is only the combination — a ceremony plugin and a change
# to the host in the same pull request — that says the extension points were not
# enough. If a plugin genuinely needs the host to change, that change is a
# finding about the extension points and lands as its own pull request first.
#
# "Core" is every tree the host is built out of, including the frontend: a
# plugin that can only be rendered by editing web/src has not been extended into
# Parley, it has been merged into it. Documentation, the checkers, and the
# workflows that run them are not the host — a ceremony that cannot be written
# about would be a poor guarantee.

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BASE HEAD" >&2
  exit 2
fi

base=$1
head=$2

if ! changed=$(git diff --name-only "$base" "$head"); then
  echo "cannot resolve revision range $base..$head" >&2
  exit 2
fi

plugin_changes=$(printf '%s\n' "$changed" | grep '^plugins/' || true)
if [ -z "$plugin_changes" ]; then
  echo "no plugin changes in $base..$head; the core-untouched rule does not apply"
  exit 0
fi

# Anchored prefixes, never substrings: a matching rule that can be satisfied by
# a path containing "cmd/" somewhere is a rule that gets evaded.
core_changes=$(printf '%s\n' "$changed" | grep -E \
  '^(internal/|cmd/|web/src/|go\.mod$|go\.sum$)' || true)

if [ -n "$core_changes" ]; then
  echo "this pull request delivers a plugin and also changes the host:" >&2
  printf '%s\n' "$core_changes" | sed 's/^/  /' >&2
  echo "" >&2
  echo "A ceremony delivered as a plugin has to work against the extension points" >&2
  echo "as they are. If one of them is missing, that is a finding: land the core" >&2
  echo "change as its own pull request first, then rebase this one onto it." >&2
  exit 1
fi

echo "this pull request delivers a plugin and leaves the host alone"
