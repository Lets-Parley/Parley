#!/bin/sh
# The FIPS image is a separate Dockerfile target so a default `docker build`
# does not compile it. These checks are the shape, not a substitute for
# building --target fips in CI.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
dockerfile="$repo_root/Dockerfile"

grep -Fq 'AS gobuild-fips' "$dockerfile"
grep -Fq 'AS fips' "$dockerfile"
grep -Fq 'GOFIPS140=v1.0.0' "$dockerfile"
grep -Fq 'GODEBUG=fips140=on' "$dockerfile"
# only panics on the RFC 6455 SHA-1 WebSocket accept key.
if grep -Fq 'GODEBUG=fips140=only' "$dockerfile"; then
  echo "FIPS image must not set fips140=only; WebSocket upgrades panic on SHA-1" >&2
  exit 1
fi

# Default `docker build` (no --target) uses the last FROM. That stage must
# not be the FIPS image, or every CI and operator build pays for GOFIPS140
# and silently ships fips140=on.
last_from=$(grep -E '^FROM ' "$dockerfile" | tail -n 1)
case $last_from in
  *' AS fips'|*' AS gobuild-fips')
    echo "last FROM is the FIPS stage; docker build without --target would produce it" >&2
    echo "$last_from" >&2
    exit 1
    ;;
esac

# The final stage's COPY must come from gobuild, not gobuild-fips.
final_copy=$(awk '
  /^FROM / { copy = "" }
  /COPY --from=/ { copy = $0 }
  END { print copy }
' "$dockerfile")
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

# The named fips stage must copy the FIPS binary and set on-mode.
fips_block=$(awk '
  /^FROM / && / AS fips$/ { in_fips = 1; print; next }
  in_fips && /^FROM / { exit }
  in_fips { print }
' "$dockerfile")
test -n "$fips_block"
printf '%s\n' "$fips_block" | grep -Fq 'COPY --from=gobuild-fips /parley /parley'
printf '%s\n' "$fips_block" | grep -Fq 'ENV GODEBUG=fips140=on'

echo "dockerfile fips checks passed"
