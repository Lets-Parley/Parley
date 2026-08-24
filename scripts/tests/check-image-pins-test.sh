#!/bin/sh
# Exercises the three outcomes check-image-pins.sh has to tell apart: a pin that
# is provably gone, a file with nothing to check, and a lookup that could not be
# completed. Only the first is allowed to fail the build.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
checker="$repo_root/scripts/check-image-pins.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A workflow with no digest-pinned image passes without touching the network,
# and `uses:` action pins must not be mistaken for one — they are 40-hex git
# commits, not sha256 manifest digests.
cat > "$work/none.yml" <<'YML'
jobs:
  build:
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: echo no images here
YML
if ! "$checker" "$work/none.yml" >"$work/none.log" 2>&1; then
  echo "FAIL: a workflow with no pinned images should pass" >&2
  cat "$work/none.log" >&2
  exit 1
fi

# A registry that cannot be reached is inconclusive, not absent. quay.io being
# down must never turn into a red build, or the check becomes the outage.
cat > "$work/unreachable.yml" <<'YML'
env:
  TOOL: nowhere.invalid/some/tool:v1@sha256:0000000000000000000000000000000000000000000000000000000000000000
YML
if ! "$checker" "$work/unreachable.yml" >"$work/unreachable.log" 2>&1; then
  echo "FAIL: an unreachable registry must not fail the build" >&2
  cat "$work/unreachable.log" >&2
  exit 1
fi
grep -q 'could not be checked' "$work/unreachable.log" || {
  echo "FAIL: an unreachable registry should be reported as unchecked" >&2
  cat "$work/unreachable.log" >&2
  exit 1
}

# The digest that broke the v0.7.0 release. quay.io re-pushed the v1.22.2 tag
# and garbage-collected this manifest, so it is gone for good and makes a
# durable fixture for the one case that must fail.
cat > "$work/gone.yml" <<'YML'
env:
  SKOPEO_IMAGE: quay.io/skopeo/stable:v1.22.2@sha256:64ac45c5a1c01230896fbae960b2213e32a5040e4009b83b5f5cbf31a35f61c3
YML
if "$checker" "$work/gone.yml" >"$work/gone.log" 2>&1; then
  if grep -q 'could not be checked' "$work/gone.log"; then
    echo "skipping the garbage-collected fixture: quay.io is not reachable" >&2
  else
    echo "FAIL: a garbage-collected digest should fail the build" >&2
    cat "$work/gone.log" >&2
    exit 1
  fi
fi

# The name parsing is the quiet failure mode: a mis-parsed host yields
# "unchecked", which passes, so the check would still be green while checking
# nothing. Pin the resolved URL for each name shape actually used here.
cat > "$work/forms.yml" <<'YML'
a: quay.io/skopeo/stable:v1.22.2@sha256:0000000000000000000000000000000000000000000000000000000000000001
b: postgres:16-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000002
c: ghcr.io/lets-parley/parley@sha256:0000000000000000000000000000000000000000000000000000000000000003
YML
CHECK_IMAGE_PINS_PRINT_URL=1 "$checker" "$work/forms.yml" > "$work/forms.log"
for expected in \
  "https://quay.io/v2/skopeo/stable/manifests/sha256:0000000000000000000000000000000000000000000000000000000000000001" \
  "https://registry-1.docker.io/v2/library/postgres/manifests/sha256:0000000000000000000000000000000000000000000000000000000000000002" \
  "https://ghcr.io/v2/lets-parley/parley/manifests/sha256:0000000000000000000000000000000000000000000000000000000000000003"
do
  grep -qF "$expected" "$work/forms.log" || {
    echo "FAIL: expected to resolve $expected" >&2
    cat "$work/forms.log" >&2
    exit 1
  }
done

echo "image pin checker tests passed"
