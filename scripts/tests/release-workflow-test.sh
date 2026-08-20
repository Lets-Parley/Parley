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
checkout_count=$(grep -Fc 'ref: ${{ needs.validate.outputs.release_commit }}' "$workflow")
test "$checkout_count" -eq 3
tag_resolution_count=$(grep -Fc 'git rev-parse "$TAG^{commit}"' "$workflow")
test "$tag_resolution_count" -eq 2
version_arg_count=$(grep -Fc 'VERSION=${{ needs.validate.outputs.version }}' "$workflow")
test "$version_arg_count" -eq 2
grep -Fq 'STAGING_TAG: staging-${{ github.run_id }}-${{ github.run_attempt }}' "$workflow"
grep -Fq -- '--preserve-digests --all' "$workflow"
grep -Fq 'oci-archive:/release/parley-image.tar "docker://$IMAGE:$STAGING_TAG"' "$workflow"
if grep -F 'oci-archive:/release/parley-image.tar "docker://$IMAGE:$VERSION"' "$workflow"; then
  echo "OCI artifact is copied directly to the final version tag" >&2
  exit 1
fi

compare_line=$(line_number 'test "$actual" = "$expected"')
tag_check_line=$(line_number 'test "$current_commit" = "$VALIDATED_COMMIT"')
promotion_line=$(line_number '--tag "$IMAGE:$VERSION"')
test "$compare_line" -lt "$tag_check_line"
test "$tag_check_line" -lt "$promotion_line"

echo "release workflow checks passed"
