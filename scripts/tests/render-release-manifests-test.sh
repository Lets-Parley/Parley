#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
renderer="$repo_root/scripts/render-release-manifests.sh"
output_dir=$(mktemp -d)
trap 'rm -rf "$output_dir"' EXIT HUP INT TERM

version=v1.2.3
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
"$renderer" "$version" "$digest" "$output_dir"

compose="$output_dir/parley-$version-compose.yml"
kubernetes="$output_dir/parley-$version-kubernetes.yml"
expected="ghcr.io/lets-parley/parley@$digest"

test -f "$compose"
test -f "$kubernetes"
grep -q "image: $expected" "$compose"
grep -q "image: $expected" "$kubernetes"
if grep -Eq 'ghcr\.io/lets-parley/parley:[^[:space:]]+' "$compose" "$kubernetes"; then
  echo "generated manifest retained a mutable application tag" >&2
  exit 1
fi

if "$renderer" 1.2.3 "$digest" "$output_dir" >/dev/null 2>&1; then
  echo "version without v prefix unexpectedly passed" >&2
  exit 1
fi
if "$renderer" "$version" sha256:not-a-digest "$output_dir" >/dev/null 2>&1; then
  echo "malformed digest unexpectedly passed" >&2
  exit 1
fi

echo "release manifest checks passed"
