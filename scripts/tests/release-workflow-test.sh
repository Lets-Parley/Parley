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
# build, publish, sbom, release-assets. This is a count, not a per-job policy: it
# trips when a job stops pinning the validated commit, but a new job that checks
# out some other ref leaves the count untouched. chart deliberately checks out
# the tag, so a blanket per-job assertion would need an allow-list.
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
# Read the job's whole needs block. Matching only the physical `needs:` line
# lets block-style YAML ("needs:" then "  - sbom") reintroduce the coupling
# without tripping this.
release_assets_needs=$(awk '
  /^  release-assets:/ { in_job = 1; next }
  in_job && /^  [a-zA-Z_-]+:/ { exit }
  in_job && /^    needs:/ { in_needs = 1; print; next }
  in_needs && /^      - / { print; next }
  in_needs { in_needs = 0 }
' "$workflow")
test -n "$release_assets_needs"
if printf '%s' "$release_assets_needs" | grep -Fq 'sbom'; then
  echo "release-assets depends on the sbom job; an SBOM failure would drop the manifests" >&2
  exit 1
fi

# The artifact the sbom job uploads must be exactly what sbom-assets downloads.
# A typo in either passes every other check here and fails only at run time.
artifact_name_in_job() {
  awk -v job="$1" '
    $0 == "  " job ":" { in_job = 1; next }
    in_job && /^  [a-zA-Z_-]+:/ { exit }
    in_job && /name: release-sbom-/ { sub(/^ *name: */, ""); print; exit }
  ' "$workflow"
}
sbom_upload_name=$(artifact_name_in_job sbom)
sbom_download_name=$(artifact_name_in_job sbom-assets)
test -n "$sbom_upload_name"
test -n "$sbom_download_name"
test "$sbom_upload_name" = "$sbom_download_name"

compare_line=$(line_number 'test "$actual" = "$expected"')
tag_check_line=$(line_number 'test "$current_commit" = "$VALIDATED_COMMIT"')
promotion_line=$(line_number '--tag "$IMAGE:$VERSION"')
test "$compare_line" -lt "$tag_check_line"
test "$tag_check_line" -lt "$promotion_line"

# `gh release upload` resolves the repository from git unless --repo is given,
# and the sbom-assets job has no checkout — which is exactly how v0.4.2 shipped
# with its SBOMs unattached ("fatal: not a git repository"). Every upload must
# name the repository explicitly, whether or not its job happens to check out.
upload_count=$(grep -Fc 'gh release upload' "$workflow")
upload_with_repo=$(awk '
  /gh release upload/ { in_upload=1; has_repo=0 }
  in_upload && /--repo/ { has_repo=1 }
  in_upload && /--clobber/ { if (has_repo) count++; in_upload=0 }
  END { print count+0 }
' "$workflow")
test "$upload_count" -gt 0
test "$upload_with_repo" -eq "$upload_count"

# The publish receipt is the operator's answer to "did this release actually
# ship anything", so it has to be evidence, not a restatement of the workflow's
# own opinion. Two properties keep it honest: it resolves the image tag to the
# digest that was validated, and it compares them. A receipt that only echoed
# the version would be green on a release whose tag points somewhere else.
grep -Fq 'publish-receipt:' "$workflow"
grep -Fq 'test "$resolved" = "$DIGEST"' "$workflow"
grep -Fq 'helm show chart' "$workflow"

# Every gh release read/write outside a checkout needs --repo, for the same
# reason the uploads do. `gh release edit` and `gh release view` were added
# after that rule was written, so they are asserted by the same shape.
for verb in view edit; do
  cmd="gh release $verb"
  cmd_count=$(grep -Fc "$cmd" "$workflow")
  test "$cmd_count" -gt 0
  cmd_with_repo=$(grep -F "$cmd" "$workflow" | grep -Fc -- '--repo "$GITHUB_REPOSITORY"')
  test "$cmd_with_repo" -eq "$cmd_count"
done

# The receipt must be idempotent: a re-run strips the previous one before
# writing a new one, or a second run stacks a second block and the release notes
# grow a contradiction. That takes the marker in two places — the strip and the
# emit — so assert the count, not mere presence. A presence check passes when
# either half is deleted, which is the false green this guard exists to avoid.
grep -Fq "sed '/<!-- parley-publish-receipt -->/,\$d'" "$workflow"
grep -Fq "printf '<!-- parley-publish-receipt -->" "$workflow"

echo "release workflow checks passed"
