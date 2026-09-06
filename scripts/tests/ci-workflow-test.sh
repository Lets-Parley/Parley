#!/usr/bin/env bash
# Pins the docker smoke: it has to bring the service up through the operator
# compose file (hardening keys included) and fail if the container never
# becomes healthy. `docker run` skips read_only / cap_drop / no-new-privileges
# and never consults a healthcheck.
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
workflow="$repo_root/.github/workflows/ci.yml"
compose="$repo_root/docker-compose.yml"

job_block() {
  job=$1
  awk -v job="$job" '
    $0 == "  " job ":" { in_job = 1; print; next }
    in_job && /^  [a-zA-Z_-]+:/ { exit }
    in_job { print }
  ' "$workflow"
}

docker_block=$(job_block docker)
test -n "$docker_block"

# The smoke step, not the whole job: later steps export the image with
# `docker save` and must not be mistaken for the up path.
smoke_block=$(printf '%s\n' "$docker_block" | awk '
  /name: Smoke test first run/ { in_smoke = 1; print; next }
  in_smoke && /^      - name:/ { exit }
  in_smoke { print }
')
test -n "$smoke_block"
active_smoke=$(printf '%s\n' "$smoke_block" | grep -v '^[[:space:]]*#')

printf '%s\n' "$active_smoke" | grep -Eq 'docker compose .*[[:space:]]up([ [:space:]]|$)' \
  || { echo "docker smoke does not use docker compose up" >&2; exit 1; }

if printf '%s\n' "$active_smoke" | grep -Eq '^[[:space:]]*docker run( |$)'; then
  echo "docker smoke still uses docker run; it must go through compose so hardening keys apply" >&2
  exit 1
fi

# The operator file, not an inline substitute that could drop the keys.
# The overlay only retags the app image; hardening still comes from the
# operator file.
printf '%s\n' "$active_smoke" | grep -Fq 'docker-compose.yml' \
  || { echo "docker smoke does not pass docker-compose.yml to compose" >&2; exit 1; }
printf '%s\n' "$active_smoke" | grep -Fq 'docker-compose.ci.yml' \
  || { echo "docker smoke does not apply docker-compose.ci.yml (local image overlay)" >&2; exit 1; }

# --wait fails the step if a healthcheck never passes. A curl retry loop
# would stay green on a container that is running but never healthy.
printf '%s\n' "$active_smoke" | grep -Fq -- '--wait' \
  || { echo "docker smoke does not wait for a healthy container" >&2; exit 1; }

# Hardening keys live on the compose file compose up actually loads.
# Comment lines are stripped first: a token that only survives as a remark
# with the instruction deleted is not an instruction.
active_compose=$(grep -v '^[[:space:]]*#' "$compose")
app_block=$(printf '%s\n' "$active_compose" | awk '
  $0 == "  app:" { in_app = 1; print; next }
  in_app && /^  [a-zA-Z0-9_-]+:/ { exit }
  in_app { print }
')
test -n "$app_block"
printf '%s\n' "$app_block" | grep -Eq '^[[:space:]]+read_only: true$' \
  || { echo "compose app service is missing read_only: true" >&2; exit 1; }
printf '%s\n' "$app_block" | grep -Fq 'cap_drop: [ALL]' \
  || { echo "compose app service is missing cap_drop: [ALL]" >&2; exit 1; }
printf '%s\n' "$app_block" | grep -Fq 'no-new-privileges:true' \
  || { echo "compose app service is missing no-new-privileges:true" >&2; exit 1; }
printf '%s\n' "$app_block" | grep -Fq '/parley", "-healthcheck' \
  || { echo "compose app service is missing the /parley -healthcheck probe" >&2; exit 1; }

overlay="$repo_root/docker-compose.ci.yml"
test -f "$overlay"
active_overlay=$(grep -v '^[[:space:]]*#' "$overlay")
printf '%s\n' "$active_overlay" | grep -Eq '^[[:space:]]+image: parley:ci$' \
  || { echo "docker-compose.ci.yml must set image: parley:ci" >&2; exit 1; }
if printf '%s\n' "$active_overlay" | grep -Eq 'read_only:[[:space:]]*false'; then
  echo "docker-compose.ci.yml must not disable read_only" >&2
  exit 1
fi
if printf '%s\n' "$active_overlay" | grep -Eq 'cap_drop:'; then
  echo "docker-compose.ci.yml must not replace app cap_drop" >&2
  exit 1
fi

echo "ci workflow checks passed"
