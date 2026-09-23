#!/usr/bin/env bash
# Registers the Parley Meet add-on in the operator's own Google Cloud
# project. Run from the "Open in Cloud Shell" tutorial (tutorial.md) or by
# hand from a clone of this repository. Idempotent: a re-run replaces the
# existing deployment instead of failing.
#
# What this script cannot do — no API exists for these, so they stay manual
# console steps printed at the end: Marketplace SDK App configuration
# (integration type, deployment pointer, visibility, developer contact
# fields — permanent once saved) and the admin's org-wide install toggle.
set -euo pipefail

# Never stop to ask a yes/no question; every gcloud call below is meant to
# run unattended from the tutorial.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

: "${BASE_URL:?set BASE_URL to your Parley instance, e.g. https://parley.example.com}"

# Validated before any gcloud call: https, host only, no path or trailing
# slash. This is the same string the operator already set for Parley itself
# (see site/src/content/docs/operations/google-meet.mdx).
if ! [[ "$BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "BASE_URL must be https://host[:port] with no path and no trailing slash (got: $BASE_URL)" >&2
  exit 1
fi

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "no active gcloud project. Run: gcloud config set project PROJECT_ID" >&2
  exit 1
fi

DEPLOYMENT_ID="parley"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DEPLOYMENT_FILE="$WORK_DIR/deployment.json"

# A just-enabled API keeps rejecting calls for a few seconds while it
# finishes activating — on a fresh project this is what made `describe` look
# hung. That class of failure is a PERMISSION_DENIED or FAILED_PRECONDITION
# naming the API as not yet usable; retry only on that text, with a bounded
# exponential backoff (defaults: up to 6 attempts, 5s/10s/20s/30s/30s between
# them, ~95s total). Anything else — a real permission problem, a bad
# deployment file — returns on the first attempt with gcloud's own message
# intact.
RETRY_MAX_ATTEMPTS="${RETRY_MAX_ATTEMPTS:-6}"
RETRY_INITIAL_DELAY="${RETRY_INITIAL_DELAY:-5}"
ACTIVATION_ERROR_RE='(PERMISSION_DENIED|FAILED_PRECONDITION).*(has not been used|is disabled)'

retry_while_activating() {
  local attempt=1 delay="$RETRY_INITIAL_DELAY"
  local err_file="$WORK_DIR/retry-error"
  local status
  while :; do
    if "$@" 2>"$err_file"; then
      cat "$err_file" >&2
      rm -f "$err_file"
      return 0
    else
      status=$?
    fi
    cat "$err_file" >&2
    if [[ $attempt -ge $RETRY_MAX_ATTEMPTS ]] || ! grep -qE "$ACTIVATION_ERROR_RE" "$err_file"; then
      rm -f "$err_file"
      return "$status"
    fi
    rm -f "$err_file"
    echo "the API is still activating, retrying ($attempt/$RETRY_MAX_ATTEMPTS)..." >&2
    sleep "$delay"
    delay=$(( delay * 2 > 30 ? 30 : delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
}

# 1. Enable the two services a Meet add-on needs.
#    https://cloud.google.com/sdk/gcloud/reference/services/enable
gcloud services enable \
  gsuiteaddons.googleapis.com \
  appsmarket-component.googleapis.com

# 2. Build the manifest from the same template the operator guide's example
#    is copied from (deploy/google-meet/manifest.template.json), substituting
#    the operator's BASE_URL for the placeholder.
sed "s#BASE_URL_PLACEHOLDER#${BASE_URL}#g" "$SCRIPT_DIR/manifest.template.json" >"$DEPLOYMENT_FILE"

# 3. Create the deployment, or replace it if a re-run finds one already
#    there. `--format=none` keeps a successful replace from echoing the
#    whole manifest back. `create` is GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/create
#    `describe` and `replace` are also GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/describe
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/replace
if retry_while_activating gcloud workspace-add-ons deployments describe "$DEPLOYMENT_ID" --format=none; then
  if ! retry_while_activating gcloud workspace-add-ons deployments replace "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE" --format=none; then
    echo "could not replace the existing deployment after retrying; see the error above." >&2
    exit 1
  fi
else
  if ! retry_while_activating gcloud workspace-add-ons deployments create "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE" --format=none; then
    echo "could not create the deployment after retrying; see the error above." >&2
    exit 1
  fi
fi

# 4. Install it for the operator's own account, to test with.
#    https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.deployments/install
gcloud workspace-add-ons deployments install "$DEPLOYMENT_ID" --format=none

# 5. Confirm the install actually took.
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/install-status
#    The REST resource is { name, installed: bool }; `value(installed)`
#    prints just that field.
INSTALL_STATUS_ERR="$WORK_DIR/install-status-error"
if INSTALLED="$(gcloud workspace-add-ons deployments install-status "$DEPLOYMENT_ID" --format='value(installed)' 2>"$INSTALL_STATUS_ERR")"; then
  if [[ "${INSTALLED,,}" == "true" ]]; then
    INSTALL_LINE="✅ installed for your account."
  else
    INSTALL_LINE="❌ install-status reports it is not installed yet; re-run: gcloud workspace-add-ons deployments install-status ${DEPLOYMENT_ID}"
  fi
else
  cat "$INSTALL_STATUS_ERR" >&2
  INSTALL_LINE="❌ could not confirm the install; see the error above."
fi

cat <<EOF

Scripted steps done for project ${PROJECT_ID}. ${INSTALL_LINE}

Four steps have no API and stay manual:

  1. APIs & Services -> Google Workspace Marketplace SDK -> App configuration:
     App integration = "Google Workspace add-on", "Deploy using cloud
     deployment resource" = ${DEPLOYMENT_ID}, App visibility = Private
     (permanent once saved). Also fill in Developer Name, Developer Website
     URL (your BASE_URL, ${BASE_URL}) and Developer Email. Ignore the red
     "The OAuth Consent Screen must be enabled for this project" banner — it
     saves anyway, and the add-on works without one.
     https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com/googleapps_sdk?project=${PROJECT_ID}
  2. Same page, Store listing tab: fill in Language, Application name, Short
     description, Detailed description, Category, Application icons,
     Application card banner, Screenshots, Terms of service, Privacy policy
     and Support, then click Submit. A Private app is published immediately,
     with no Google review — but it is not installable by anyone until this
     step is done.
  3. A super administrator turns this on once per domain: Admin console ->
     Apps -> Google Workspace Marketplace apps -> Settings -> "Allow users to
     install any internal app".
  4. Your people install it themselves from
     https://workspace.google.com/marketplace/mydomainapps.
EOF
