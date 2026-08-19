#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 VERSION IMAGE_DIGEST OUTPUT_DIR" >&2
  exit 2
fi

version=$1
digest=$2
output_dir=$3

case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "version must match vMAJOR.MINOR.PATCH" >&2; exit 2 ;;
esac
if ! printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "version must match vMAJOR.MINOR.PATCH" >&2
  exit 2
fi
if ! printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "image digest must be a sha256 digest" >&2
  exit 2
fi

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
image="ghcr.io/lets-parley/parley@$digest"
mkdir -p "$output_dir"

sed -E "s#ghcr\.io/lets-parley/parley(:[^[:space:]]+|@sha256:[0-9a-f]{64})#$image#" \
  "$repo_root/docker-compose.yml" >"$output_dir/parley-$version-compose.yml"
sed -E "s#ghcr\.io/lets-parley/parley(:[^[:space:]]+|@sha256:[0-9a-f]{64})#$image#" \
  "$repo_root/deploy/k8s/deployment.yaml" >"$output_dir/parley-$version-kubernetes.yml"
