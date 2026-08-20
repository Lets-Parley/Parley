#!/bin/sh
# shellcheck disable=SC2016
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
workflow="$repo_root/.github/workflows/release.yml"

line_number() {
  pattern=$1
  line=$(grep -nF -- "$pattern" "$workflow" | head -n 1 | cut -d: -f1)
  test -n "$line"
  printf '%s\n' "$line"
}

grep -Fq 'release_commit: ${{ steps.release.outputs.release_commit }}' "$workflow"
# build, publish, sbom, release-assets. Pinned as a count so a newly added job
# that checks out anything other than the validated commit is caught.
checkout_count=$(grep -Fc 'ref: ${{ needs.validate.outputs.release_commit }}' "$workflow")
test "$checkout_count" -eq 4
tag_resolution_count=$(grep -Fc 'git rev-parse "$TAG^{commit}"' "$workflow")
test "$tag_resolution_count" -eq 2
grep -Fq 'STAGING_TAG: staging-${{ github.run_id }}-${{ github.run_attempt }}' "$workflow"
grep -Fq -- '--preserve-digests --all' "$workflow"
grep -Fq 'oci-archive:/release/parley-image.tar "docker://$IMAGE:$STAGING_TAG"' "$workflow"
if grep -F 'oci-archive:/release/parley-image.tar "docker://$IMAGE:$VERSION"' "$workflow"; then
  echo "OCI artifact is copied directly to the final version tag" >&2
  exit 1
fi

# Every docker/build-push-action step must stamp the version into the binary,
# so a build-arg mismatch cannot diverge the Go layer cache key and publish a
# differently-built binary than the one that was validated. Count
# per-step rather than counting the two literal strings independently, so a
# newly added build-push-action step with no build-arg is caught too, not
# just edits to the two steps that exist today. A step boundary is a
# top-level list item under `steps:` (a line starting with the same "- "
# indentation the workflow uses); this is indentation-sensitive by design so
# it is tripped by real workflow-structure changes rather than silently
# passing on them, and it is deliberately insensitive to how a step's own
# body is reformatted internally.
build_push_step_count=$(grep -Fc 'uses: docker/build-push-action' "$workflow")
build_push_with_version_count=$(awk '
  /^      - / { if (in_step && uses_build_push && has_version) count++; in_step=1; uses_build_push=0; has_version=0 }
  /uses: docker\/build-push-action/ { uses_build_push=1 }
  /VERSION=\$\{\{ needs\.validate\.outputs\.version \}\}/ { if (in_step) has_version=1 }
  END { if (in_step && uses_build_push && has_version) count++; print count+0 }
' "$workflow")
test "$build_push_step_count" -gt 0
test "$build_push_with_version_count" -eq "$build_push_step_count"

# The SBOM is scanned from the published image, never from a local archive: an
# SBOM naming an artifact nobody can pull is what shipped with v0.4.1.
grep -Fq 'image: ${{ needs.validate.outputs.image }}@${{ steps.platform.outputs.digest }}' "$workflow"
if grep -F 'image: oci-archive:' "$workflow"; then
  echo "SBOM is scanned from a local archive rather than the published image" >&2
  exit 1
fi

# Attaching the deployment manifests must not depend on the SBOM succeeding.
# That coupling is what left v0.4.0 with no release artifacts at all.
release_assets_needs=$(awk '/^  release-assets:/ { found=1; next } found && /needs:/ { print; exit }' "$workflow")
if printf '%s' "$release_assets_needs" | grep -Fq 'sbom'; then
  echo "release-assets depends on the sbom job; an SBOM failure would drop the manifests" >&2
  exit 1
fi

compare_line=$(line_number 'test "$actual" = "$expected"')
tag_check_line=$(line_number 'test "$current_commit" = "$VALIDATED_COMMIT"')
promotion_line=$(line_number '--tag "$IMAGE:$VERSION"')
test "$compare_line" -lt "$tag_check_line"
test "$tag_check_line" -lt "$promotion_line"

echo "release workflow checks passed"
