#!/usr/bin/env bash
# The FIPS image is a separate Dockerfile target so a default `docker build`
# does not compile it. These checks are the shape, not a substitute for
# building --target fips in CI.
#
# Comment lines are stripped first: a token that only survives as a `#`
# remark with the instruction deleted is not an instruction.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
dockerfile="$repo_root/Dockerfile"

active=$(grep -v '^[[:space:]]*#' "$dockerfile")

stage_block() {
  from_re=$1
  printf '%s\n' "$active" | awk -v from_re="$from_re" '
    $0 ~ from_re { in_stage = 1; print; next }
    in_stage && /^FROM / { exit }
    in_stage { print }
  '
}

printf '%s\n' "$active" | grep -Eq '^FROM gobuild AS gobuild-fips$' \
  || { echo "missing instruction: FROM gobuild AS gobuild-fips" >&2; exit 1; }

gobuild_fips_block=$(stage_block '^FROM gobuild AS gobuild-fips$')
test -n "$gobuild_fips_block"
printf '%s\n' "$gobuild_fips_block" | grep -Eq '^ARG GOFIPS140=v1.0.0$' \
  || { echo "gobuild-fips stage is missing ARG GOFIPS140=v1.0.0" >&2; exit 1; }

fips_block=$(stage_block ' AS fips$')
test -n "$fips_block"
printf '%s\n' "$fips_block" | grep -Fq 'COPY --from=gobuild-fips /parley /parley' \
  || { echo "fips stage does not copy from gobuild-fips" >&2; exit 1; }
printf '%s\n' "$fips_block" | grep -Eq '^ENV GODEBUG=fips140=on$' \
  || { echo "fips stage is missing ENV GODEBUG=fips140=on" >&2; exit 1; }

if printf '%s\n' "$active" | grep -Fq 'GODEBUG=fips140=only'; then
  echo "FIPS image must not set fips140=only; WebSocket upgrades panic on SHA-1" >&2
  exit 1
fi

godebug_on_count=$(printf '%s\n' "$active" | grep -c '^ENV GODEBUG=fips140=on$' || true)
if test "$godebug_on_count" -ne 1; then
  echo "expected exactly one ENV GODEBUG=fips140=on, found $godebug_on_count" >&2
  exit 1
fi

# Default `docker build` (no --target) uses the last FROM. That stage must
# not be the FIPS image, or every CI and operator build pays for GOFIPS140
# and silently ships fips140=on.
last_from=$(printf '%s\n' "$active" | grep -E '^FROM ' | tail -n 1)
case $last_from in
  *' AS fips'|*' AS gobuild-fips')
    echo "last FROM is the FIPS stage; docker build without --target would produce it" >&2
    echo "$last_from" >&2
    exit 1
    ;;
esac

last_stage=$(printf '%s\n' "$active" | awk '
  /^FROM / { buf = $0; next }
  { buf = buf ORS $0 }
  END { print buf }
')
if printf '%s\n' "$last_stage" | grep -Fq 'GODEBUG=fips140'; then
  echo "default (last) stage sets GODEBUG=fips140; docker build without --target would ship it" >&2
  echo "$last_stage" >&2
  exit 1
fi

# The final stage's COPY must come from gobuild, not gobuild-fips.
final_copy=$(printf '%s\n' "$active" | awk '
  /^FROM / { copy = "" }
  /COPY --from=/ { copy = $0 }
  END { print copy }
')
case $final_copy in
  *gobuild-fips*)
    echo "final stage copies from gobuild-fips: $final_copy" >&2
    exit 1
    ;;
  *'--from=gobuild '*)
    ;;
  *)
    echo "final stage does not copy from gobuild: $final_copy" >&2
    exit 1
    ;;
esac

echo "dockerfile fips checks passed"
