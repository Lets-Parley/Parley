#!/bin/sh
# Resolve every digest-pinned container image in the given workflow files and
# fail if one is gone from its registry.
#
# This exists because a digest pin promises immutability the upstream does not
# have to honour. quay.io re-pushes skopeo/stable under the same version tag and
# garbage-collects the manifest it replaced, which has now cost three releases —
# v0.4.3, v0.6.0 and v0.7.0. The pin is not the problem; when we find out is.
# The release workflow runs on `release: published`, from the workflow file at
# the tag's own commit, and tags here are immutable, so the publish job is the
# first thing to touch these pins and by then the version number is already
# spent. Running the same lookup on every pull request moves the discovery to
# somewhere a fix is still free.
#
# A missing manifest fails. Anything else — a timeout, a 5xx, a registry that
# will not issue a token — is inconclusive and passes with a note, because a
# check that turns someone else's outage into a red build is worse than no
# check at all.
set -eu

# The loop below runs in a pipeline subshell, so a failure it sees cannot come
# back in a variable.
TMP_FAILED=$(mktemp)
trap 'rm -f "$TMP_FAILED"' EXIT

status=0

# A registry host carrying a port (registry.local:5000/app@sha256:...) is not
# matched and so is not checked. Nothing here pins one, and the cost of missing
# it is a pin that goes unchecked rather than one wrongly called gone.
for wf in "$@"; do
  grep -oE '[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64}' "$wf" | sort -u | while read -r ref; do
    digest=${ref#*@}
    repo=${ref%@*}
    # Only the final path segment can carry a tag; a registry host may carry a
    # port, which looks identical and must survive. A bare Docker Hub name is
    # its own final segment, so stripping the tag has to work with no slash at
    # all — getting this wrong turns postgres:16-alpine into the host name and
    # every lookup silently degrades to "unchecked".
    last=${repo##*/}
    case $last in
      *:*)
        tagless=${last%%:*}
        case $repo in
          */*) repo="${repo%/*}/$tagless" ;;
          *) repo=$tagless ;;
        esac
        ;;
    esac

    # A first segment with a dot or a port is a registry host; otherwise this is
    # a Docker Hub name, and a bare one lives under library/.
    first=${repo%%/*}
    case $repo in
      */*) case $first in *.*|*:*) host=$first; path=${repo#*/} ;;
                       *) host=registry-1.docker.io; path=$repo ;; esac ;;
      *) host=registry-1.docker.io; path="library/$repo" ;;
    esac

    url="https://$host/v2/$path/manifests/$digest"

    # The name parsing above is the part that can fail quietly: a bad host or
    # path yields "unchecked", which passes. This lets the tests pin the
    # resolved URL without a network round trip.
    if [ -n "${CHECK_IMAGE_PINS_PRINT_URL:-}" ]; then
      echo "url       $url"
      continue
    fi
    accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

    headers=$(curl -sS --max-time 30 -o /dev/null -D - -H "Accept: $accept" "$url" 2>/dev/null) || headers=''
    code=$(printf '%s' "$headers" | sed -n 's|^HTTP/[0-9.]* \([0-9]*\).*|\1|p' | tail -n 1)

    # 401 means the registry wants a token for a public read. Ask the realm it
    # names rather than hardcoding one, so Docker Hub and quay answer the same
    # way.
    if [ "$code" = 401 ]; then
      challenge=$(printf '%s' "$headers" | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *[Bb]earer *//p' | tail -n 1)
      realm=$(printf '%s' "$challenge" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')
      service=$(printf '%s' "$challenge" | sed -n 's/.*service="\([^"]*\)".*/\1/p')
      if [ -n "$realm" ]; then
        token=$(curl -sS --max-time 30 "$realm?service=$service&scope=repository:$path:pull" 2>/dev/null \
          | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || token=''
        if [ -n "$token" ]; then
          code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
            -H "Authorization: Bearer $token" -H "Accept: $accept" "$url" 2>/dev/null) || code=''
        fi
      fi
    fi

    case $code in
      200)
        echo "ok        $ref"
        ;;
      404)
        echo "GONE      $ref" >&2
        echo "          $wf pins a manifest the registry no longer serves." >&2
        echo "          Re-resolve it before cutting a tag:" >&2
        echo "          skopeo inspect --format '{{.Digest}}' docker://${repo}:<tag>" >&2
        echo gone > "$TMP_FAILED"
        ;;
      *)
        echo "unchecked $ref (could not be checked: HTTP ${code:-no response})"
        ;;
    esac
  done
done

if [ -s "$TMP_FAILED" ]; then
  status=1
fi
exit $status
