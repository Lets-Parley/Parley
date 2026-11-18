#!/usr/bin/env bash
set -euo pipefail

raw=$(docker run --rm \
  --volume "$HOME/.docker/config.json:/auth.json:ro" \
  "$SKOPEO_IMAGE" inspect --authfile /auth.json --raw \
  "docker://$IMAGE@$DIGEST")

# The index includes attestation manifests alongside the platform manifests.
amd64=$(jq -ers '
  select(length == 1)
  | .[0].manifests
  | map(select(.platform.architecture == "amd64" and .platform.os == "linux"))
  | select(length == 1)
  | .[0].digest
  | strings
  | select(test("\\Asha256:[0-9a-f]{64}\\z"))
' <<< "$raw")
printf 'digest=%s\n' "$amd64" >> "$GITHUB_OUTPUT"
