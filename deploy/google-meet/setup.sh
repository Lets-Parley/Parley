#!/usr/bin/env bash
# Registers the Parley Meet add-on in the operator's own Google Cloud
# project. Run from the "Open in Cloud Shell" tutorial (tutorial.md) or by
# hand from a clone of this repository. Idempotent: a re-run replaces the
# existing deployment instead of failing.
#
# What this script cannot do — no API exists for these, so they stay manual
# console steps printed at the end: Marketplace SDK App configuration
# (integration type, deployment pointer, visibility — permanent once saved),
# the OAuth consent screen, and a domain admin's org-wide install.
set -euo pipefail

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
#    there. `create` is GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/create
#    `describe` and `replace` are also GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/describe
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/replace
if gcloud workspace-add-ons deployments describe "$DEPLOYMENT_ID" >/dev/null 2>&1; then
  gcloud workspace-add-ons deployments replace "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE"
else
  gcloud workspace-add-ons deployments create "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE"
fi

# 4. Install it for the operator's own account, to test with.
#    https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.deployments/install
gcloud workspace-add-ons deployments install "$DEPLOYMENT_ID"

cat <<EOF

Scripted steps done for project ${PROJECT_ID}. Four steps have no API and stay
manual, in the Cloud console:

  1. APIs & Services -> Google Workspace Marketplace SDK -> App configuration:
     App integration = "Google Workspace add-on", "Deploy using cloud
     deployment resource" = ${DEPLOYMENT_ID}, App visibility = Private
     (permanent once saved).
     https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com/googleapps_sdk?project=${PROJECT_ID}
  2. The OAuth consent screen, on the same project.
  3. HTTP deployments -> ${DEPLOYMENT_ID} -> Install, if you want a fresh
     account-level install beyond what step 4 above already did.
  4. To give it to your whole Workspace domain: a super administrator installs
     it from the Google Admin console's Marketplace apps list.
EOF
